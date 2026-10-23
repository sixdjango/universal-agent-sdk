import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentRegistry } from '@universal-agent/workflow-agents';
import {
  openWorkflowDatabase,
  resolveWorkflowStoragePaths,
  SqliteArtifactStore,
  SqliteRuntimeStore,
  type WorkflowDatabase,
} from '@universal-agent/workflow-node';
import {
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type ChiefSupervisor,
  createWorkflowRuntime,
  type RunLogEntry,
  type WorkflowRunState,
} from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  createSampleWorkflow,
  createWorkflowServer,
  SAMPLE_AGENTS,
  type WorkflowServer,
} from '../src/index';

const LOCAL = { host: '127.0.0.1:4317' };

async function mockAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
  switch (req.node.id) {
    case 'build':
      return { status: 'COMPLETED', artifacts: { change: { content: `# Change\n${String(req.inputs.request)}` } } };
    case 'review':
      return { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'Looks right' } };
    case 'notes':
      return { status: 'COMPLETED', artifacts: { notes: { content: '# Notes\nShipped' } } };
    default:
      return { status: 'COMPLETED' };
  }
}

describe('@universal-agent/workflow-server', () => {
  const homes: string[] = [];
  const servers: WorkflowServer[] = [];
  const dbs: WorkflowDatabase[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.app.close();
    for (const db of dbs.splice(0)) db.$client.close();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  async function setup(
    options: {
      executeAgent?: typeof mockAgent;
      before?: (rt: ReturnType<typeof createWorkflowRuntime>, registry: SqliteAgentRegistry) => Promise<void>;
      chief?: ChiefSupervisor;
    } = {}
  ) {
    const home = mkdtempSync(join(tmpdir(), 'ua-wf-server-'));
    homes.push(home);
    const paths = resolveWorkflowStoragePaths(home);
    const db = openWorkflowDatabase(paths.databasePath);
    dbs.push(db);
    const registry = new SqliteAgentRegistry({ db });
    const runtime = createWorkflowRuntime({
      store: new SqliteRuntimeStore({ db }),
      artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
      agentRegistry: registry,
      ...(options.chief ? { chief: options.chief } : {}),
      executor: {
        executeAgent: options.executeAgent ?? mockAgent,
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    await options.before?.(runtime, registry);
    const runtimeCatalog = {
      async list() {
        return [{ agentType: 'claude', installed: true, source: 'static' as const, models: [{ id: 'sonnet' }], efforts: ['low', 'high'] }];
      },
      async refresh(agentType: string): Promise<never> {
        throw new Error(`Agent client "${agentType}" is not installed`);
      },
    };
    const workdir = join(home, 'project');
    mkdirSync(workdir);
    const server = await createWorkflowServer({
      runtime,
      db,
      registry,
      runtimeCatalog,
      streamPollMs: 20,
      workdir,
      worktreesDir: join(home, 'worktrees'),
    });
    servers.push(server);
    return { server, app: server.app, runtime, registry, home, workdir };
  }

  async function waitForRun(
    app: WorkflowServer['app'],
    runId: string,
    predicate: (run: WorkflowRunState, active: boolean) => boolean
  ): Promise<WorkflowRunState> {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: LOCAL });
      const body = res.json() as { run: WorkflowRunState; active: boolean };
      if (predicate(body.run, body.active)) return body.run;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Run ${runId} never reached the expected state`);
  }

  it('seeds the sample workflow and agents', async () => {
    const { app } = await setup();
    const seeded = await app.inject({ method: 'POST', url: '/api/samples', headers: LOCAL });
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json().id).toBe('feature-with-review');

    const list = (await app.inject({ method: 'GET', url: '/api/workflows', headers: LOCAL })).json();
    expect(list.workflows.map((w: { id: string }) => w.id)).toEqual(['feature-with-review']);

    const agents = (await app.inject({ method: 'GET', url: '/api/agents', headers: LOCAL })).json();
    expect(agents.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['builder', 'critic']);
    expect(agents.agents[0].profile.charter).toContain('feature request');
  });

  it('rejects invalid definitions with compiler issues and keeps versions on update', async () => {
    const { app } = await setup();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: LOCAL,
      payload: { definition: { id: 'x', name: 'x', graph: { nodes: [] } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.issues[0].code).toBe('EMPTY_GRAPH');

    const sample = createSampleWorkflow();
    expect((await app.inject({ method: 'POST', url: '/api/workflows', headers: LOCAL, payload: { definition: sample } })).statusCode).toBe(201);
    const duplicate = await app.inject({ method: 'POST', url: '/api/workflows', headers: LOCAL, payload: { definition: sample } });
    expect(duplicate.statusCode).toBe(409);

    const renamed = { ...sample, name: 'Renamed' };
    const updated = await app.inject({ method: 'PUT', url: `/api/workflows/${sample.id}`, headers: LOCAL, payload: { definition: renamed } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().versions).toHaveLength(2);

    const layout = await app.inject({ method: 'PUT', url: `/api/workflows/${sample.id}/layout`, headers: LOCAL, payload: { build: { x: 10, y: 20 } } });
    expect(layout.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/workflows/${sample.id}`, headers: LOCAL })).json().layout).toEqual({ build: { x: 10, y: 20 } });
  });

  it('runs in the background, waits at the gate, and finishes after the answer', async () => {
    const { app } = await setup();
    await app.inject({ method: 'POST', url: '/api/samples', headers: LOCAL });

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: LOCAL,
      payload: { workflowId: 'feature-with-review', inputs: { request: 'Add dark mode' } },
    });
    expect(started.statusCode).toBe(202);
    const { runId } = started.json() as { runId: string };

    const waiting = await waitForRun(app, runId, (run, active) => run.status === 'WAITING' && !active);
    const gateWait = Object.values(waiting.waitRequests).find((w) => w.status === 'PENDING')!;
    expect(gateWait.nodeId).toBe('signoff');
    expect(waiting.attempts[waiting.scopes.$root!.nodes.build!.latestAttemptId!]!.agent?.agentId).toBe('builder');

    const answered = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/respond`,
      headers: LOCAL,
      payload: { requestId: gateWait.requestId, answer: 'ship' },
    });
    expect(answered.statusCode).toBe(202);
    const done = await waitForRun(app, runId, (run, active) => run.status === 'SUCCEEDED' && !active);
    expect(String(done.outputs.notes)).toContain('Shipped');

    const again = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/respond`,
      headers: LOCAL,
      payload: { requestId: gateWait.requestId, answer: 'ship' },
    });
    expect(again.statusCode).toBe(409);

    const runs = (await app.inject({ method: 'GET', url: '/api/runs?workflowId=feature-with-review', headers: LOCAL })).json();
    expect(runs.runs[0]).toMatchObject({ runId, workflowName: 'Feature with review', status: 'SUCCEEDED' });

    const rerun = await app.inject({ method: 'POST', url: `/api/runs/${runId}/rerun`, headers: LOCAL, payload: { nodeId: 'notes' } });
    expect(rerun.statusCode).toBe(202);
    const rerunDone = await waitForRun(app, runId, (run, active) => run.status === 'SUCCEEDED' && !active && run.revision > done.revision);
    expect(Object.values(rerunDone.attempts).filter((a) => a.nodeId === 'notes')).toHaveLength(2);

    const artifactId = rerunDone.scopes.$root!.nodes.notes!.outputs.notes!.artifactId!;
    const artifact = (await app.inject({ method: 'GET', url: `/api/artifacts/${artifactId}`, headers: LOCAL })).json();
    expect(artifact.slice.content).toContain('Shipped');
  });

  it('blocks foreign hosts and cross-origin writes', async () => {
    const { app } = await setup();
    const rebound = await app.inject({ method: 'GET', url: '/api/workflows', headers: { host: 'evil.example:4317' } });
    expect(rebound.statusCode).toBe(403);

    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/samples',
      headers: { ...LOCAL, origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);

    const sameSite = await app.inject({
      method: 'POST',
      url: '/api/samples',
      headers: { ...LOCAL, origin: 'http://127.0.0.1:4317' },
    });
    expect(sameSite.statusCode).toBe(200);
  });

  it('streams the run log over SSE so clients can fold it', async () => {
    const { app } = await setup();
    await app.inject({ method: 'POST', url: '/api/samples', headers: LOCAL });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const { runId } = (
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        headers: LOCAL,
        payload: { workflowId: 'feature-with-review', inputs: { request: 'x' } },
      })
    ).json() as { runId: string };

    const controller = new AbortController();
    const response = await fetch(`${address}/api/runs/${runId}/stream`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const entries: RunLogEntry[] = [];
    while (!entries.some((e) => e.mutation.kind === 'wait_request.put')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.includes('event: log')) {
          entries.push(JSON.parse(block.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    controller.abort();

    expect(entries[0]?.mutation.kind).toBe('run.created');
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
  });

  it('resumes runs left RUNNING by a previous process', async () => {
    let interruptedRunId = '';
    const { app } = await setup({
      before: async (runtime, registry) => {
        for (const agent of SAMPLE_AGENTS) registry.register(agent);
        const started = await runtime.start({ definition: createSampleWorkflow(), inputs: { request: 'resume me' } });
        interruptedRunId = started.runId;
      },
    });
    await app.ready();
    const resumed = await waitForRun(app, interruptedRunId, (run, active) => run.status === 'WAITING' && !active);
    expect(resumed.scopes.$root!.nodes.review!.latestVerdict).toBe('PASS');
  });

  it('lists agent clients with their models and effort levels', async () => {
    const { app } = await setup();
    const listed = (await app.inject({ method: 'GET', url: '/api/runtimes', headers: LOCAL })).json();
    expect(listed.runtimes[0]).toMatchObject({ agentType: 'claude', installed: true, efforts: ['low', 'high'] });
    const refresh = await app.inject({ method: 'POST', url: '/api/runtimes/codex/refresh', headers: LOCAL });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json().error).toContain('not installed');
  });
  it('registers the server directory and runs slot-less workflows there', async () => {
    const seen: (string | undefined)[] = [];
    const { app, workdir } = await setup({
      executeAgent: async (req) => {
        seen.push(req.workspace?.path);
        return mockAgent(req);
      },
    });
    const listed = (await app.inject({ method: 'GET', url: '/api/workspaces', headers: LOCAL })).json();
    expect(listed.workspaces).toHaveLength(1);
    expect(listed.workspaces[0]).toMatchObject({ path: workdir, name: 'project', isolation: 'in-place', exists: true });
    expect(listed.defaultWorkspaceId).toBe(listed.workspaces[0].id);

    await app.inject({ method: 'POST', url: '/api/samples', headers: LOCAL });
    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: LOCAL,
      payload: { workflowId: 'feature-with-review', inputs: { request: 'x' } },
    });
    const run = await waitForRun(app, started.json().runId, (r) => r.status === 'WAITING');
    expect(run.workspaces.main).toMatchObject({ slot: 'main', path: workdir, workspaceId: listed.defaultWorkspaceId });
    expect(seen).toEqual([workdir, workdir]);
  });

  it('maps workspace and binding errors to HTTP statuses', async () => {
    const { app, home } = await setup({ executeAgent: async () => ({ status: 'COMPLETED' }) });
    const web = join(home, 'web');
    mkdirSync(web);
    const create = (payload: object) => app.inject({ method: 'POST', url: '/api/workspaces', headers: LOCAL, payload });
    expect((await create({ path: 'relative/dir' })).statusCode).toBe(400);
    const webWs = await create({ path: web, name: 'Web app' });
    expect(webWs.statusCode).toBe(201);
    expect((await create({ path: web })).statusCode).toBe(409);

    const definition = createWorkflowBuilder('two-slots')
      .addWorkspace({ name: 'app' })
      .addWorkspace({ name: 'backend' })
      .addAgent({ id: 'ui', name: 'UI', role: 'author', goal: 'UI' })
      .buildDefinition();
    await app.inject({ method: 'POST', url: '/api/workflows', headers: LOCAL, payload: { definition } });
    const missing = await app.inject({ method: 'POST', url: '/api/runs', headers: LOCAL, payload: { workflowId: 'two-slots', workspaces: { app: webWs.json().id } } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().details.missingSlots).toEqual(['backend']);
    expect((await app.inject({ method: 'POST', url: '/api/runs', headers: LOCAL, payload: { workflowId: 'ghost' } })).statusCode).toBe(404);

    const { defaultWorkspaceId } = (await app.inject({ method: 'GET', url: '/api/workspaces', headers: LOCAL })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/workspaces/${defaultWorkspaceId}`, headers: LOCAL })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/workspaces/${webWs.json().id}`, headers: LOCAL })).statusCode).toBe(204);
  });
  it('takes messages for the chief and streams its reply into the run log', async () => {
    const { app } = await setup({
      chief: {
        async review(input) {
          return input.trigger.kind === 'user.message'
            ? { rationale: 'asked', reply: `You said: ${input.trigger.detail}`, commands: [] }
            : { rationale: '', commands: [] };
        },
      },
    });
    const withChief = createWorkflowBuilder('chatty').addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x' }).setChief({}).buildDefinition();
    const without = createWorkflowBuilder('quiet').addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x' }).buildDefinition();
    for (const definition of [withChief, without]) {
      await app.inject({ method: 'POST', url: '/api/workflows', headers: LOCAL, payload: { definition } });
    }
    const start = async (workflowId: string) =>
      (await app.inject({ method: 'POST', url: '/api/runs', headers: LOCAL, payload: { workflowId } })).json().runId as string;

    const runId = await start('chatty');
    await waitForRun(app, runId, (r, active) => r.status === 'SUCCEEDED' && !active);
    const sent = await app.inject({ method: 'POST', url: `/api/runs/${runId}/chief/messages`, headers: LOCAL, payload: { text: 'hello' } });
    expect(sent.statusCode).toBe(202);
    const answered = await waitForRun(app, runId, (r) => r.events.some((e) => e.type === 'chief.intervened' && e.reply));
    expect(answered.events.at(-1)).toMatchObject({ type: 'chief.intervened', reply: 'You said: hello', inReplyTo: sent.json().messageId });

    expect((await app.inject({ method: 'POST', url: `/api/runs/${runId}/chief/messages`, headers: LOCAL, payload: { text: '  ' } })).statusCode).toBe(400);
    const quiet = await start('quiet');
    const refused = await app.inject({ method: 'POST', url: `/api/runs/${quiet}/chief/messages`, headers: LOCAL, payload: { text: 'hi' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('has no chief');
  });
});

