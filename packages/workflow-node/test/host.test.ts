import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, type WorkflowRunState } from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openWorkflowDatabase,
  resolveWorkflowStoragePaths,
  SqliteArtifactStore,
  SqliteRuntimeStore,
  type WorkflowDatabase,
  WorkflowHost,
  WorkflowHostError,
} from '../src/index';

describe('WorkflowHost (no transport)', () => {
  const cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function open() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ua-host-')));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const paths = resolveWorkflowStoragePaths(home);
    const db: WorkflowDatabase = openWorkflowDatabase(paths.databasePath);
    cleanup.push(() => db.$client.close());
    const ran: Record<string, string | undefined> = {};
    const runtime = createWorkflowRuntime({
      store: new SqliteRuntimeStore({ db }),
      artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
      executor: {
        async executeAgent(req) {
          ran[req.node.id] = req.workspace?.path;
          return { status: 'COMPLETED' };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const workdir = join(home, 'project');
    mkdirSync(workdir);
    const host = await WorkflowHost.open({ runtime, db, workdir, worktreesDir: paths.worktreesDir, logger: { error() {} } });
    cleanup.push(() => host.close());
    const settled = async (runId: string): Promise<WorkflowRunState> => {
      for (let i = 0; i < 200; i++) {
        const run = await host.runs.get(runId);
        if (run.status !== 'RUNNING' && !host.runs.isActive(runId)) return run;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('run never settled');
    };
    return { host, home, workdir, ran, settled, worktreesDir: paths.worktreesDir };
  }

  const reject = async (promise: Promise<unknown> | (() => unknown), code: string) => {
    const err = await (typeof promise === 'function' ? Promise.resolve().then(promise) : promise).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowHostError);
    expect((err as WorkflowHostError).code).toBe(code);
    return err as WorkflowHostError;
  };

  it('saves workflows, rejects invalid ones, and runs slot-less workflows in the default workspace', async () => {
    const { host, workdir, ran, settled } = await open();
    expect(host.defaultWorkspace).toMatchObject({ path: workdir, name: 'project', isolation: 'in-place' });

    const bad = await reject(() => host.library.save({ id: 'x', name: 'x', graph: { nodes: [] } }, { mode: 'create' }), 'invalid');
    expect((bad.details?.issues as { code: string }[])[0]!.code).toBe('EMPTY_GRAPH');
    await reject(host.startRun({ workflowId: 'nope' }), 'not_found');

    host.library.save(createWorkflowBuilder('solo').addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x' }).buildDefinition(), { mode: 'create' });
    const run = await settled((await host.startRun({ workflowId: 'solo' })).runId);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.workspaces.main).toMatchObject({ path: workdir, workspaceId: host.defaultWorkspace.id });
    expect(ran.a).toBe(workdir);
    await reject(() => host.removeWorkspace(host.defaultWorkspace.id), 'invalid');
  });

  it('binds slots, creates a worktree per run for git workspaces, and remembers the choice', async () => {
    const { host, home, ran, settled, worktreesDir } = await open();
    const web = join(home, 'web');
    const api = join(home, 'api');
    mkdirSync(web);
    mkdirSync(api);
    execFileSync('git', ['init', '-q', '-b', 'main', api]);
    execFileSync('git', ['-C', api, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);

    await reject(host.workspaces.create({ path: web, isolation: 'git-worktree' }), 'invalid');
    const webWs = await host.workspaces.create({ path: web });
    const apiWs = await host.workspaces.create({ path: api, isolation: 'git-worktree' });
    await reject(host.workspaces.create({ path: web }), 'conflict');

    host.library.save(
      createWorkflowBuilder('two')
        .addWorkspace({ name: 'app' })
        .addWorkspace({ name: 'backend' })
        .addAgent({ id: 'ui', name: 'UI', role: 'author', goal: 'x' })
        .addAgent({ id: 'server', name: 'Server', role: 'author', goal: 'x', workspace: 'backend' })
        .buildDefinition(),
      { mode: 'create' }
    );
    const missing = await reject(host.startRun({ workflowId: 'two', workspaces: { app: webWs.id } }), 'invalid');
    expect(missing.details?.missingSlots).toEqual(['backend']);

    const run = await settled((await host.startRun({ workflowId: 'two', workspaces: { app: webWs.id, backend: apiWs.id } })).runId);
    const backend = run.workspaces.backend!;
    expect(backend).toMatchObject({ isolation: 'git-worktree', branch: `ua/${run.runId.slice(-8)}/backend` });
    expect(backend.path.startsWith(worktreesDir)).toBe(true);
    expect(ran).toEqual({ ui: web, server: backend.path });

    expect(host.library.get('two')!.workspaceBindings).toEqual({ app: webWs.id, backend: apiWs.id });
    const again = await settled((await host.startRun({ workflowId: 'two' })).runId);
    expect(again.workspaces.app!.path).toBe(web);
    expect(again.workspaces.backend!.path).not.toBe(backend.path);
  });
  it('embeds the workflows sub-flow steps run when a run starts', async () => {
    const { host, ran, settled } = await open();
    host.library.save(
      createWorkflowBuilder('child')
        .addWorkflowInput({ name: 'topic', type: 'string', required: true })
        .addAgent({ id: 'inner', name: 'Inner', role: 'author', goal: 'x', inputs: [{ name: 'topic', type: 'string', required: true }] })
        .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'inner', toPort: 'topic' })
        .buildDefinition(),
      { mode: 'create' }
    );
    const parent = createWorkflowBuilder('parent')
      .addWorkflowInput({ name: 'topic', type: 'string', required: true })
      .addSubflow({ id: 'sub', name: 'Sub', workflowId: 'child', inputs: [{ name: 'topic', type: 'string', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'sub', toPort: 'topic' })
      .buildDefinition();
    host.library.save(parent, { mode: 'create' });

    const run = await settled((await host.startRun({ workflowId: 'parent', inputs: { topic: 'x' } })).runId);
    expect(run.status).toBe('SUCCEEDED');
    expect(ran).toHaveProperty('inner');
    expect(Object.keys(run.scopes)).toContain('$root/sub:round_0');

    host.library.save({ ...parent, id: 'broken', graph: { ...parent.graph, nodes: parent.graph.nodes.map((n) => ({ ...n, workflowId: 'gone' })) } }, { mode: 'create' });
    const err = await reject(host.startRun({ workflowId: 'broken', inputs: { topic: 'x' } }), 'invalid');
    expect(err.message).toMatch(/does not exist/);
  });
});
