import type {
  ConversationEvent, ConversationPage, ConversationReadOptions, ConversationRecord, ConversationTurn,
} from '@universal-agent/client/conversation';

export type { ConversationEvent, ConversationRecord, ConversationTurn } from '@universal-agent/client/conversation';
export interface NodeConversationTarget { runId: string; scopeKey: string; nodeId: string }

/** Transport supplied by the embedding app. The UI never controls a Flow conversation. */
export interface ConversationReader {
  list(target: NodeConversationTarget, page: { afterId?: string; limit: number }, signal: AbortSignal): Promise<ConversationRecord[]>;
  get(id: string, signal: AbortSignal): Promise<ConversationRecord>;
  turns(id: string, page: ConversationReadOptions, signal: AbortSignal): Promise<ConversationPage<ConversationTurn>>;
  events(id: string, page: ConversationReadOptions, signal: AbortSignal): Promise<ConversationPage<ConversationEvent>>;
}
export interface ConversationCall { record: ConversationRecord; turns: ConversationTurn[] }
export interface ConversationTranscript extends ConversationCall {
  events: ConversationEvent[];
  cursor: number;
  /** All events through the fetched conversation revision have been loaded. */
  complete: boolean;
}

export const conversationStatusLabel: Record<ConversationTurn['status'], string> = {
  queued: 'Queued', running: 'Running', waiting_permission: 'Awaiting permission',
  completed: 'Completed', cancelled: 'Cancelled', truncated: 'Truncated', refused: 'Refused',
  failed: 'Failed', interrupted: 'Interrupted',
};

export function callStatus(call: ConversationCall): ConversationTurn['status'] | 'unavailable' {
  return call.turns.at(-1)?.status ?? (call.record.status === 'open' ? 'running' : 'unavailable');
}
export function callLabel(call: ConversationCall, index: number): string {
  const retry = Number(call.record.source?.identifiers.retryIndex ?? 0);
  const status = callStatus(call);
  return `Call ${index + 1} · ${retry > 0 ? `Retry ${retry}` : 'Initial call'} · ${status === 'unavailable' ? 'Status unavailable' : conversationStatusLabel[status]}`;
}

/** Filter before display as well as at the API boundary; never mix loop/parallel scopes. */
export function isNodeConversation(record: ConversationRecord, target: NodeConversationTarget): boolean {
  return record.mode === 'recording' && record.source?.namespace === 'workflow' &&
    Object.entries(target).every(([key, value]) => record.source?.identifiers[key] === value);
}

async function readTurns(reader: ConversationReader, id: string, signal: AbortSignal): Promise<ConversationTurn[]> {
  const turns = new Map<string, ConversationTurn>();
  let after = 0;
  while (true) {
    signal.throwIfAborted();
    const page = await reader.turns(id, { after, limit: 100 }, signal);
    signal.throwIfAborted();
    for (const turn of page.items) {
      if (turn.conversationId !== id) throw new Error('Received history for another conversation');
      turns.set(turn.id, turn);
    }
    if (page.nextCursor === undefined) break;
    if (page.nextCursor <= after) throw new Error('Conversation turn pagination did not advance');
    after = page.nextCursor;
  }
  return [...turns.values()].sort((a, b) => a.number - b.number);
}

/** Follow all list pages. Refresh only changed metadata, with at most four concurrent reads. */
export async function readNodeConversationCalls(
  reader: ConversationReader, target: NodeConversationTarget, signal: AbortSignal, previous: readonly ConversationCall[] = [],
): Promise<ConversationCall[]> {
  const records = new Map<string, ConversationRecord>();
  let afterId: string | undefined;
  while (true) {
    signal.throwIfAborted();
    const page = await reader.list(target, { afterId, limit: 100 }, signal);
    signal.throwIfAborted();
    for (const record of page) if (isNodeConversation(record, target)) records.set(record.id, record);
    if (page.length < 100) break;
    const nextId = page.at(-1)!.id;
    if (afterId !== undefined && nextId <= afterId) throw new Error('Conversation list pagination did not advance');
    afterId = nextId;
  }
  const cached = new Map(previous.map(call => [call.record.id, call]));
  const sorted = [...records.values()].sort((a, b) => a.createdAtMs - b.createdAtMs ||
    Number(a.source?.identifiers.retryIndex ?? 0) - Number(b.source?.identifiers.retryIndex ?? 0) || a.id.localeCompare(b.id));
  const calls: ConversationCall[] = [];
  for (let offset = 0; offset < sorted.length; offset += 4) {
    signal.throwIfAborted();
    calls.push(...await Promise.all(sorted.slice(offset, offset + 4).map(async record => {
      const old = cached.get(record.id);
      return old?.record.revision === record.revision ? old : { record, turns: await readTurns(reader, record.id, signal) };
    })));
  }
  signal.throwIfAborted();
  return calls;
}

/** Incremental event cursor. A partial load can resume after failure without losing tool deltas. */
export async function readConversationTranscript(
  reader: ConversationReader, id: string, signal: AbortSignal,
  options: { previous?: ConversationTranscript; onPage?: (value: ConversationTranscript) => void } = {},
): Promise<ConversationTranscript> {
  signal.throwIfAborted();
  const record = await reader.get(id, signal);
  signal.throwIfAborted();
  if (record.id !== id) throw new Error('Received history for another conversation');
  // Read turns after the record: a closed revision must not keep an older running status
  // and stop polling when the two HTTP responses race with the final commit.
  const turns = await readTurns(reader, id, signal);
  const previous = options.previous?.record.id === id ? options.previous : undefined;
  const events = [...(previous?.events ?? [])];
  let cursor = previous?.cursor ?? 0;
  while (cursor < record.lastEventSequence) {
    signal.throwIfAborted();
    const page = await reader.events(id, { after: cursor, limit: 100 }, signal);
    signal.throwIfAborted();
    const before = cursor;
    for (const event of page.items) {
      if (event.conversationId !== id) throw new Error('Received events for another conversation');
      if (event.sequence <= cursor) continue;
      if (event.sequence !== cursor + 1) throw new Error('Conversation history has a gap; refresh to retry');
      events.push(event); cursor = event.sequence;
    }
    if (cursor === before) throw new Error('Conversation history is not yet available; refresh to retry');
    const snapshot = { record, turns, events: [...events], cursor, complete: cursor >= record.lastEventSequence };
    options.onPage?.(snapshot);
  }
  return { record, turns, events, cursor, complete: true };
}

/** Render emitted resources without making arbitrary URLs or active document types executable. */
export function conversationLink(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try { const url = new URL(uri); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}
