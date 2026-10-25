import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { projectConversationMessages, type ConversationEvent, type ConversationRecord, type ConversationTurn } from '@universal-agent/client/conversation';
import { ConversationTranscriptView } from '../src/components/NodeConversation';
import {
  callLabel, conversationLink, readConversationTranscript, readNodeConversationCalls,
  type ConversationReader, type ConversationTranscript,
} from '../src/model/conversation';

const target = { runId: 'run', scopeKey: '$root/loop:round_1/each:item_2', nodeId: 'worker' };
function record(id: string, retryIndex = 0, createdAtMs = 1000): ConversationRecord {
  return { schemaVersion: 1, id, agent: { agentType: 'custom', workdir: '/tmp' }, mode: 'recording',
    source: { namespace: 'workflow', identifiers: { ...target, attemptId: 'same-attempt', invocationId: 'same-invocation', retryIndex: String(retryIndex) } },
    status: 'closed', revision: 1, lastEventSequence: 1, lastTurnNumber: 1, queuePaused: true, createdAtMs, updatedAtMs: createdAtMs, extensions: {} };
}
function turn(id: string, status: ConversationTurn['status'] = 'completed'): ConversationTurn {
  return { id: `${id}:turn`, conversationId: id, number: 1, content: [{ type: 'text', text: 'prompt' }], status, createdAtMs: 1000, permissions: [], extensions: {} };
}
function event(id: string, sequence: number, data: ConversationEvent['data']): ConversationEvent {
  return { conversationId: id, turnId: `${id}:turn`, timestampMs: 1000 + sequence, sequence, data };
}
function reader(records: ConversationRecord[], events: ConversationEvent[] = []): ConversationReader {
  return {
    list: vi.fn(async (_target, page) => records.filter(r => !page.afterId || r.id > page.afterId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, page.limit)),
    get: vi.fn(async id => records.find(r => r.id === id)!),
    turns: vi.fn(async id => ({ items: [turn(id)] })),
    events: vi.fn(async (id, page) => {
      const all = events.filter(e => e.conversationId === id && e.sequence > (page.after ?? 0));
      const items = all.slice(0, page.limit);
      return { items, ...(all.length > items.length ? { nextCursor: items.at(-1)!.sequence } : {}) };
    }),
  };
}
const signal = () => new AbortController().signal;

