import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  createScopedArtifactReader,
  InMemoryArtifactStore,
  SequentialIdGenerator,
  SystemClock,
} from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactToolHost, createNodeWorkflowRuntime } from '../src/index';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkClientDir = join(packageRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client');
const BIG = 200 * 1024;

/**
 * A mock ACP agent. `writer` returns a large artifact; `reader` finds the artifact id in its
 * prompt, connects to the `ua-workflow` MCP server it was given (HTTP or stdio) and reports
 * what `read_artifact` returned.
 */
function writeMockAgent(dir: string): string {
  const path = join(dir, 'mock-mcp-agent.mjs');
  const sdk = (file: string) => pathToFileURL(join(sdkClientDir, file)).href;
  writeFileSync(
    path,
    `
import readline from 'node:readline';
import { Client } from '${sdk('index.js')}';
import { StreamableHTTPClientTransport } from '${sdk('streamableHttp.js')}';
import { StdioClientTransport } from '${sdk('stdio.js')}';

const role = process.env.MOCK_ROLE;
const http = process.env.MOCK_HTTP_MCP === '1';
let mcpServers = [];
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const reply = (msg, text) => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
};
const envelope = (value) => '\`\`\`ua-workflow-result\\n' + JSON.stringify(value) + '\\n\`\`\`';

async function readViaMcp(artifactId) {
  const server = mcpServers.find((s) => s.name === 'ua-workflow');
  if (!server) return { error: 'no ua-workflow server mounted' };
  const transport = server.type === 'http'
    ? new StreamableHTTPClientTransport(new URL(server.url))
    : new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map((e) => [e.name, e.value])) });
  const client = new Client({ name: 'mock-agent', version: '1.0.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const listing = await client.callTool({ name: 'list_context_inputs', arguments: {} });
  const initialQuota = JSON.parse(listing.content[0].text).remainingReadQuotaBytes;
  let offsetBytes = 0;
  let content = '';
  let firstMeta;
  let lastMeta;
  do {
    const page = await client.callTool({ name: 'read_artifact', arguments: { artifactId, offsetBytes, maxBytes: ${BIG} } });
    if (page.isError) {
      await client.close();
      throw new Error(page.content[0].text);
    }
    const text = page.content[0].text;
    const separator = text.lastIndexOf('\\n---\\n');
    const meta = JSON.parse(text.slice(separator + 5));
    content += text.slice(0, separator).replace(/\\n$/, '');
    firstMeta ??= meta;
    lastMeta = meta;
    offsetBytes = meta.nextOffsetBytes;
  } while (lastMeta.hasMore);
  const denied = await client.callTool({ name: 'read_artifact', arguments: { artifactId: 'art_not_mine' } });
  await client.close();
  return {
    transport: server.type === 'http' ? 'http' : 'stdio', tools,
    firstLine: content.split('\\n')[0], meta: firstMeta, lastMeta, initialQuota,
    readAll: content === '# Big report\\n' + 'x'.repeat(${BIG}),
    deniedIsError: denied.isError === true,
  };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, agentCapabilities: { loadSession: true, mcpCapabilities: { http } } } });
  } else if (msg.method === 'session/new') {
    mcpServers = msg.params.mcpServers ?? [];
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-' + role + '-' + Date.now(), configOptions: [] } });
  } else if (msg.method === 'session/prompt') {
    const prompt = (msg.params.prompt ?? []).map((b) => b.text ?? '').join('\\n');
    if (role === 'writer') {
      const content = '# Big report\\n' + 'x'.repeat(${BIG});
      reply(msg, envelope({ artifacts: { report: { content, summary: 'a big report' } } }));
    } else {
      const id = /"artifactId": "([^"]+)"/.exec(prompt)?.[1];
      const result = id ? await readViaMcp(id).catch((err) => ({ error: String(err) })) : { error: 'no artifact id in prompt' };
      reply(msg, envelope({ outputs: { seen: result } }));
    }
  } else if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`
  );
  return path;
}

describe('artifact tools for agents', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it.each([
    ['http', '1'],
    ['stdio', '0'],
  ] as const)('lets a downstream agent read a large upstream artifact over %s MCP', async (transport, httpFlag) => {
    if (transport === 'stdio' && !existsSync(join(packageRoot, 'dist/mcp-bridge.js'))) {
      throw new Error('Build workflow-node first: the stdio bridge runs from dist/mcp-bridge.js');
    }
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'ua-art-work-')));
    const home = mkdtempSync(join(tmpdir(), 'ua-art-home-'));
    dirs.push(workdir, home);
    const agent = writeMockAgent(workdir);
    const target = (role: string) => ({
      target: { cliType: 'custom' as const, agentType: `mock-${role}`, command: process.execPath, args: [agent] },
      env: { MOCK_ROLE: role, MOCK_HTTP_MCP: httpFlag },
    });
    const runtime = createNodeWorkflowRuntime({
      workdir,
      homeDir: home,
      roleBindings: { writer: target('writer'), reader: target('reader') },
    });
    const flow = createWorkflowBuilder('big-handoff')
      .addAgent({ id: 'write', name: 'Write', role: 'writer', goal: 'Write', outputs: [{ name: 'report', type: 'artifact', required: true }] })
      .addAgent({
        id: 'read',
        name: 'Read',
        role: 'reader',
        goal: 'Read',
        inputs: [{ name: 'report', type: 'artifact', required: true }],
        outputs: [{ name: 'seen', type: 'json', required: true }],
      })
      .connectData({ fromNodeId: 'write', fromPort: 'report', toNodeId: 'read', toPort: 'report', withControl: true })
      .buildDefinition();

    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow })).runId);
    expect(done.status).toBe('SUCCEEDED');
    const readNode = done.scopes.$root!.nodes.read!;
    const seen = readNode.outputs.seen!.value as Record<string, unknown>;
    expect(seen).toMatchObject({
      transport,
      tools: expect.arrayContaining(['list_context_inputs', 'read_artifact']),
      firstLine: '# Big report',
      deniedIsError: true,
      meta: { offsetBytes: 0, hasMore: true, readBytes: 8 * 1024, remainingReadQuotaBytes: null },
      lastMeta: { hasMore: false, remainingReadQuotaBytes: null },
      initialQuota: null,
      readAll: true,
    });
    expect((seen.meta as { totalBytes: number }).totalBytes).toBeGreaterThan(BIG);

    // The read went through the attempt's scoped reader, so it is on the record.
    const attemptId = readNode.latestAttemptId!;
    const receipts = done.readReceipts.filter((r) => r.attemptId === attemptId);
    expect(receipts.length).toBeGreaterThan(16);
    expect(receipts.every((receipt) => receipt.readBytes > 0 && receipt.readBytes <= 8 * 1024)).toBe(true);
    expect(receipts.reduce((total, receipt) => total + receipt.readBytes, 0)).toBe(BIG + '# Big report\n'.length);
    expect(done.manifests[done.attempts[attemptId]!.contextManifestId!]!.entries[0]!.mode).toBe('artifact_ref');
  }, 30_000);

  it('rejects unknown and released tokens', async () => {
    const host = new ArtifactToolHost();
    const store = new InMemoryArtifactStore(new SystemClock());
    const art = await store.put({ content: 'hello', producerRunId: 'r', producerNodeId: 'n', producerAttemptId: 'a', portName: 'p' });
    const manifest = {
      manifestId: 'm',
      runId: 'r',
      nodeId: 'n',
      attemptId: 'a2',
      scopeKey: '$root',
      goal: 'g',
      acceptanceCriteria: [],
      constraints: [],
      entries: [],
      authorizedArtifactIds: [art.artifactId],
      totalInlineBytes: 0,
      initialBudgetBytes: 1,
      pageReadBytes: 1024,
      stageReadQuotaBytes: 4096,
      createdAtMs: 0,
    };
    const reader = createScopedArtifactReader({ manifest, artifactStore: store, clock: new SystemClock(), idGenerator: new SequentialIdGenerator() });
    const { token, release } = host.register({ manifest, reader });
    const [server] = await host.mcpServers(token, { http: true });
    const url = (server as { url: string }).url;

    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const page = await client.callTool({ name: 'read_artifact', arguments: { artifactId: art.artifactId } });
    expect((page.content as { text: string }[])[0]!.text.startsWith('hello')).toBe(true);
    await client.close();

    release();
    const gone = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(gone.status).toBe(404);
    expect((await fetch(url.replace(token, 'nope'), { method: 'POST', body: '{}' })).status).toBe(404);
    await host.close();
  });
});
