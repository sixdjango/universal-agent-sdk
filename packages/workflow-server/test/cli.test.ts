import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentRegistry } from '@universal-agent/workflow-agents';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  openWorkflowDatabase,
  resolveWorkflowStoragePaths,
  SqliteArtifactStore,
  SqliteRuntimeStore,
  type WorkflowDatabase,
} from '@universal-agent/workflow-node';
import { type AgentExecutionRequest, type AgentExecutionResult, createWorkflowRuntime } from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOpenApiDocument, createWorkflowServer, openApiPath, runCommand, WorkflowClient, type WorkflowServer } from '../src/index';

async function agent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
  if (req.node.id === 'broken') throw new Error('the build broke');
  if (req.node.id === 'review') {
    return { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'Looks right', findings: [{ id: 'r1', severity: 'minor', message: 'The title could be shorter', filePath: 'essay.md' }] } };
  }
  return { status: 'COMPLETED', outputs: { draft: `draft of ${String(req.inputs.topic)}` } };
}

describe('CLI and OpenAPI', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function serve(): Promise<{ server: WorkflowServer; url: string; workdir: string }> {
    const home = mkdtempSync(join(tmpdir(), 'ua-wf-cli-'));
    const paths = resolveWorkflowStoragePaths(home);
    const db: WorkflowDatabase = openWorkflowDatabase(paths.databasePath);
    const registry = new SqliteAgentRegistry({ db });
    const runtime = createWorkflowRuntime({
      store: new SqliteRuntimeStore({ db }),
      artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
      agentRegistry: registry,
      executor: { executeAgent: agent, async executeScript() { throw new Error('unused'); } },
    });
    const workdir = join(home, 'project');
    mkdirSync(workdir);
    const server = await createWorkflowServer({ runtime, db, registry, streamPollMs: 20, workdir, worktreesDir: join(home, 'worktrees'), resumeInterruptedRuns: false });
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    const address = server.app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => db.$client.close(), () => server.app.close());
    return { server, url, workdir };
  }

  /** Runs a CLI command against `url`, capturing what it prints. */
  async function cli(url: string, ...argv: string[]) {
    let out = '';
    let err = '';
    const code = await runCommand(argv[0]!, [...argv.slice(1), '--server', url], { out: (t) => (out += t), err: (t) => (err += t), env: {} });
    return { code, out, err };
  }

  const flow = (id: string, build = 'draft') =>
    createWorkflowBuilder(id, `Flow ${id}`)
      .addWorkflowInput({ name: 'topic', type: 'string', required: true })
      .addAgent({ id: build, name: 'Draft', role: 'writer', goal: 'Draft', inputs: [{ name: 'topic', type: 'string', required: true }], outputs: [{ name: 'draft', type: 'string', required: true }] })
      .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Review', producesAssessment: true, inputs: [{ name: 'draft', type: 'string', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: build, toPort: 'topic' })
      .connectData({ fromNodeId: build, fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
      .buildDefinition();

  it('documents every route the server serves, and every reference in the document resolves', async () => {
    const { server } = await serve();
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
    const served = server.routes.filter((r) => r.url.startsWith('/api/')).map((r) => `${r.method.toLowerCase()} ${openApiPath(r.url)}`);
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method} ${path}`));
    expect(served.filter((route) => !documented.includes(route))).toEqual([]);
    expect(documented.filter((route) => !served.includes(route))).toEqual([]);
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.filter((name) => !(name in doc.components.schemas))).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain('$defs');
  });

  it('serves the document at /api/openapi.json, pointing at the server it came from', async () => {
    const { url } = await serve();
    const doc = await new WorkflowClient(url).openApi();
    expect(doc).toMatchObject({ openapi: '3.1.0', servers: [{ url }] });
  });

  it('starts a run with inputs and a workspace directory, follows it to the end and exits with its outcome', async () => {
    const { url, workdir } = await serve();
    const client = new WorkflowClient(url);
    await client.saveWorkflow(flow('essay'));
    expect((await cli(url, 'workflows')).out).toContain('essay');

    const watched = await cli(url, 'run', 'essay', '--input', 'topic=tides', '--workspace', `main=${workdir}`, '--watch');
    expect(watched.err).toBe('');
    expect(watched.code).toBe(0);
    expect(watched.out).toMatch(/✓ draft succeeded/);
    expect(watched.out).toMatch(/✓ review succeeded · PASS/);
    expect(watched.out).toMatch(/run succeeded/);
    const runId = /^run (\S+)/.exec(watched.out)![1]!;
    expect((await client.listWorkspaces()).some((w) => w.path === workdir)).toBe(true);

    const status = await cli(url, 'status', runId, '--json');
    expect(JSON.parse(status.out)).toMatchObject({ runId, status: 'SUCCEEDED' });
    const logs = await cli(url, 'logs', runId, '--no-follow', '--json');
    const events = logs.out.trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(events.map((e) => e.type)).toContain('run.finished');
    expect((await cli(url, 'runs', '--workflow', 'essay')).out).toContain(runId);
    // A PASS that leaves a minor point open: listed for the hand-over.
    expect((await cli(url, 'findings', runId)).out).toMatch(/minor\s+review \(PASS\)\s+The title could be shorter\s+essay\.md/);
    expect(JSON.parse((await cli(url, 'findings', runId, '--json')).out)).toMatchObject([{ source: 'assessment', nodeId: 'review', severity: 'minor' }]);
    // Cancelling a finished run leaves it as it is.
    expect((await cli(url, 'cancel', runId)).out).toContain('SUCCEEDED');
  });

  it('exits 1 for a failed run, 3 for one waiting on an answer, and cancels a waiting run', async () => {
    const { url } = await serve();
    const client = new WorkflowClient(url);
    await client.saveWorkflow(flow('broken', 'broken'));
    const failed = await cli(url, 'run', 'broken', '--input', 'topic=x', '--watch');
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/✗ broken failed/);

    await client.saveWorkflow(
      createWorkflowBuilder('approve', 'Approve').addGate({ id: 'ok', name: 'Approve', prompt: 'Ship it?' }).buildDefinition()
    );
    const waiting = await cli(url, 'run', 'approve', '--watch');
    expect(waiting.code).toBe(3);
    expect(waiting.out).toMatch(/waiting: Ship it\?/);
    const runId = /^run (\S+)/.exec(waiting.out)![1]!;
    expect((await cli(url, 'cancel', runId)).out).toContain('CANCELLED');
    expect((await client.getRun(runId)).run.status).toBe('CANCELLED');
  });

  it('explains bad usage and an unreachable server without throwing', async () => {
    const usage = await cli('http://127.0.0.1:9', 'run');
    expect(usage.code).toBe(64);
    expect(usage.err).toContain('run needs a workflow id');
    const down = await cli('http://127.0.0.1:9', 'workflows');
    expect(down.code).toBe(69);
    expect(down.err).toContain('Cannot reach the workflow server');
  });
});