describe('node conversation history', () => {
  it('pages every call, keeps same-attempt retries separate and filters other run/scope/node records', async () => {
    const records = Array.from({ length: 105 }, (_, i) => record(`call-${String(i).padStart(3, '0')}`, i, 1000 + i));
    const others = ['runId', 'scopeKey', 'nodeId'].map((key, i) => {
      const r = record(`foreign-${i}`); r.source!.identifiers[key] = 'other'; return r;
    });
    const source = reader([...records, ...others]);
    const calls = await readNodeConversationCalls(source, target, signal());
    expect(calls).toHaveLength(105);
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(calls.map(c => c.record.id)).toEqual(records.map(r => r.id));
    expect(callLabel({ ...calls[0], turns: [turn(calls[0].record.id, 'failed')] }, 0)).toBe('Call 1 · Initial call · Failed');
    expect(callLabel(calls[1], 1)).toBe('Call 2 · Retry 1 · Completed');
    await readNodeConversationCalls(source, target, signal(), calls);
    expect(source.turns).toHaveBeenCalledTimes(105); // No re-reading unchanged prompts on every poll.
  });

  it('sorts retries chronologically even when UUID pagination order is different', async () => {
    const calls = await readNodeConversationCalls(reader([record('a', 2, 3000), record('z', 0, 1000), record('m', 1, 2000)]), target, signal());
    expect(calls.map(call => call.record.id)).toEqual(['z', 'm', 'a']);
  });

  it('loads all event pages, merges tools across page boundaries and retains large/multimodal output', async () => {
    const r = record('call'); r.lastEventSequence = 204;
    const events = [event(r.id, 1, { type: 'turn.queued', turn: turn(r.id) })];
    events.push(event(r.id, 2, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', status: 'pending', rawInput: ['file', 3, false] } } }));
    for (let i = 3; i <= 202; i++) events.push(event(r.id, i, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk-${i}\n` } } } }));
    const large = '界'.repeat(80_000) + 'END-OF-OUTPUT';
    events.push(event(r.id, 203, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: large } } }));
    events.push(event(r.id, 204, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'YQ==', mimeType: 'image/png' } } } }));
    const source = reader([r], events);
    const value = await readConversationTranscript(source, r.id, signal());
    expect(source.events).toHaveBeenCalledTimes(3);
    expect(value.events).toHaveLength(204);
    const projected = projectConversationMessages(value.events);
    expect(projected.filter(m => m.kind === 'tool_call')).toEqual([expect.objectContaining({ toolCall: expect.objectContaining({ rawInput: ['file', 3, false], rawOutput: large, status: 'completed' }) })]);
    const html = renderToStaticMarkup(<ConversationTranscriptView value={value} />);
    expect(html).toContain('END-OF-OUTPUT');
    expect(html).toContain('chunk-202');
    expect(html).toContain('data:image/png;base64,YQ==');
    const resumed = await readConversationTranscript(source, r.id, signal(), { previous: value });
    expect(resumed.events).toEqual(value.events);
    expect(source.events).toHaveBeenCalledTimes(3);
  });

  it('retains partial history on failure and resumes from its cursor through final cancellation', async () => {
    const r = record('call'); r.lastEventSequence = 102; r.status = 'open';
    const events = Array.from({ length: 102 }, (_, i) => event(r.id, i + 1, { type: 'custom', namespace: 'host', name: 'progress', data: i }));
    const source = reader([r], events);
    const read = source.events;
    source.events = vi.fn(async (id, page, signal) => {
      if (page.after === 100) throw new Error('offline');
      return read(id, page, signal);
    });
    let partial: ConversationTranscript | undefined;
    await expect(readConversationTranscript(source, r.id, signal(), { onPage: value => { partial = value; } })).rejects.toThrow('offline');
    expect(partial?.cursor).toBe(100);
    expect(partial?.complete).toBe(false);
    source.events = read;
    r.status = 'closed';
    source.turns = vi.fn(async () => ({ items: [{ ...turn(r.id, 'cancelled'), stopReason: 'cancelled', error: 'User cancelled' }] }));
    const final = await readConversationTranscript(source, r.id, signal(), { previous: partial });
    expect(final.events).toHaveLength(102);
    expect(final.complete).toBe(true);
    expect(source.events).toHaveBeenLastCalledWith(r.id, { after: 100, limit: 100 }, expect.any(AbortSignal));
    const html = renderToStaticMarkup(<ConversationTranscriptView value={final} />);
    expect(html).toContain('Cancelled');
    expect(html).toContain('User cancelled');
    expect(html).not.toContain('Completed');
  });

  it('discards late responses after abort even when the transport ignores AbortSignal', async () => {
    const source = reader([record('old')]);
    let resolve!: (value: Awaited<ReturnType<ConversationReader['events']>>) => void;
    source.events = () => new Promise(yes => { resolve = yes; });
    const abort = new AbortController();
    const onPage = vi.fn();
    const pending = readConversationTranscript(source, 'old', abort.signal, { onPage });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    abort.abort();
    resolve({ items: [event('old', 1, { type: 'conversation.closed' })] });
    await rejected;
    expect(onPage).not.toHaveBeenCalled();
  });

  it('does not pair a closed recording with stale running metadata during a final commit', async () => {
    const r = record('call');
    const source = reader([r], [event(r.id, 1, { type: 'turn.finished', status: 'cancelled', stopReason: 'cancelled' })]);
    let committed = false;
    source.get = async () => {
      await Promise.resolve();
      committed = true;
      return r;
    };
    source.turns = async () => ({ items: [turn(r.id, committed ? 'cancelled' : 'running')] });
    const value = await readConversationTranscript(source, r.id, signal());
    expect(value.record.status).toBe('closed');
    expect(value.turns[0].status).toBe('cancelled');
  });

  it('rejects event gaps and does not reuse another call’s transcript', async () => {
    const source = reader([record('old'), record('new')], [event('new', 2, { type: 'conversation.closed' })]);
    await expect(readConversationTranscript(source, 'new', signal(), { previous: { record: record('old'), turns: [], events: [], cursor: 10, complete: true } })).rejects.toThrow('gap');
    expect(source.events).toHaveBeenCalledWith('new', { after: 0, limit: 100 }, expect.any(AbortSignal));
  });

  it('joins text fragments as emitted and retains tool diffs and terminal references', () => {
    const events = ['Hel', 'lo\n', 'World'].map((text, i) => event('call', i + 1, {
      type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    }));
    events.push(event('call', 4, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: {
      sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Edit', status: 'completed',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'before', newText: 'after-content' }, { type: 'terminal', terminalId: 'terminal-42' }],
    } } }));
    const html = renderToStaticMarkup(<ConversationTranscriptView value={{ record: record('call'), turns: [turn('call')], events, cursor: 4, complete: true }} />);
    expect(html).toContain('Hello\nWorld');
    expect(html).toContain('after-content');
    expect(html).toContain('terminal-42');
  });

  it.each(['failed', 'cancelled', 'truncated', 'refused', 'interrupted', 'waiting_permission'] as const)('renders %s as its actual status', status => {
    const html = renderToStaticMarkup(<ConversationTranscriptView value={{ record: record('call'), turns: [{ ...turn('call', status), error: 'Exact failure detail', stopReason: 'reason' }], events: [], cursor: 0, complete: true }} />);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('Exact failure detail');
    expect(html).not.toContain('Completed');
  });

  it('renders thought, permission denial/cancellation, resources and plans without executing emitted HTML', () => {
    const permission = { id: 'permission', requestId: 'rpc', turnId: 'call:turn', createdAtMs: 1000, status: 'answered' as const,
      request: { sessionId: 'native', toolCall: { toolCallId: 'tool', title: 'Write file' }, options: [{ optionId: 'no', kind: 'reject_once' as const, name: 'Reject write' }] },
      response: { outcome: { outcome: 'selected' as const, optionId: 'no' } } };
    const events = [
      event('call', 1, { type: 'permission.requested', permission: { ...permission, status: 'pending', response: undefined } }),
      event('call', 2, { type: 'permission.resolved', permission }),
      event('call', 3, { type: 'permission.resolved', permission: { ...permission, status: 'cancelled', response: { outcome: { outcome: 'cancelled' } } } }),
      event('call', 4, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '<script>alert(1)</script>' } } } }),
      event('call', 5, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: { uri: 'file:///report', text: 'Entire report' } } } } }),
      event('call', 6, { type: 'acp.update', origin: 'live', notification: { sessionId: 'native', update: { sessionUpdate: 'plan', entries: [{ content: 'Review report', priority: 'high', status: 'completed' }] } } }),
    ];
    const html = renderToStaticMarkup(<ConversationTranscriptView value={{ record: record('call'), turns: [turn('call', 'failed')], events, cursor: 6, complete: true }} />);
    for (const text of ['Permission · Requested', 'Permission · Denied', 'Permission · Cancelled', 'Thought', 'Entire report', 'Review report']) expect(html).toContain(text);
    expect(html).not.toContain('<script>');
    expect(conversationLink('javascript:alert(1)')).toBeUndefined();
    expect(conversationLink('file:///secret')).toBeUndefined();
    expect(conversationLink('https://example.com/report')).toBe('https://example.com/report');
  });
});
