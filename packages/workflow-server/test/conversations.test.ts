import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAgentRegistry } from '@universal-agent/workflow-agents';
import { createNodeWorkflowRuntime, openWorkflowDatabase, SqliteRuntimeStore, SqliteArtifactStore } from '@universal-agent/workflow-node';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime } from '@universal-agent/workflow-runtime';
import { describe, expect, it, vi } from 'vitest';
import { createWorkflowServer } from '../src/server';

const headers = { host: '127.0.0.1' };

describe('standalone conversation HTTP API', () => {
  it('queries real Flow ACP calls, tools, permissions and separate retries through the shared API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ua-flow-chat-api-'));
    const db = openWorkflowDatabase(join(root, 'db.sqlite'));
    const script = join(root, 'agent.mjs');
    writeFileSync(join(root, 'counter'), '0');
    writeFileSync(script, `
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let promptId, count;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: message.params.protocolVersion, agentCapabilities: { sessionCapabilities: { close: {} } } });
  if (message.method === 'session/new') return reply({ sessionId: 'native', configOptions: [] });
  if (message.method === 'session/prompt') {
    promptId = message.id;
    count = Number(readFileSync('counter', 'utf8')) + 1;
    writeFileSync('counter', String(count));
    send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', kind: 'read', status: 'pending', rawInput: ['file', count] } } });
    return send({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { toolCallId: 'tool', kind: 'read' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] } });
  }
  if (message.id === 'permission') {
    send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: { count, decision: message.result.outcome } } } });
    send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'YQ==', mimeType: 'image/png' } } } });
    return send({ id: promptId, result: { stopReason: count === 1 ? 'max_tokens' : 'end_turn' } });
  }
  if (message.id !== undefined) reply({});
});
`);
    const runtime = createNodeWorkflowRuntime({ db, workdir: root, homeDir: root,
      defaultTarget: { target: { cliType: 'custom', agentType: 'fixture', command: process.execPath, args: [script] } },
    });
    const server = await createWorkflowServer({ db, runtime, registry: new SqliteAgentRegistry({ db }), workdir: root, resumeInterruptedRuns: false });
    try {
      const definition = createWorkflowBuilder('flow-transcript').addAgent({ id: 'worker', name: 'Worker', role: 'worker', goal: 'Read', maxTechnicalRetries: 1 }).buildDefinition();
      const { runId } = await runtime.start({ definition });
      expect((await runtime.runUntilSettled(runId)).status).toBe('SUCCEEDED');
      const response = await server.app.inject({ url: `/api/runs/${runId}/conversations?nodeId=worker`, headers });
      expect(response.statusCode).toBe(200);
      const records = response.json().conversations.sort((a: any, b: any) => Number(a.source.identifiers.retryIndex) - Number(b.source.identifiers.retryIndex));
      expect(records).toHaveLength(2);
      expect(records.map((r: any) => r.source.identifiers.retryIndex)).toEqual(['0', '1']);
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const turn = (await server.app.inject({ url: `/api/conversations/${record.id}/turns`, headers })).json().items[0];
        const history = (await server.app.inject({ url: `/api/conversations/${record.id}/turns/${turn.id}`, headers })).json();
        expect(history.turn.status).toBe(i === 0 ? 'truncated' : 'completed');
        expect(history.turn.permissions).toEqual([expect.objectContaining({ status: 'answered', response: { outcome: { outcome: 'selected', optionId: 'yes' } } })]);
        expect(history.messages).toContainEqual(expect.objectContaining({ kind: 'tool_call', toolCall: expect.objectContaining({ rawInput: ['file', i + 1], rawOutput: { count: i + 1, decision: { outcome: 'selected', optionId: 'yes' } } }) }));
        expect(history.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] }));
        const events = (await server.app.inject({ url: `/api/conversations/${record.id}/events?limit=2`, headers })).json();
        expect(events.items).toHaveLength(2);
        expect(events.nextCursor).toBe(2);
        expect((await server.app.inject({ method: 'POST', url: `/api/conversations/${record.id}/turns`, headers, payload: { content: [{ type: 'text', text: 'take over' }] } })).statusCode).toBe(409);
      }
      const filtered = (await server.app.inject({ url: `/api/runs/${runId}/conversations?retryIndex=1&scopeKey=%24root`, headers })).json();
      expect(filtered.conversations).toEqual([records[1]]);
      expect((await server.app.inject({ url: `/api/runs/${runId}/conversations?retryIndex=-1`, headers })).statusCode).toBe(400);
      expect((await server.app.inject({ url: '/api/runs/missing/conversations', headers })).statusCode).toBe(404);
    } finally { await server.app.close(); db.$client.close(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it('shares the SDK queue, permission, history, extensions and recovery semantics without a Flow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ua-chat-api-'));
    const db = openWorkflowDatabase(join(root, 'db.sqlite'));
    const runtime = createWorkflowRuntime({ store: new SqliteRuntimeStore({ db }), artifacts: new SqliteArtifactStore({ db, blobsDir: join(root, 'blobs') }) });
    const server = await createWorkflowServer({
      db, runtime, registry: new SqliteAgentRegistry({ db }), workdir: root, resumeInterruptedRuns: false,
      conversationOptions: { startSession: async options => ({
        acpSessionId: 'native', cancel: async () => {}, shutdown: async () => {},
        prompt: async blocks => {
          if ((blocks[0] as { text: string }).text === 'permission') {
            const answer = await options.onRequestPermission('rpc', {
              sessionId: 'native', toolCall: { toolCallId: 'tool', rawInput: { path: '/a' } },
              options: [{ kind: 'allow_once', name: 'Allow', optionId: 'yes' }],
            });
            expect(answer.outcome).toEqual({ outcome: 'selected', optionId: 'yes' });
          }
          options.onUpdateMessage!({ sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'result' } } });
          return { stopReason: 'end_turn' };
        },
      }) },
    });
    try {
      const create = await server.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
        id: 'chat', agent: { agentType: 'custom', workdir: root, customCommand: { command: 'unused' } }, extensions: { 'symphony.issue': { id: 42 } },
      } });
      expect(create.statusCode).toBe(201);
      const invalid = await server.app.inject({ method: 'POST', url: '/api/conversations/chat/turns', headers, payload: { content: [{ type: 'image', text: 'invalid image' }] } });
      expect(invalid.statusCode).toBe(400);
      const sent = await server.app.inject({ method: 'POST', url: '/api/conversations/chat/turns', headers, payload: { content: [{ type: 'text', text: 'permission' }], idempotencyKey: 'request-1' } });
      expect(sent.statusCode).toBe(202);
      const turn = sent.json();
      await vi.waitFor(async () => {
        const result = await server.app.inject({ url: '/api/conversations/chat/permissions', headers });
        expect(result.json().permissions).toHaveLength(1);
      });
      const permission = (await server.app.inject({ url: '/api/conversations/chat/permissions', headers })).json().permissions[0];
      const invalidAnswer = await server.app.inject({ method: 'POST', url: `/api/conversations/chat/permissions/${permission.id}/respond`, headers, payload: { outcome: { outcome: 'selected', optionId: 'wrong' } } });
      expect(invalidAnswer.statusCode).toBe(400);
      const answered = await server.app.inject({ method: 'POST', url: `/api/conversations/chat/permissions/${permission.id}/respond`, headers, payload: { outcome: { outcome: 'selected', optionId: 'yes' } } });
      expect(answered.statusCode).toBe(204);
      await server.host.conversations.waitForTurn('chat', turn.id);
      const history = await server.app.inject({ url: `/api/conversations/chat/turns/${turn.id}`, headers });
      expect(history.json().turn.status).toBe('completed');
      expect(history.json().messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'result' }] }));
      const repeated = await server.app.inject({ method: 'POST', url: '/api/conversations/chat/turns', headers, payload: { content: [{ type: 'text', text: 'permission' }], idempotencyKey: 'request-1' } });
      expect(repeated.json().id).toBe(turn.id);
      const conflicting = await server.app.inject({ method: 'POST', url: '/api/conversations/chat/turns', headers, payload: { content: [{ type: 'text', text: 'different' }], idempotencyKey: 'request-1' } });
      expect(conflicting.statusCode).toBe(409);
      expect((await server.app.inject({ url: '/api/conversations/chat', headers })).json().extensions).toEqual({ 'symphony.issue': { id: 42 } });
      const page = (await server.app.inject({ url: '/api/conversations/chat/events?limit=1', headers })).json();
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe(1);
      expect((await server.app.inject({ url: '/api/conversations/chat/events?after=-1', headers })).statusCode).toBe(400);
      expect((await server.app.inject({ url: '/api/conversations/missing', headers })).statusCode).toBe(404);
      const extension = await server.app.inject({ method: 'POST', url: '/api/conversations/chat/events', headers, payload: { namespace: 'symphony', name: 'review', data: { ok: true }, turnId: turn.id } });
      expect(extension.statusCode).toBe(204);
      // Live delivery uses the same persisted sequence, and shutdown closes the SSE connection.
      const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${address}/api/conversations/chat/stream`, { headers: { 'Last-Event-ID': '1' } });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let streamText = '';
      while (!streamText.includes('event: conversation')) streamText += new TextDecoder().decode((await reader.read()).value);
      expect(streamText).toContain('id: 2\nevent: conversation');
      await reader.cancel();
      await server.app.inject({ method: 'POST', url: '/api/conversations/chat/close', headers });
      expect((await server.app.inject({ method: 'POST', url: '/api/conversations/chat/turns', headers, payload: { content: [{ type: 'text', text: 'closed' }] } })).statusCode).toBe(409);
      expect(db.$client.prepare('SELECT COUNT(*) AS count FROM runs').get()).toMatchObject({ count: 0 });
    } finally { await server.app.close(); db.$client.close(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
