import {
  ConversationError, conversationCursor, conversationJson, conversationPageSize, prepareConversationCommit,
  validateConversationSource, type ConversationListOptions,
  type ConversationCommit, type ConversationEvent, type ConversationPage, type ConversationReadOptions,
  type ConversationRecord, type ConversationStore, type ConversationTurn, type ConversationTurnStatus,
} from '@universal-agent/client';
import { and, asc, eq, gt, exists } from 'drizzle-orm';
import type { WorkflowDatabase } from './database';
import { conversationEvents, conversations, conversationTurns, conversationSources } from './schema';

/** Durable ConversationStore. Ownership, queue changes and event append share one transaction. */
export class SqliteConversationStore implements ConversationStore {
  constructor(private readonly options: { db: WorkflowDatabase }) {}

  async create(record: ConversationRecord): Promise<void> {
    validateConversationSource(record.source);
    this.options.db.transaction(tx => {
      if (tx.select().from(conversations).where(eq(conversations.id, record.id)).get()) throw new ConversationError('conflict', 'Conversation already exists');
      tx.insert(conversations).values({ id: record.id, record: conversationJson(record) }).run();
      if (record.source) for (const [key, value] of Object.entries(record.source.identifiers)) {
        tx.insert(conversationSources).values({ conversationId: record.id, namespace: record.source.namespace, key, value }).run();
      }
    }, { behavior: 'immediate' });
  }
  async get(id: string): Promise<ConversationRecord | undefined> {
    return this.options.db.select().from(conversations).where(eq(conversations.id, id)).get()?.record as ConversationRecord | undefined;
  }
  async list(options: ConversationListOptions = {}): Promise<ConversationRecord[]> {
    const conditions = [options.afterId === undefined ? undefined : gt(conversations.id, options.afterId)];
    if (options.source) {
      const identifiers = Object.entries(options.source.identifiers ?? {});
      const base = [eq(conversationSources.conversationId, conversations.id), eq(conversationSources.namespace, options.source.namespace)];
      if (identifiers.length === 0) conditions.push(exists(this.options.db.select().from(conversationSources).where(and(...base))));
      for (const [key, value] of identifiers) conditions.push(exists(this.options.db.select().from(conversationSources)
        .where(and(...base, eq(conversationSources.key, key), eq(conversationSources.value, value)))));
    }
    return this.options.db.select().from(conversations)
      .where(and(...conditions))
      .orderBy(asc(conversations.id)).limit(conversationPageSize(options.limit)).all().map(row => row.record as ConversationRecord);
  }
  async commit(input: ConversationCommit) {
    return this.options.db.transaction(tx => {
      const current = tx.select().from(conversations).where(eq(conversations.id, input.record.id)).get()?.record as ConversationRecord | undefined;
      const result = prepareConversationCommit(current, input);
      for (const turn of conversationJson(input.turns ?? [])) {
        if (turn.idempotencyKey) {
          const duplicate = tx.select().from(conversationTurns).where(and(eq(conversationTurns.conversationId, turn.conversationId), eq(conversationTurns.idempotencyKey, turn.idempotencyKey))).get();
          if (duplicate && duplicate.id !== turn.id) throw new ConversationError('conflict', 'Duplicate idempotency key');
        }
        const row = { conversationId: turn.conversationId, id: turn.id, number: turn.number, status: turn.status, idempotencyKey: turn.idempotencyKey ?? null, record: turn };
        tx.insert(conversationTurns).values(row).onConflictDoUpdate({ target: [conversationTurns.conversationId, conversationTurns.id], set: row }).run();
      }
      // One insert per event avoids SQLite's variable limit for large atomic close/recovery operations.
      for (const event of result.events) tx.insert(conversationEvents).values({
        conversationId: event.conversationId, sequence: event.sequence, turnId: event.turnId ?? null, event,
      }).run();
      tx.update(conversations).set({ record: result.record }).where(eq(conversations.id, input.record.id)).run();
      return result;
    }, { behavior: 'immediate' });
  }
  async getTurn(id: string, turnId: string): Promise<ConversationTurn | undefined> {
    return this.options.db.select().from(conversationTurns).where(and(eq(conversationTurns.conversationId, id), eq(conversationTurns.id, turnId))).get()?.record as ConversationTurn | undefined;
  }
  async findTurn(id: string, key: string): Promise<ConversationTurn | undefined> {
    return this.options.db.select().from(conversationTurns).where(and(eq(conversationTurns.conversationId, id), eq(conversationTurns.idempotencyKey, key))).get()?.record as ConversationTurn | undefined;
  }
  async listTurns(id: string, options: ConversationReadOptions & { status?: ConversationTurnStatus } = {}): Promise<ConversationPage<ConversationTurn>> {
    const limit = conversationPageSize(options.limit);
    const rows = this.options.db.select().from(conversationTurns).where(and(
      eq(conversationTurns.conversationId, id), gt(conversationTurns.number, conversationCursor(options.after)),
      options.status ? eq(conversationTurns.status, options.status) : undefined,
    )).orderBy(asc(conversationTurns.number)).limit(limit + 1).all().map(row => row.record as ConversationTurn);
    return { items: rows.slice(0, limit), ...(rows.length > limit ? { nextCursor: rows[limit - 1].number } : {}) };
  }
  async readEvents(id: string, options: ConversationReadOptions & { turnId?: string } = {}): Promise<ConversationPage<ConversationEvent>> {
    const limit = conversationPageSize(options.limit);
    const rows = this.options.db.select().from(conversationEvents).where(and(
      eq(conversationEvents.conversationId, id), gt(conversationEvents.sequence, conversationCursor(options.after)),
      options.turnId ? eq(conversationEvents.turnId, options.turnId) : undefined,
    )).orderBy(asc(conversationEvents.sequence)).limit(limit + 1).all().map(row => row.event as ConversationEvent);
    return { items: rows.slice(0, limit), ...(rows.length > limit ? { nextCursor: rows[limit - 1].sequence } : {}) };
  }
}
