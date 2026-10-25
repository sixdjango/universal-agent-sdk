import { createWorkflowBuilder, validateWorkflowDefinition } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  type AgentExecutionRequest,
  createWorkflowRuntime,
  DeterministicClock,
  InMemoryWorkspaceManager,
  type IsolatedWorkspace,
  type ScriptExecutionRequest,
  SequentialIdGenerator,
  WorkspaceMergeConflictError,
  foldRunLog,
} from '../src/index';

/** web(app) -> loop[fix(inherits backend)] and a script in app/packages/ui. */
function twoRepoFlow() {
  return createWorkflowBuilder('two-repos')
    .addWorkspace({ name: 'app', description: 'Frontend' })
    .addWorkspace({ name: 'backend' })
    .addWorkspace({ name: 'docs', required: false })
    .addAgent({ id: 'web', name: 'Web', role: 'author', goal: 'Build UI', writeScopes: ['src'], readWorkspaces: ['backend', 'docs'] })
    .addLoop({
      id: 'fix',
      name: 'Fix',
      workspace: 'backend',
      maxRounds: 1,
      continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'api' },
      body: (b) => b.addAgent({ id: 'api', name: 'API', role: 'author', goal: 'Build API', writeScopes: ['src'] }),
    })
    .addScript({ id: 'test', name: 'Test', command: 'true', cwd: 'packages/ui', producesAssessment: false })
    .connectControl('web', 'fix')
    .connectControl('fix', 'test')
    .buildDefinition();
}

function recordingRuntime() {
  const agents: AgentExecutionRequest[] = [];
  const scripts: ScriptExecutionRequest[] = [];
  const runtime = createWorkflowRuntime({
    clock: new DeterministicClock(),
    idGenerator: new SequentialIdGenerator(),
    executor: {
      async executeAgent(req) {
        agents.push(req);
        return { status: 'COMPLETED' };
      },
      async executeScript(req) {
        scripts.push(req);
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
      },
    },
  });
  return { runtime, agents, scripts };
}

