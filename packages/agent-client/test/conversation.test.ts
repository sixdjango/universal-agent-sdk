import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationService, MemoryConversationStore, projectConversationMessages } from '../src/conversation';
import type { ConversationCommit, ConversationSession, ConversationServiceOptions } from '../src/conversation';
import type { StartAgentSessionOptions } from '../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const prompt = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const agent = { agentType: 'custom', workdir: '/tmp', customCommand: { command: 'unused' } };
const done = { stopReason: 'end_turn' as const };
const permissionRequest: acp.RequestPermissionRequest = {
  sessionId: 'native', toolCall: { toolCallId: 'tool', title: 'Write a file', rawInput: ['path', 'contents'] },
  options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
};

describe('ConversationService', () => {
  const services: ConversationService[] = [];
  afterEach(async () => { for (const service of services.splice(0)) await service.shutdown().catch(() => {}); });

  function setup(run: (options: StartAgentSessionOptions, blocks: acp.ContentBlock[]) => Promise<acp.PromptResponse | undefined>, options: ConversationServiceOptions = {}) {
    const starts: StartAgentSessionOptions[] = [];
    const shutdown = vi.fn(async () => {});
    const send = vi.fn(run);
    const service = new ConversationService({ ...options, startSession: async launch => {
      starts.push(launch);
      return { acpSessionId: 'native', prompt: blocks => send(launch, blocks), cancel: async () => {}, shutdown };
    } });
    services.push(service);
    return { service, starts, shutdown, send };
  }

  it('runs durable FIFO turns once, reuses a native session, and rejects idempotency conflicts', async () => {
    const first = deferred<acp.PromptResponse>();
    const { service, starts, send } = setup(async (_opts, blocks) => blocks[0].type === 'text' && blocks[0].text === 'one' ? first.promise : done);
    const conversation = await service.create({ agent, extensions: { 'symphony.task': { issueId: 'T-1' } } });
    const one = await service.send(conversation.id, { ...prompt('one'), idempotencyKey: 'request-1' });
    const two = await service.send(conversation.id, prompt('two'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((await service.store.getTurn(conversation.id, two.id))?.status).toBe('queued');
    expect((await service.send(conversation.id, { ...prompt('one'), idempotencyKey: 'request-1' })).id).toBe(one.id);
    await expect(service.send(conversation.id, { ...prompt('changed'), idempotencyKey: 'request-1' })).rejects.toMatchObject({ code: 'conflict' });
    first.resolve(done);
    expect((await service.waitForTurn(conversation.id, two.id)).status).toBe('completed');
    expect(starts).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await service.get(conversation.id)).extensions).toEqual({ 'symphony.task': { issueId: 'T-1' } });
    const events = await service.store.readEvents(conversation.id);
    expect(events.items.map(event => event.sequence)).toEqual(events.items.map((_, index) => index + 1));
  });

  it('keeps multimodal blocks, arbitrary tool JSON, large output, metadata and custom host events', async () => {
    const output = '界'.repeat(70_000);
    const content: acp.ContentBlock[] = [
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', _meta: { 'host.ref': 1 } },
      { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'file content', mimeType: 'text/plain' } },
      { type: 'resource_link', uri: 'file:///y', name: 'report' },
    ];
    const { service } = setup(async options => {
      const emit = (update: Parameters<NonNullable<StartAgentSessionOptions['onUpdateMessage']>>[0]['update']) => options.onUpdateMessage!({ sessionId: 'native', update, _meta: { 'vendor.extra': { version: 1 } } });
      emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'progress' } });
      for (const block of content) emit({ sessionUpdate: 'agent_message_chunk', content: block });
      emit({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', kind: 'read', status: 'pending', rawInput: ['one', 2, false], _meta: { 'host.tool': 'data' } });
      emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', title: null, status: 'completed', rawInput: null, rawOutput: output,
        content: [{ type: 'diff', path: '/x', oldText: 'a', newText: 'b' }, { type: 'terminal', terminalId: 'term-1' }] });
      emit({ sessionUpdate: 'plan', entries: [{ content: 'Do work', priority: 'high', status: 'completed' }] });
      options.onUsageUpdate?.({ inputTokens: 7, outputTokens: 3 } as never, 'accounting-1');
      return done;
    });
    const record = await service.create({ agent });
    const turn = await service.send(record.id, { content, extensions: { 'symphony.message': { externalId: 9 } } });
    await service.waitForTurn(record.id, turn.id);
    await service.appendMessage(record.id, { role: 'system', content: [{ type: 'text', text: 'reviewed' }], extensions: { 'host.review': true } }, turn.id);
    await service.appendCustomEvent(record.id, { namespace: 'symphony', name: 'issue.updated', data: { issue: 'T-1' } }, turn.id);
    const messages = await service.getMessages(record.id, turn.id);
    expect(messages[0]).toMatchObject({ kind: 'content', content, extensions: { 'symphony.message': { externalId: 9 } } });
    expect(messages.find(m => m.kind === 'content' && m.role === 'assistant' && m.channel === 'message')).toMatchObject({ content });
    expect(messages.find(m => m.kind === 'tool_call')).toMatchObject({ toolCall: {
      title: 'Read', rawInput: ['one', 2, false], rawOutput: output, _meta: { 'host.tool': 'data' },
      status: 'completed', content: [{ type: 'diff', path: '/x', oldText: 'a', newText: 'b' }, { type: 'terminal', terminalId: 'term-1' }],
    } });
    expect(messages.at(-1)).toMatchObject({ kind: 'event', event: { type: 'custom', namespace: 'symphony', data: { issue: 'T-1' } } });
    const page = await service.store.readEvents(record.id, { turnId: turn.id, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(page.items[1].sequence);
    const remainder = await service.store.readEvents(record.id, { after: page.nextCursor, turnId: turn.id });
    expect(remainder.items[0].sequence).toBeGreaterThan(page.nextCursor!);
    expect(projectConversationMessages([...page.items, ...remainder.items])).toEqual(messages);
  });

  it('waits for permission, validates choices, and durably resolves before releasing the Agent', async () => {
    let permissionStateAtResume: string | undefined;
    let turnId: string;
    const { service, send } = setup(async options => {
      const response = await options.onRequestPermission('rpc-id', permissionRequest);
      permissionStateAtResume = (await service.store.getTurn('permissions', turnId))?.permissions[0].status;
      expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' }, _meta: { 'host.answer': 1 } });
      return done;
    });
    await service.create({ id: 'permissions', agent });
    const turn = await service.send('permissions', prompt('write'));
    turnId = turn.id;
    const second = await service.send('permissions', prompt('later'));
    await vi.waitFor(async () => expect((await service.store.getTurn('permissions', turn.id))?.status).toBe('waiting_permission'));
    const permission = (await service.store.getTurn('permissions', turn.id))!.permissions[0];
    expect(send).toHaveBeenCalledTimes(1);
    await expect(service.respondPermission('permissions', permission.id, { outcome: { outcome: 'selected', optionId: 'unknown' } })).rejects.toMatchObject({ code: 'invalid' });
    await service.cancel('permissions', second.id);
    await service.respondPermission('permissions', permission.id, { outcome: { outcome: 'selected', optionId: 'yes' }, _meta: { 'host.answer': 1 } });
    expect((await service.waitForTurn('permissions', turn.id)).status).toBe('completed');
    expect(permissionStateAtResume).toBe('answered');
    await expect(service.respondPermission('permissions', permission.id, { outcome: { outcome: 'cancelled' } })).rejects.toMatchObject({ code: 'conflict' });
  });

  it.each([
    ['end_turn', 'completed'], ['max_tokens', 'truncated'], ['max_turn_requests', 'truncated'],
    ['refusal', 'refused'], ['cancelled', 'cancelled'], ['unknown', 'failed'], [undefined, 'interrupted'],
  ])('classifies %s as %s and pauses after abnormal termination', async (reason, status) => {
    const { service } = setup(async () => reason === undefined ? undefined : { stopReason: reason } as acp.PromptResponse);
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('work'));
    expect((await service.waitForTurn(record.id, turn.id)).status).toBe(status);
    expect((await service.get(record.id)).queuePaused).toBe(status !== 'completed');
  });

  it('records a broken stream as failed and retains partial output', async () => {
    const { service } = setup(async options => {
      options.onUpdateMessage!({ sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } });
      throw new Error('Connection closed');
    });
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('work'));
    expect(await service.waitForTurn(record.id, turn.id)).toMatchObject({ status: 'failed', error: 'Connection closed' });
    expect(await service.getMessages(record.id, turn.id)).toContainEqual(expect.objectContaining({ content: [{ type: 'text', text: 'partial' }] }));
  });

  it('cancels a permission wait without sending queued prompts, then resumes on the same native id', async () => {
    let count = 0;
    const { service, starts, shutdown } = setup(async options => {
      if (++count === 1) { await options.onRequestPermission('rpc', permissionRequest); return done; }
      return done;
    });
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('write'));
    const queued = await service.send(record.id, prompt('next'));
    await vi.waitFor(async () => expect((await service.store.getTurn(record.id, turn.id))?.status).toBe('waiting_permission'));
    expect(await service.cancel(record.id, turn.id)).toMatchObject({ status: 'cancelled', permissions: [{ status: 'cancelled' }] });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect((await service.store.getTurn(record.id, queued.id))?.status).toBe('queued');
    await service.resume(record.id);
    expect((await service.waitForTurn(record.id, queued.id)).status).toBe('completed');
    expect(starts[1].resumeSessionId).toBe('native');
  });

  it('cancels a custom session which ignores AbortSignal and suppresses its late output', async () => {
    const hanging = deferred<acp.PromptResponse>();
    const { service, starts, send } = setup(async () => hanging.promise);
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('wait'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((await service.cancel(record.id, turn.id)).status).toBe('cancelled');
    starts[0].onUpdateMessage!({ sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } });
    hanging.resolve(done);
    expect(await service.getMessages(record.id, turn.id)).toHaveLength(1);
  });

  it('fences another owner, recovers expired turns/permissions, and resumes only unsent work', async () => {
    let now = 1_000;
    const store = new MemoryConversationStore();
    const first = setup(async options => { await options.onRequestPermission('rpc', permissionRequest); return done; }, {
      store, now: () => now, leaseDurationMs: 30_000, heartbeatIntervalMs: 10_000,
    });
    const second = setup(async () => done, { store, now: () => now });
    const record = await first.service.create({ agent });
    const running = await first.service.send(record.id, { ...prompt('unsafe to replay'), idempotencyKey: 'once' });
    const queued = await first.service.send(record.id, prompt('unsent'));
    await vi.waitFor(async () => expect((await store.getTurn(record.id, running.id))?.status).toBe('waiting_permission'));
    await expect(second.service.recover(record.id)).rejects.toMatchObject({ code: 'busy' });
    now += 30_001;
    await expect(second.service.send(record.id, prompt('new'))).rejects.toMatchObject({ code: 'recovery_required' });
    await second.service.recover(record.id);
    expect(await store.getTurn(record.id, running.id)).toMatchObject({ status: 'interrupted', permissions: [{ status: 'expired' }] });
    expect(second.send).not.toHaveBeenCalled();
    // Old callbacks cannot append after the takeover, even before their heartbeat runs.
    first.starts[0].onUpdateMessage!({ sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale owner' } } });
    await vi.waitFor(() => expect(first.shutdown).toHaveBeenCalled());
    await second.service.resume(record.id);
    expect((await second.service.waitForTurn(record.id, queued.id)).status).toBe('completed');
    expect(second.starts[0].resumeSessionId).toBe('native');
    expect(second.send).toHaveBeenCalledTimes(1);
    expect((await second.service.send(record.id, { ...prompt('unsafe to replay'), idempotencyKey: 'once' })).id).toBe(running.id);
    expect(JSON.stringify(await second.service.getMessages(record.id, running.id))).not.toContain('stale owner');
  });

  it('keeps a queue paused when native resume is unsupported, never falls back to a new session', async () => {
    const store = new MemoryConversationStore();
    const first = setup(async () => done, { store });
    const record = await first.service.create({ agent });
    await first.service.connect(record.id);
    await first.service.pause(record.id);
    const queued = await first.service.send(record.id, prompt('later'));
    await first.service.disconnect(record.id);
    const factory = vi.fn(async (options: StartAgentSessionOptions): Promise<ConversationSession> => {
      expect(options.resumeSessionId).toBe('native'); throw new Error('ACP_RESUME_UNSUPPORTED');
    });
    const errors = vi.fn();
    const second = new ConversationService({ store, startSession: factory, onError: errors }); services.push(second);
    await second.resume(record.id);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect((await second.get(record.id)).queuePaused).toBe(true);
    expect((await store.getTurn(record.id, queued.id))?.status).toBe('queued');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not announce success or send the next turn after an event write failure', async () => {
    class BrokenStore extends MemoryConversationStore {
      override async commit(input: ConversationCommit) {
        if (input.events?.some(e => e.data.type === 'acp.update')) throw new Error('disk full');
        return super.commit(input);
      }
    }
    const { service, send } = setup(async options => {
      options.onUpdateMessage!({ sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'not persisted' } } });
      return done;
    }, { store: new BrokenStore() });
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('one'));
    await service.send(record.id, prompt('two'));
    await expect(service.waitForTurn(record.id, turn.id)).rejects.toThrow('disk full');
    expect((await service.store.getTurn(record.id, turn.id))?.status).not.toBe('completed');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('publishes only committed events and isolates listener failures and mutations', async () => {
    const { service } = setup(async () => done);
    const record = await service.create({ agent });
    const reads: Promise<void>[] = [];
    service.subscribe(record.id, event => {
      reads.push(service.store.readEvents(record.id).then(page => { expect(page.items).toContainEqual(event); }));
    });
    service.subscribe(record.id, event => { event.sequence = -1; throw new Error('UI crashed'); });
    const turn = await service.send(record.id, prompt('one'));
    expect((await service.waitForTurn(record.id, turn.id)).status).toBe('completed');
    await Promise.all(reads);
    expect((await service.store.readEvents(record.id)).items.every(e => e.sequence > 0)).toBe(true);
  });

  it('rejects lossy extension values and closes queued work while keeping readable history', async () => {
    const { service, send } = setup(async () => done);
    await expect(service.create({ agent, extensions: { bad: Infinity } })).rejects.toMatchObject({ code: 'invalid' });
    const record = await service.create({ agent });
    await service.pause(record.id);
    const turn = await service.send(record.id, prompt('queued'));
    await service.close(record.id);
    expect((await service.get(record.id)).status).toBe('closed');
    expect((await service.store.getTurn(record.id, turn.id))?.status).toBe('cancelled');
    expect(send).not.toHaveBeenCalled();
    await expect(service.send(record.id, prompt('too late'))).rejects.toMatchObject({ code: 'closed' });
    expect(await service.getMessages(record.id, turn.id)).toHaveLength(1);
  });

  it('tracks multiple outstanding permissions separately and accepts an explicit host policy', async () => {
    const answers: string[] = [];
    const { service } = setup(async options => {
      await Promise.all(['a', 'b'].map(id => options.onRequestPermission(id, permissionRequest)));
      return done;
    }, { resolveSessionOptions: () => ({ onRequestPermission: async requestId => {
      answers.push(requestId); return { outcome: { outcome: 'selected', optionId: 'yes' } };
    } }) });
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('two permissions'));
    const result = await service.waitForTurn(record.id, turn.id);
    expect(result.status).toBe('completed');
    expect(result.permissions.map(p => p.status)).toEqual(['answered', 'answered']);
    expect(new Set(result.permissions.map(p => p.id)).size).toBe(2);
    expect(answers).toEqual(['a', 'b']);
  });

  it('does not let a rejected late permission policy stop a subsequent turn', async () => {
    const policy = deferred<acp.RequestPermissionResponse>();
    let count = 0;
    const { service } = setup(async options => {
      if (++count === 1) await options.onRequestPermission('rpc', permissionRequest);
      return done;
    }, { onPermission: () => policy.promise });
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('first'));
    await vi.waitFor(async () => expect((await service.store.getTurn(record.id, turn.id))?.status).toBe('waiting_permission'));
    await service.cancel(record.id, turn.id);
    const next = await service.send(record.id, prompt('second'));
    policy.reject(new Error('stale UI answer failed'));
    await service.resume(record.id);
    expect((await service.waitForTurn(record.id, next.id)).status).toBe('completed');
  });

  it('waits for startup cleanup before releasing ownership during shutdown', async () => {
    const starting = deferred<void>();
    const shutdown = vi.fn(async () => {});
    const factory = vi.fn(async (options: StartAgentSessionOptions): Promise<ConversationSession> => {
      options.signal?.addEventListener('abort', () => starting.resolve(), { once: true });
      await starting.promise;
      return { acpSessionId: 'native', prompt: async () => done, cancel: async () => {}, shutdown };
    });
    const service = new ConversationService({ startSession: factory }); services.push(service);
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('never started'));
    await vi.waitFor(() => expect(factory).toHaveBeenCalled());
    await service.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect((await service.get(record.id)).lease).toBeUndefined();
    expect((await service.store.getTurn(record.id, turn.id))?.status).toBe('queued');
  });

  it('fails visibly when the event writer overflows instead of dropping messages and completing', async () => {
    const { service } = setup(async options => {
      for (let i = 0; i < 4; i++) options.onUpdateMessage!({ sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(i) } } });
      return done;
    }, { maxPendingEvents: 2 });
    const record = await service.create({ agent });
    const turn = await service.send(record.id, prompt('burst'));
    await expect(service.waitForTurn(record.id, turn.id)).rejects.toThrow('writer cannot keep up');
    expect((await service.store.getTurn(record.id, turn.id))?.status).not.toBe('completed');
  });
});
