import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRecorder } from '@universal-agent/client';
import {
  ConversationService, createNodeConversationService, openWorkflowDatabase, SqliteConversationStore,
  type ConversationRecord, type WorkflowDatabase,
} from '../src/index';

const agent = { agentType: 'custom', workdir: '/tmp', customCommand: { command: 'unused' } };
const prompt = (text: string) => ({ content: [{ type: 'text' as const, text }] });

describe('SQLite conversations', () => {
  const dirs: string[] = [];
  const databases: WorkflowDatabase[] = [];
  const services: ConversationService[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) await service.shutdown().catch(() => {});
    for (const db of databases.splice(0)) db.$client.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function database(path?: string) {
    const root = path ? undefined : mkdtempSync(join(tmpdir(), 'ua-conversation-'));
    if (root) dirs.push(root);
    const dbPath = path ?? join(root!, 'store.db');
    const db = openWorkflowDatabase(dbPath); databases.push(db);
    return { db, dbPath, root };
  }

  it('persists lossless history/extensions and pages across database reopen without any Flow', async () => {
    const { db, dbPath } = database();
    const service = createNodeConversationService({ db, startSession: async options => ({
      acpSessionId: 'native', cancel: async () => {}, shutdown: async () => {},
      prompt: async () => {
        options.onUpdateMessage!({ sessionId: 'native', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', kind: 'read', status: 'completed', rawInput: 42, rawOutput: 'large'.repeat(40_000) } });
        return { stopReason: 'end_turn' };
      },
    }) }); services.push(service);
    const record = await service.create({ id: 'chat', agent, extensions: { 'symphony.issue': { id: 'ABC', labels: ['sdk'] } } });
    const turn = await service.send(record.id, { ...prompt('work'), idempotencyKey: 'once', extensions: { 'host.message': { author: 'user' } } });
    await service.waitForTurn(record.id, turn.id);
    await service.appendCustomEvent(record.id, { namespace: 'host', name: 'review', data: { approved: true } }, turn.id);
    await service.disconnect(record.id);
    const { db: reopened } = database(dbPath);
    const cold = createNodeConversationService({ db: reopened }); services.push(cold);
    expect((await cold.get(record.id)).extensions).toEqual(record.extensions);
    expect(await cold.getMessages(record.id, turn.id)).toEqual(await service.getMessages(record.id, turn.id));
    expect((await cold.send(record.id, { ...prompt('work'), idempotencyKey: 'once', extensions: { 'host.message': { author: 'user' } } })).id).toBe(turn.id);
    const page = await cold.store.readEvents(record.id, { limit: 2 });
    const next = await cold.store.readEvents(record.id, { after: page.nextCursor, limit: 2 });
    expect(page.items.at(-1)!.sequence + 1).toBe(next.items[0].sequence);
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM runs').get()).toMatchObject({ count: 0 });
  });

  it('atomically rejects stale revisions across connections and excludes a second owner', async () => {
    const { db, dbPath } = database();
    const secondDb = database(dbPath).db;
    const first = createNodeConversationService({ db }); services.push(first);
    const second = createNodeConversationService({ db: secondDb }); services.push(second);
    const record = await first.create({ agent });
    const old = await first.get(record.id);
    await first.pause(record.id);
    await expect(second.pause(record.id)).rejects.toMatchObject({ code: 'busy' });
    const before = await second.store.readEvents(record.id);
    await expect(second.store.commit({ expectedRevision: old.revision, record: { ...old, title: 'stale' }, events: [{ data: { type: 'queue.resumed' } }] })).rejects.toMatchObject({ code: 'conflict' });
    expect(await second.store.readEvents(record.id)).toEqual(before);
    expect((await second.get(record.id)).title).toBeUndefined();
  });

  it('persists indexed source queries and pagination without changing existing chat records', async () => {
    const { db, dbPath } = database();
    const service = createNodeConversationService({ db }); services.push(service);
    const chat = await service.create({ id: 'old-chat', agent });
    const store = service.store;
    const record = async (namespace: string, runId: string, scopeKey: string, retryIndex: string) => {
      const recorder = await ConversationRecorder.create({ store, agent, source: { namespace, identifiers: { runId, scopeKey, retryIndex, 'custom."key': 'value' } }, content: [{ type: 'text', text: 'work' }] });
      await recorder.run(async () => { recorder.setResponse({ stopReason: 'end_turn' }); });
      return (await store.get(recorder.conversationId))!;
    };
    const a = await record('workflow', 'run-1', '$root', '0');
    const b = await record('workflow', 'run-1', '$root', '1');
    await record('workflow', 'run-2', '$root', '0');
    await record('symphony', 'run-1', '$root', '0');
    const reopened = new SqliteConversationStore({ db: database(dbPath).db });
    const source = { namespace: 'workflow', identifiers: { runId: 'run-1', scopeKey: '$root', 'custom."key': 'value' } };
    const first = await reopened.list({ source, limit: 1 });
    const next = await reopened.list({ source, limit: 1, afterId: first[0].id });
    expect([...first, ...next].map(r => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await reopened.list({ source: { ...source, identifiers: { ...source.identifiers, retryIndex: '1' } } })).toEqual([b]);
    expect(await reopened.list({ source: { namespace: 'symphony' } })).toHaveLength(1);
    expect(await reopened.list({ source: { ...source, identifiers: { runId: 'missing' } } })).toEqual([]);
    expect(await reopened.get(chat.id)).toEqual(chat);
    await expect(reopened.commit({ expectedRevision: a.revision, record: { ...a, source: { namespace: 'workflow', identifiers: { runId: 'run-2' } } } })).rejects.toMatchObject({ code: 'invalid' });
    expect(await reopened.get(a.id)).toEqual(a);
  });

  it('rolls back turns and events on an idempotency collision', async () => {
    const { db } = database();
    const service = createNodeConversationService({ db }); services.push(service);
    const record = await service.create({ agent });
    await service.pause(record.id);
    const turn = await service.send(record.id, { ...prompt('one'), idempotencyKey: 'one' });
    const current = await service.get(record.id);
    await expect(service.store.commit({ expectedRevision: current.revision, record: current, turns: [
      { ...turn, id: 'other', number: turn.number + 1 },
    ], events: [{ data: { type: 'queue.resumed' } }] })).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.store.listTurns(record.id)).items).toEqual([turn]);
    expect(await service.get(record.id)).toEqual(current);
  });

  it('recovers a killed owner: expires permission, fences stale writes, and sends only queued work', async () => {
    const { db, dbPath, root } = database();
    const clientEntry = fileURLToPath(new URL('../../agent-client/dist/index.js', import.meta.url));
    const nodeEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const script = join(root!, 'owner.mjs');
    writeFileSync(script, `
import { ConversationService } from ${JSON.stringify(clientEntry)};
import { openWorkflowDatabase, SqliteConversationStore } from ${JSON.stringify(nodeEntry)};
const db = openWorkflowDatabase(${JSON.stringify(dbPath)});
const service = new ConversationService({ store: new SqliteConversationStore({ db }), leaseDurationMs: 300, heartbeatIntervalMs: 100,
  startSession: async options => ({ acpSessionId: 'crash-native', cancel: async () => {}, shutdown: async () => {},
    prompt: async () => { await options.onRequestPermission('rpc', { sessionId: 'crash-native', toolCall: { toolCallId: 'write' }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }] }); return { stopReason: 'end_turn' }; }
  })
});
await service.create({ id: 'crash', agent: ${JSON.stringify(agent)} });
const one = await service.send('crash', { content: [{ type: 'text', text: 'started' }] });
const two = await service.send('crash', { content: [{ type: 'text', text: 'never sent' }] });
const timer = setInterval(async () => { const t = await service.store.getTurn('crash', one.id); if (t.status === 'waiting_permission') { clearInterval(timer); process.stdout.write(JSON.stringify({one: one.id, two: two.id}) + '\\n'); } }, 10);
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => { errors += data; });
    try {
      const info = await new Promise<{ one: string; two: string }>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`Owner did not become ready: ${errors}`)), 10_000);
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Owner exited ${code}: ${errors}`)); });
        child.stdout.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.split('\n')[0])); } });
      });
      const crashed = await new SqliteConversationStore({ db }).get('crash') as ConversationRecord;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      const sent: string[] = [];
      const recovered = createNodeConversationService({ db, startSession: async options => {
        expect(options.resumeSessionId).toBe('crash-native');
        return { acpSessionId: 'crash-native', cancel: async () => {}, shutdown: async () => {}, prompt: async blocks => {
          sent.push((blocks[0] as { text: string }).text); return { stopReason: 'end_turn' };
        } };
      } }); services.push(recovered);
      await vi.waitFor(async () => { await recovered.recover('crash'); }, { interval: 30, timeout: 3000 });
      expect(await recovered.store.getTurn('crash', info.one)).toMatchObject({ status: 'interrupted', permissions: [{ status: 'expired' }] });
      expect(sent).toEqual([]);
      await expect(recovered.store.commit({ expectedRevision: crashed.revision, record: crashed })).rejects.toMatchObject({ code: 'conflict' });
      await recovered.resume('crash');
      expect((await recovered.waitForTurn('crash', info.two)).status).toBe('completed');
      expect(sent).toEqual(['never sent']);
    } finally { child.kill('SIGKILL'); }
  }, 15_000);

  it('uses the actual ACP process path for tools, permissions, multimodal messages and native resume', async () => {
    const { db, root } = database();
    const script = join(root!, 'agent.mjs');
    writeFileSync(script, `
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let promptId;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true } } });
  if (message.method === 'session/new' || message.method === 'session/load') return reply({ sessionId: 'real-native', configOptions: [] });
  if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ method: 'session/update', params: { sessionId: 'real-native', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', kind: 'read', status: 'pending', rawInput: { path: '/a' } } } });
    return send({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'real-native', toolCall: { toolCallId: 'tool', kind: 'read' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
  }
  if (message.id === 'permission') {
    send({ method: 'session/update', params: { sessionId: 'real-native', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: ['full', 7, true] } } });
    send({ method: 'session/update', params: { sessionId: 'real-native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'YQ==' } } } });
    return send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
  if (message.id !== undefined) reply({});
});
`);
    const service = createNodeConversationService({ db, resolveSessionOptions: () => ({ dataDir: join(root!, 'data'), env: { UA_KEEP_CODEX_HOME: '1' } }),
      onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
    }); services.push(service);
    const record = await service.create({ agent: { workdir: root!, target: { cliType: 'custom', agentType: 'fixture', command: process.execPath, args: [script] } } });
    const first = await service.send(record.id, prompt('first'));
    expect((await service.waitForTurn(record.id, first.id)).status).toBe('completed');
    const messages = await service.getMessages(record.id, first.id);
    expect(messages.find(m => m.kind === 'tool_call')).toMatchObject({ toolCall: { rawInput: { path: '/a' }, rawOutput: ['full', 7, true] } });
    expect(messages.find(m => m.kind === 'content' && m.role === 'assistant')).toMatchObject({ content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }] });
    await service.disconnect(record.id);
    const second = await service.send(record.id, prompt('second'));
    await service.resume(record.id);
    expect((await service.waitForTurn(record.id, second.id)).status).toBe('completed');
    expect((await service.get(record.id)).nativeSessionId).toBe('real-native');
  }, 20_000);
});