describe('workspace slots', () => {
  it('resolves each node to its own slot, inheriting from containers and the default', () => {
    const result = validateWorkflowDefinition(twoRepoFlow());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const root = result.plan.rootScope;
    expect(root.workspaceSlots).toEqual({ web: 'app', fix: 'backend', test: 'app' });
    expect(root.childScopes.fix!.workspaceSlots).toEqual({ api: 'backend' });
  });

  it('rejects slots the workflow does not declare', () => {
    const bad = createWorkflowBuilder('bad')
      .addWorkspace({ name: 'app' })
      .addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x', workspace: 'ap' })
      .addAgent({ id: 'b', name: 'B', role: 'author', goal: 'x', readWorkspaces: ['nope'] })
      .buildDefinition();
    const result = validateWorkflowDefinition(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => [i.code, i.nodeId])).toEqual([
      ['UNKNOWN_WORKSPACE_SLOT', 'a'],
      ['UNKNOWN_WORKSPACE_SLOT', 'b'],
    ]);
    const implicit = createWorkflowBuilder('implicit').addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x', workspace: 'main' });
    expect(validateWorkflowDefinition(implicit.buildDefinition()).ok).toBe(true);
  });

  it('only treats write scopes as conflicting inside the same slot', () => {
    const plan = createWorkflowBuilder('scopes')
      .addWorkspace({ name: 'app' })
      .addWorkspace({ name: 'backend' })
      .addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x', writeScopes: ['src'] })
      .addAgent({ id: 'b', name: 'B', role: 'author', goal: 'x', writeScopes: ['src'], workspace: 'backend' })
      .addAgent({ id: 'c', name: 'C', role: 'author', goal: 'x', writeScopes: ['src/ui'] })
      .compile();
    expect(plan.rootScope.writeScopeConflicts).toEqual({ a: ['c'], b: [], c: ['a'] });
  });

  it('refuses to start without every required slot, or with unknown ones', async () => {
    const { runtime } = recordingRuntime();
    await expect(runtime.start({ definition: twoRepoFlow(), workspaces: { app: '/w/app' } })).rejects.toThrow(
      'needs a workspace for slot "backend"'
    );
    await expect(
      runtime.start({ definition: twoRepoFlow(), workspaces: { app: '/w/app', backend: '/w/api', web: '/x' } })
    ).rejects.toThrow('has no workspace slot "web"');
  });

  it('hands each attempt its bound directory and tells the agent where it works', async () => {
    const { runtime, agents, scripts } = recordingRuntime();
    const started = await runtime.start({
      definition: twoRepoFlow(),
      workspaces: { app: '/w/app', backend: { path: '/w/api', name: 'API', workspaceId: 'ws_api' } },
    });
    expect(started.workspaces).toEqual({
      app: { slot: 'app', path: '/w/app' },
      backend: { slot: 'backend', path: '/w/api', name: 'API', workspaceId: 'ws_api' },
    });
    const done = await runtime.runUntilSettled(started.runId);
    expect(done.status).toBe('SUCCEEDED');

    const web = agents.find((a) => a.node.id === 'web')!;
    expect(web.workspace?.path).toBe('/w/app');
    // `docs` is optional and unbound, so only backend is offered for reading.
    expect(web.readWorkspaces?.map((w) => w.path)).toEqual(['/w/api']);
    expect(web.manifest.workspace).toEqual({
      slot: 'app',
      path: '/w/app',
      writeScopes: ['src'],
      readOnly: [{ slot: 'backend', path: '/w/api' }],
    });
    expect(web.renderedPrompt).toContain('## Workspace\nYou work in `/w/app` (workspace slot "app").');
    expect(web.renderedPrompt).toContain('Only modify files under: `src`.');
    expect(web.renderedPrompt).toContain('- backend: `/w/api`');

    expect(agents.find((a) => a.node.id === 'api')!.workspace?.path).toBe('/w/api');
    expect(scripts[0]!.workspace?.path).toBe('/w/app');
  });

  it('replays the recorded definition and workspace bindings without changing them', async () => {
    const { runtime } = recordingRuntime();
    const current = await runtime.start({ definition: twoRepoFlow(), workspaces: { app: '/a', backend: '/b' } });
    const folded = foldRunLog(await runtime.store.readLog(current.runId));
    expect(folded).toEqual(current);
    expect(folded?.workspaces).toEqual({
      app: { slot: 'app', path: '/a' },
      backend: { slot: 'backend', path: '/b' },
    });
    const web = folded!.definition.graph.nodes.find((node) => node.id === 'web')!;
    expect(web.kind === 'agent' && web.readWorkspaces).toEqual(['backend', 'docs']);
  });

  describe('when an isolated step\'s changes do not merge', () => {
    /** Copies whose merges fail with `clashes`, in order, then succeed. */
    function clashingRuntime(clashes: WorkspaceMergeConflictError[]) {
      const agents: AgentExecutionRequest[] = [];
      const isolated: unknown[] = [];
      const workspaces = new InMemoryWorkspaceManager();
      Object.assign(workspaces, {
        async isolate(input: unknown): Promise<IsolatedWorkspace> {
          isolated.push(input);
          const empty = { diff: '', files: [] };
          return {
            path: '/copy',
            changes: async () => empty,
            integrate: async () => {
              const clash = clashes.shift();
              if (clash) throw clash;
              return empty;
            },
            discard: async () => undefined,
          };
        },
      });
      const runtime = createWorkflowRuntime({
        clock: new DeterministicClock(),
        idGenerator: new SequentialIdGenerator(),
        workspaces,
        executor: {
          async executeAgent(req) {
            agents.push(req);
            return { status: 'COMPLETED' };
          },
          async executeScript() {
            return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
          },
        },
      });
      const definition = createWorkflowBuilder('clash')
        .addWorkspace({ name: 'app', mergeCheck: { command: 'pnpm', args: ['typecheck'] } })
        .addAgent({ id: 'web', name: 'Web', role: 'author', goal: 'Build UI', writeScopes: ['src'], isolation: 'worktree' })
        .buildDefinition();
      const settle = async () =>
        runtime.runUntilSettled((await runtime.start({ definition, workspaces: { app: '/w/app' } })).runId);
      return { agents, isolated, settle };
    }

    it('does the step again in a fresh copy, telling the agent what broke and where its changes are', async () => {
      const check = { command: 'pnpm typecheck', output: "src/a.ts: Cannot find name 'foo'" };
      const { agents, isolated, settle } = clashingRuntime([new WorkspaceMergeConflictError([], 'ua/run/web', check)]);
      const done = await settle();
      expect(done.status).toBe('SUCCEEDED');
      expect(isolated).toHaveLength(2);
      expect(isolated[0]).toMatchObject({ mergeCheck: { command: 'pnpm', args: ['typecheck'] } });
      expect(agents).toHaveLength(2);
      expect(agents[0]!.renderedPrompt).not.toContain('Your Earlier Changes');
      const again = agents[1]!.renderedPrompt;
      expect(again).toContain('## Your Earlier Changes Broke Together With Others');
      expect(again).toContain('`pnpm typecheck` failed');
      expect(again).toContain("Cannot find name 'foo'");
      expect(again).toContain('`git show ua/run/web`');
    });

    it('fails the step when it clashes again', async () => {
      const { agents, settle } = clashingRuntime([
        new WorkspaceMergeConflictError(['src/a.ts'], 'ua/run/web'),
        new WorkspaceMergeConflictError(['src/b.ts'], 'ua/run/web'),
      ]);
      const done = await settle();
      expect(done.status).toBe('FAILED');
      expect(agents).toHaveLength(2);
      expect(agents[1]!.renderedPrompt).toContain('other steps changed src/a.ts');
      expect(done.scopes.$root!.nodes.web!.error).toContain('src/b.ts changed meanwhile');
    });
  });
});
