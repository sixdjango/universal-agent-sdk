import type {
  ConversationCommit, ConversationEvent, ConversationPage, ConversationReadOptions,
  ConversationRecord, ConversationStore, ConversationTurn, ConversationTurnStatus, ConversationListOptions, ConversationSource,
} from './types';

export class ConversationError extends Error {
  constructor(readonly code: 'not_found' | 'conflict' | 'busy' | 'recovery_required' | 'lease_lost' | 'closed' | 'invalid' | 'storage_failed', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversationError';
  }
}

/** Reject lossy JSON conversions (undefined object properties are harmless and omitted). */
export function conversationJson<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (item: unknown, inArray = false): void => {
    if (item === undefined && !inArray) return;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || seen.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
      throw new ConversationError('invalid', 'Conversation data must contain only finite, acyclic JSON values');
    }
    seen.add(item);
    if (Array.isArray(item)) for (const value of item) visit(value, true);
    else for (const value of Object.values(item)) visit(value);
    seen.delete(item);
  };
  visit(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function conversationPageSize(limit = 100): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new ConversationError('invalid', 'Page limit must be an integer between 1 and 1000');
  }
  return limit;
}

export function conversationCursor(after = 0): number {
  if (!Number.isSafeInteger(after) || after < 0) throw new ConversationError('invalid', 'Cursor must be a nonnegative integer');
  return after;
}

export function isConversationTurnFinished(status: ConversationTurnStatus): boolean {
  return status !== 'queued' && status !== 'running' && status !== 'waiting_permission';
}

export function validateConversationSource(source: ConversationSource | undefined): void {
  if (source !== undefined && (!source.namespace?.trim() || !source.identifiers ||
    Object.keys(source.identifiers).length === 0 || Object.entries(source.identifiers).some(([key, value]) =>
      !key.trim() || typeof value !== 'string' || !value.trim()))) {
    throw new ConversationError('invalid', 'Conversation source needs a namespace and nonempty string identifiers');
  }
}

export function matchesConversationSource(record: ConversationRecord, source: ConversationListOptions['source']): boolean {
  return !source || (record.source?.namespace === source.namespace && Object.entries(source.identifiers ?? {})
    .every(([key, value]) => record.source?.identifiers[key] === value));
}

/** Shared CAS/event sequencing rules for memory, SQLite and custom stores. */
export function prepareConversationCommit(current: ConversationRecord | undefined, input: ConversationCommit): {
  record: ConversationRecord; events: ConversationEvent[];
} {
  if (!current) throw new ConversationError('not_found', `Conversation "${input.record.id}" does not exist`);
  if (current.revision !== input.expectedRevision) throw new ConversationError('conflict', 'Conversation revision changed');
  if (input.record.id !== current.id || input.record.createdAtMs !== current.createdAtMs) {
    throw new ConversationError('invalid', 'Conversation identity is immutable');
  }
  if ((current.mode ?? 'chat') !== (input.record.mode ?? 'chat') ||
    Boolean(current.source) !== Boolean(input.record.source) ||
    !matchesConversationSource(input.record, current.source) || !matchesConversationSource(current, input.record.source)) {
    throw new ConversationError('invalid', 'Conversation mode and source are immutable');
  }
  const events = (input.events ?? []).map((event, index): ConversationEvent => ({
    ...event, conversationId: current.id, sequence: current.lastEventSequence + index + 1,
    timestampMs: input.record.updatedAtMs,
  }));
  const record = { ...input.record, revision: current.revision + 1, lastEventSequence: current.lastEventSequence + events.length };
  for (const turn of input.turns ?? []) {
    if (turn.conversationId !== record.id) throw new ConversationError('invalid', 'Turn belongs to another conversation');
  }
  return conversationJson({ record, events });
}

/** Ephemeral default. Inject a durable store to recover across process restarts. */
export class MemoryConversationStore implements ConversationStore {
  private readonly records = new Map<string, ConversationRecord>();
  private readonly turns = new Map<string, Map<string, ConversationTurn>>();
  private readonly events = new Map<string, ConversationEvent[]>();

  async create(record: ConversationRecord): Promise<void> {
    validateConversationSource(record.source);
    if (this.records.has(record.id)) throw new ConversationError('conflict', `Conversation "${record.id}" already exists`);
    this.records.set(record.id, conversationJson(record));
    this.turns.set(record.id, new Map());
    this.events.set(record.id, []);
  }
  async get(id: string) { const record = this.records.get(id); return record && conversationJson(record); }
  async list(options: ConversationListOptions = {}) {
    return conversationJson([...this.records.values()].filter(r => (!options.afterId || r.id > options.afterId) && matchesConversationSource(r, options.source))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, conversationPageSize(options.limit)));
  }
  async commit(input: ConversationCommit) {
    const result = prepareConversationCommit(this.records.get(input.record.id), input);
    const turns = this.turns.get(input.record.id)!;
    const changed = conversationJson(input.turns ?? []);
    const proposed = new Map(turns);
    for (const turn of changed) proposed.set(turn.id, turn);
    const keys = new Set<string>();
    const numbers = new Set<number>();
    for (const turn of proposed.values()) {
      if ((turn.idempotencyKey && keys.has(turn.idempotencyKey)) || numbers.has(turn.number)) {
        throw new ConversationError('conflict', 'Duplicate turn number or idempotency key');
      }
      if (turn.idempotencyKey) keys.add(turn.idempotencyKey);
      numbers.add(turn.number);
    }
    this.records.set(input.record.id, result.record);
    this.turns.set(input.record.id, proposed);
    this.events.get(input.record.id)!.push(...result.events);
    return conversationJson(result);
  }
  async getTurn(id: string, turnId: string) { const turn = this.turns.get(id)?.get(turnId); return turn && conversationJson(turn); }
  async findTurn(id: string, key: string) {
    const turn = [...(this.turns.get(id)?.values() ?? [])].find(t => t.idempotencyKey === key);
    return turn && conversationJson(turn);
  }
  async listTurns(id: string, options: ConversationReadOptions & { status?: ConversationTurnStatus } = {}): Promise<ConversationPage<ConversationTurn>> {
    const after = conversationCursor(options.after);
    return this.page([...(this.turns.get(id)?.values() ?? [])].filter(t => t.number > after && (!options.status || t.status === options.status))
      .sort((a, b) => a.number - b.number), options.limit, t => t.number);
  }
  async readEvents(id: string, options: ConversationReadOptions & { turnId?: string } = {}): Promise<ConversationPage<ConversationEvent>> {
    const after = conversationCursor(options.after);
    return this.page((this.events.get(id) ?? []).filter(e => e.sequence > after && (!options.turnId || e.turnId === options.turnId)), options.limit, e => e.sequence);
  }
  private page<T>(rows: T[], limit: number | undefined, cursor: (row: T) => number): ConversationPage<T> {
    const size = conversationPageSize(limit);
    const items = rows.slice(0, size);
    return conversationJson({ items, ...(rows.length > size ? { nextCursor: cursor(items.at(-1)!) } : {}) });
  }
}
