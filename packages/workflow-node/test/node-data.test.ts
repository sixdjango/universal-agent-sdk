import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createNodeDataAccess, NodeDataError } from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactToolHost,
  createNodeWorkflowRuntime,
  openWorkflowDatabase,
  SqliteNodeDataStore,
} from '../src/index';

describe('step data', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  it('keeps each step (and loop round) to its own records, with shared run data on the side', async () => {
    const db = openWorkflowDatabase(join(temp('ua-nd-'), 'workflow.db'));
    const store = new SqliteNodeDataStore({ db });
    const round = (n: number) => createNodeDataAccess(store, { runId: 'r', scopeKey: `$root/loop:round_${n}`, nodeId: 'draft', attemptId: `a${n}` });
    const review = createNodeDataAccess(store, { runId: 'r', scopeKey: '$root/loop:round_1', nodeId: 'review', attemptId: 'b1' });

    await round(0).put('progress', 'pct', 40);
    const replaced = await round(0).put('progress', 'pct', 100);
    await round(1).put('progress', 'pct', 10);
    expect((await round(0).get('progress', 'pct'))!.value).toBe(100);
    expect((await round(1).get('progress', 'pct'))!.value).toBe(10);
    expect(replaced.createdAtMs).toBeLessThanOrEqual(replaced.updatedAtMs);

    const first = await round(1).append('log', 'started');
    await round(1).append('log', { step: 2 });
    expect((await round(1).list({ collection: 'log' })).map((r) => [r.key, r.value])).toEqual([
      [String(first.id), 'started'],
      [expect.any(String), { step: 2 }],
    ]);

    // Another step reads draft's data: the instance in its own round first, else the latest.
    expect((await review.get('progress', 'pct', { nodeId: 'draft' }))!.value).toBe(10);
    expect((await review.list({ nodeId: 'draft', collection: 'progress' })).length).toBe(2);
    // It has none of its own, and cannot write draft's (the API has no way to).
    expect(await review.get('progress', 'pct')).toBeNull();

    await review.put('notes', 'tone', 'formal', { shared: true });
    expect((await round(0).get('notes', 'tone', { shared: true }))!.value).toBe('formal');
    expect(await round(0).get('notes', 'tone')).toBeNull();

    await expect(round(0).put('bad name!', 'k', 1)).rejects.toBeInstanceOf(NodeDataError);
    await expect(round(0).put('big', 'k', 'x'.repeat(1024 * 1024 + 10))).rejects.toThrow('at most');
    db.$client.close();
  });

  it('lets scripts save and read step data with the ua-workflow CLI', async () => {
    const workdir = temp('ua-nd-work-');
    const home = temp('ua-nd-home-');
    const runtime = createNodeWorkflowRuntime({ workdir, homeDir: home });
    const sh = (script: string) => ({ command: 'sh', args: ['-c', script], producesAssessment: false });
    const definition = createWorkflowBuilder('data-flow')
      .addScript({
        id: 'collect',
        name: 'Collect',
        ...sh(
          `ua-workflow data put stats count 3 >/dev/null && ` +
            `echo '{"user":"ada"}' | ua-workflow data append events - >/dev/null && ` +
            `ua-workflow data put config mode fast --shared >/dev/null`
        ),
      })
      .addScript({
        id: 'report',
        name: 'Report',
        ...sh(
          `count=$(ua-workflow data get stats count --node collect) && ` +
            `mode=$(ua-workflow data get config mode --shared) && ` +
            `events=$(ua-workflow data list --node collect --collection events) && ` +
            `ua-workflow data put summary text "count=$count mode=$mode events=$(echo "$events" | grep -c ada)" >/dev/null && ` +
            `ua-workflow data get stats count; echo "missing:$?"`
        ),
      })
      .connectControl('collect', 'report')
      .buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('SUCCEEDED');
    const report = done.scopes.$root!.nodes.report!.outputs.testReport!.value as { stdout: string; stderr: string };
    expect(report.stdout).toContain('missing:1');

    const records = await runtime.nodeData.query({ runId: done.runId });
    const value = (nodeId: string, collection: string) => records.find((r) => r.nodeId === nodeId && r.collection === collection)?.value;
    expect(value('collect', 'stats')).toBe(3);
    expect(value('collect', 'events')).toEqual({ user: 'ada' });
    expect(records.find((r) => r.namespace === 'run')).toMatchObject({ collection: 'config', key: 'mode', value: 'fast', nodeId: 'collect' });
    expect(value('report', 'summary')).toBe('count=3 mode=fast events=1');
  });

  it('serves the data tools over MCP, scoped to the registered step', async () => {
    const db = openWorkflowDatabase(join(temp('ua-nd-mcp-'), 'workflow.db'));
    const store = new SqliteNodeDataStore({ db });
    const host = new ArtifactToolHost();
    const { token, release } = host.register({ data: createNodeDataAccess(store, { runId: 'r', scopeKey: '$root', nodeId: 'agent', attemptId: 'a' }) });
    const [server] = await host.mcpServers(token, { http: true });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL((server as { url: string }).url)));

    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['data_append', 'data_get', 'data_list', 'data_put', 'list_context_inputs', 'list_findings', 'log_issue', 'read_artifact']);
    const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
    await client.callTool({ name: 'data_put', arguments: { collection: 'draft', key: 'outline', value: ['intro', 'body'] } });
    const got = JSON.parse(textOf(await client.callTool({ name: 'data_get', arguments: { collection: 'draft', key: 'outline' } })));
    expect(got).toMatchObject({ nodeId: 'agent', value: ['intro', 'body'] });
    // No manifest was registered, so artifact tools say so instead of failing oddly.
    const inputs = await client.callTool({ name: 'list_context_inputs', arguments: {} });
    expect(inputs.isError).toBe(true);
    await client.close();
    release();
    await host.close();
    db.$client.close();
  });

  it('gives agents the CLI in their shell environment too', async () => {
    const workdir = temp('ua-nd-agent-');
    const home = temp('ua-nd-agent-home-');
    const agent = join(workdir, 'shell-agent.mjs');
    writeFileSync(
      agent,
      `
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, agentCapabilities: {} } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', configOptions: [] } });
  else if (msg.method === 'session/prompt') {
    // What an agent's shell tool would run.
    execFileSync('ua-workflow', ['data', 'put', 'notes', 'plan', '{"steps":3}']);
    execFileSync('ua-workflow', ['issue', 'Card radius is 16px, the design has 14px', '--severity', 'major', '--file', 'app/styles.css']);
    const open = JSON.parse(execFileSync('ua-workflow', ['findings'], { encoding: 'utf8' }));
    execFileSync('ua-workflow', ['data', 'put', 'notes', 'seen', JSON.stringify(open.map((f) => f.message))]);
    const text = '\\u0060\\u0060\\u0060ua-workflow-result\\n{}\\n\\u0060\\u0060\\u0060';
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.method === 'session/close') send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`
    );
    const runtime = createNodeWorkflowRuntime({
      workdir,
      homeDir: home,
      roleBindings: { planner: { target: { cliType: 'custom', agentType: 'mock-shell', command: process.execPath, args: [agent] } } },
    });
    const definition = createWorkflowBuilder('agent-data').addAgent({ id: 'plan', name: 'Plan', role: 'planner', goal: 'Plan' }).buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('SUCCEEDED');
    const notes = await runtime.nodeData.query({ runId: done.runId, nodeId: 'plan', collection: 'notes' });
    expect(notes.find((r) => r.key === 'plan')).toMatchObject({ value: { steps: 3 } });
    // The issue it logged is handed over, and the step could already see it.
    expect(notes.find((r) => r.key === 'seen')?.value).toEqual(['Card radius is 16px, the design has 14px']);
    expect(await runtime.getOpenFindings(done.runId)).toMatchObject([
      { source: 'issue', nodeId: 'plan', severity: 'major', message: 'Card radius is 16px, the design has 14px', filePath: 'app/styles.css' },
    ]);
  }, 30_000);
});
