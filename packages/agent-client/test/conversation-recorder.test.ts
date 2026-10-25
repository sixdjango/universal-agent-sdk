import { describe, expect, it, vi } from 'vitest';
import { ConversationRecorder, ConversationService, MemoryConversationStore } from '../src/conversation';
import type { ConversationRecorderOptions } from '../src/conversation';
import type { AcpSessionNotification } from '../src/types';

const agent = { agentType: 'custom', workdir: '/tmp' };
const source = { namespace: 'host', identifiers: { jobId: 'one' } };
const content = [{ type: 'text' as const, text: 'work' }];
const update = (text: string): AcpSessionNotification => ({ sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
async function setup(extra: Partial<ConversationRecorderOptions> = {}) {
  const store = extra.store ?? new MemoryConversationStore();
  const recorder = await ConversationRecorder.create({ store, agent, source, content, ...extra });
  const options = recorder.wrapSessionOptions({ ...agent, onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
  const service = new ConversationService({ store });
  return { store, recorder, options, service, turn: () => store.getTurn(recorder.conversationId, recorder.turnId) };
}

describe('ConversationRecorder', () => {
  it('keeps replay separate, snapshots callback payloads, and ignores callbacks after execution', async () => {
    const { recorder, store, options, service, turn } = await setup();
    await recorder.run(async () => {
      options.onUpdateMessage!(update('old history'));
      await recorder.attach({ sessionId: 'client', acpSessionId: 'native' }, 'native');
      recorder.beginPrompt();
      const notification = update('new output');
      options.onUpdateMessage!(notification);
      (notification.update as { content: { text: string } }).content.text = 'mutated';
      recorder.setResponse({ stopReason: 'end_turn' });
      return 42;
    });
    options.onUpdateMessage!(update('late output'));
    const events = (await store.readEvents(recorder.conversationId)).items;
    const replay = events.find(e => e.data.type === 'acp.update' && e.data.origin === 'replay');
    expect(replay).toBeDefined();
    expect(replay?.turnId).toBeUndefined();
    const messages = await service.getMessages(recorder.conversationId, recorder.turnId);
    expect(messages.filter(m => m.kind === 'content' && m.role === 'assistant')).toEqual([
      expect.objectContaining({ content: [{ type: 'text', text: 'new output' }] }),
    ]);
    expect(await turn()).toMatchObject({ status: 'completed' });
    expect(events.filter(e => e.data.type === 'turn.finished')).toHaveLength(1);
  });

  it('fails the execution on a transient event-store failure, preserving a failed terminal record', async () => {
    const { recorder, store, options, turn } = await setup();
    const commit = store.commit.bind(store);
    vi.spyOn(store, 'commit').mockImplementationOnce(async () => { throw new Error('disk write failed'); }).mockImplementation(commit);
    await expect(recorder.run(async () => {
      recorder.beginPrompt();
      options.onUpdateMessage!(update('unsaved'));
      recorder.setResponse({ stopReason: 'end_turn' });
    })).rejects.toThrow('disk write failed');
    expect(await turn()).toMatchObject({ status: 'failed', error: 'disk write failed' });
    expect(recorder.signal.aborted).toBe(true);
  });

  it('fails on event-buffer overflow instead of silently truncating a successful transcript', async () => {
    const { recorder, options, turn } = await setup({ maxPendingEvents: 1 });
    await expect(recorder.run(async () => {
      recorder.beginPrompt();
      options.onUpdateMessage!(update('one'));
      options.onUpdateMessage!(update('two'));
      recorder.setResponse({ stopReason: 'end_turn' });
    })).rejects.toThrow('cannot keep up');
    expect(await turn()).toMatchObject({ status: 'failed' });
  });

  it('expires pending permissions when the permission policy fails', async () => {
    const { recorder, turn } = await setup();
    const options = recorder.wrapSessionOptions({ ...agent, onRequestPermission: async () => { throw new Error('policy unavailable'); } });
    await expect(recorder.run(async () => {
      recorder.beginPrompt();
      await options.onRequestPermission('rpc', { sessionId: 'native', toolCall: { toolCallId: 'tool' }, options: [] });
    })).rejects.toThrow('policy unavailable');
    expect(await turn()).toMatchObject({ status: 'failed', permissions: [expect.objectContaining({ status: 'expired' })] });
  });

  it('queries generic source identities across concurrent calls and rejects reassignment', async () => {
    const store = new MemoryConversationStore();
    const a = await setup({ store, source: { namespace: 'host', identifiers: { jobId: 'one', part: 'a' } } });
    const b = await setup({ store, source: { namespace: 'host', identifiers: { jobId: 'one', part: 'b' } } });
    await Promise.all([a, b].map(({ recorder, options }) => recorder.run(async () => {
      recorder.beginPrompt(); options.onUpdateMessage!(update(recorder.conversationId));
      recorder.setResponse({ stopReason: 'end_turn' });
    })));
    expect(await store.list({ source: { namespace: 'host', identifiers: { part: 'a' } } })).toEqual([await store.get(a.recorder.conversationId)]);
    expect(await store.list({ source: { namespace: 'other' } })).toEqual([]);
    const first = await store.list({ source: { namespace: 'host' }, limit: 1 });
    const second = await store.list({ source: { namespace: 'host' }, afterId: first[0].id, limit: 1 });
    expect(new Set([...first, ...second].map(r => r.id)).size).toBe(2);
    const record = (await store.get(a.recorder.conversationId))!;
    await expect(store.commit({ expectedRevision: record.revision, record: { ...record, mode: 'chat' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.commit({ expectedRevision: record.revision, record: { ...record, source } })).rejects.toMatchObject({ code: 'invalid' });
    const messages = await a.service.getMessages(record.id, a.recorder.turnId);
    expect(messages).toContainEqual(expect.objectContaining({ content: [{ type: 'text', text: record.id }] }));
  });
});
