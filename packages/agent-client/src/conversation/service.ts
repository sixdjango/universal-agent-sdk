import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import { startAgentSession } from '../launcher/runner';
import { zContentBlock, type StartAgentSessionOptions } from '../types';
import { projectConversationMessages } from './messages';
import { ConversationError, conversationJson, isConversationTurnFinished, MemoryConversationStore } from './store';
import type {
  ConversationAgent, ConversationEvent, ConversationEventData, ConversationExtensions,
  ConversationJson, ConversationMessageInput, ConversationPermission, ConversationRecord, ConversationServiceOptions,
  ConversationSession, ConversationStore, ConversationTurn, NewConversationEvent, SendConversationInput, ConversationSource,
} from './types';

type PendingPermission = { resolve: (response: acp.RequestPermissionResponse) => void };
type Connection = {
  id: string; token: string; generation?: string; session?: ConversationSession;
  startup: AbortController; active?: { turnId: string; abort: AbortController; interrupt?: boolean };
  pending: Map<string, PendingPermission>; timer?: ReturnType<typeof setInterval>;
  worker?: Promise<void>; stop?: Promise<void>; fatal?: Error; disconnecting: boolean; pendingEvents: number;
};

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const cancelledResponse = (): acp.RequestPermissionResponse => ({ outcome: { outcome: 'cancelled' } });

/**
 * Transport-free, opt-in chat runtime. One leased native session per conversation; prompts are
 * durable FIFO turns. Flow execution and the existing ManagedAgentSession API are unchanged.
 */
export class ConversationService {
  readonly store: ConversationStore;
  private readonly options: ConversationServiceOptions;
  private readonly ownerId: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxPendingEvents: number;
  private readonly connections = new Map<string, Connection>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(event: ConversationEvent) => void>>();
  private shuttingDown = false;

  constructor(options: ConversationServiceOptions = {}) {
    this.options = options;
    this.store = options.store ?? new MemoryConversationStore();
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatMs = options.heartbeatIntervalMs ?? Math.floor(this.leaseMs / 3);
    this.maxPendingEvents = options.maxPendingEvents ?? 1024;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 30 || !Number.isSafeInteger(this.heartbeatMs) ||
      this.heartbeatMs < 1 || this.heartbeatMs >= this.leaseMs || !Number.isSafeInteger(this.maxPendingEvents) || this.maxPendingEvents < 1) {
      throw new ConversationError('invalid', 'Invalid lease, heartbeat or event buffer settings');
    }
  }

  async create(input: { id?: string; title?: string; agent: ConversationAgent; source?: ConversationSource; extensions?: ConversationExtensions }): Promise<ConversationRecord> {
    this.assertOpen();
    if (typeof input.agent?.workdir !== 'string' || !input.agent.workdir.trim() ||
      (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim())) ||
      (!input.agent.target && !input.agent.agentType)) throw new ConversationError('invalid', 'Conversation needs an Agent target, workdir and a nonempty id when supplied');
    const now = this.now();
    const record = conversationJson<ConversationRecord>({
      schemaVersion: 1, id: input.id ?? this.createId(), title: input.title, agent: input.agent, source: input.source,
      status: 'open', revision: 0, lastEventSequence: 0, lastTurnNumber: 0, queuePaused: false,
      createdAtMs: now, updatedAtMs: now, extensions: input.extensions ?? {},
    });
    await this.store.create(record);
    // Creation itself is durable even if writing its optional audit event fails.
    const result = await this.store.commit({ expectedRevision: 0, record, events: [{ data: { type: 'conversation.created' } }] });
    this.publish(result.events);
    return result.record;
  }

  async get(id: string): Promise<ConversationRecord> {
    const record = await this.store.get(id);
    if (!record) throw new ConversationError('not_found', `Conversation "${id}" does not exist`);
    return record;
  }

  /** Acquire ownership and connect without sending a prompt. */
  async connect(id: string): Promise<ConversationRecord> {
    const connection = await this.acquire(id);
    await this.start(connection);
    return this.get(id);
  }

  /** Persist before execution. Repeated keys return the same turn, including after a restart. */
  async send(id: string, input: SendConversationInput): Promise<ConversationTurn> {
    this.assertOpen();
    const value = conversationJson(input);
    if (!Array.isArray(value.content) || value.content.length === 0 || (value.idempotencyKey !== undefined && !value.idempotencyKey.trim())) {
      throw new ConversationError('invalid', 'A prompt needs content and a nonempty idempotency key when supplied');
    }
    this.validateContent(value.content);
    // Read-only retries do not need to steal another owner's live session.
    if (value.idempotencyKey) {
      const existing = await this.store.findTurn(id, value.idempotencyKey);
      if (existing) return this.checkDuplicate(existing, value);
    }
    const connection = await this.acquire(id);
    const turn = await this.change(connection, async record => {
      if (value.idempotencyKey) {
        const existing = await this.store.findTurn(id, value.idempotencyKey);
        if (existing) return { value: this.checkDuplicate(existing, value) };
      }
      const turn: ConversationTurn = {
        id: this.createId(), conversationId: id, number: record.lastTurnNumber + 1,
        ...value, extensions: value.extensions ?? {}, status: 'queued', createdAtMs: this.now(), permissions: [],
      };
      record.lastTurnNumber = turn.number;
      return { value: turn, turns: [turn], events: [{ turnId: turn.id, data: { type: 'turn.queued', turn } }] };
    });
    this.kick(connection);
    return turn;
  }

  private checkDuplicate(turn: ConversationTurn, input: SendConversationInput): ConversationTurn {
    if (canonical({ content: turn.content, promptOptions: turn.promptOptions, extensions: turn.extensions }) !==
        canonical({ content: input.content, promptOptions: input.promptOptions, extensions: input.extensions ?? {} })) {
      throw new ConversationError('conflict', 'Idempotency key was already used with different content');
    }
    return turn;
  }

  /** A failed/truncated/cancelled turn pauses the queue until the host explicitly resumes it. */
  async pause(id: string): Promise<void> {
    const connection = await this.acquire(id);
    await this.change(connection, record => { record.queuePaused = true; return { events: [{ data: { type: 'queue.paused' } }] }; });
  }
  async resume(id: string): Promise<void> {
    const connection = await this.acquire(id);
    await this.change(connection, record => { record.queuePaused = false; return { events: [{ data: { type: 'queue.resumed' } }] }; });
    this.kick(connection);
  }

  /**
   * Explicit crash recovery. Never steals a live lease or resends a started turn. Pending
   * permissions expire because native RPC continuations cannot survive process death.
   * The preserved queue stays paused; resume() sends only turns that never started.
   */
  async recover(id: string): Promise<ConversationRecord> {
    await this.acquire(id, true);
    return this.get(id);
  }

  async cancel(id: string, turnId: string): Promise<ConversationTurn> {
    const connection = await this.acquire(id);
    const turn = await this.change(connection, async record => {
      const turn = await this.requireTurn(id, turnId);
      if (isConversationTurnFinished(turn.status)) return { value: turn };
      turn.cancelRequestedAtMs = this.now();
      if (turn.status === 'queued') {
        turn.status = 'cancelled'; turn.endedAtMs = this.now();
        return { value: turn, turns: [turn], events: [{ turnId, data: { type: 'turn.finished', status: 'cancelled' } }] };
      }
      record.queuePaused = true;
      return { value: turn, turns: [turn], events: [{ turnId, data: { type: 'queue.paused' } }] };
    });
    if (connection.active?.turnId === turnId) {
      connection.active.abort.abort();
      await this.stopSession(connection);
      await connection.worker;
    }
    return this.requireTurn(id, turn.id);
  }

  async respondPermission(id: string, permissionId: string, response: acp.RequestPermissionResponse): Promise<void> {
    const value = conversationJson(response);
    const connection = this.connections.get(id);
    if (!connection || !connection.pending.has(permissionId)) throw new ConversationError('conflict', 'Permission is no longer awaiting a response in this process');
    await this.change(connection, async record => {
      if (!record.activeTurnId) throw new ConversationError('conflict', 'Permission turn has ended');
      const turn = await this.requireTurn(id, record.activeTurnId);
      const permission = turn.permissions.find(p => p.id === permissionId);
      if (!permission || permission.status !== 'pending' || turn.cancelRequestedAtMs !== undefined) throw new ConversationError('conflict', 'Permission is no longer pending');
      if (value.outcome?.outcome !== 'cancelled' && (value.outcome?.outcome !== 'selected' ||
        !permission.request.options.some(option => option.optionId === (value.outcome as { optionId: string }).optionId))) {
        throw new ConversationError('invalid', 'Permission response must select an offered option or cancel');
      }
      permission.response = value;
      permission.status = value.outcome.outcome === 'cancelled' ? 'cancelled' : 'answered';
      permission.resolvedAtMs = this.now();
      turn.status = turn.permissions.some(p => p.status === 'pending') ? 'waiting_permission' : 'running';
      return { turns: [turn], events: [{ turnId: turn.id, data: { type: 'permission.resolved', permission } }] };
    });
    connection.pending.get(permissionId)?.resolve(value);
    connection.pending.delete(permissionId);
  }

  /** Detach the process, preserving its native session id and unsent queue for later resume. */
  async disconnect(id: string): Promise<void> {
    const record = await this.store.get(id);
    if (record) this.assertChat(record);
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.disconnecting = true;
    clearInterval(connection.timer);
    connection.startup.abort();
    if (connection.active) { connection.active.interrupt = true; connection.active.abort.abort(); }
    await this.starts.get(id)?.catch(() => {});
    await this.stopSession(connection);
    await connection.worker;
    await this.lock(id, async () => {
      const record = await this.get(id);
      // Losing the lease only permits resource cleanup, never a write under the new owner.
      if (record.lease?.token !== connection.token || record.lease.expiresAtMs <= this.now()) return;
      record.queuePaused = true;
      delete record.lease;
      record.updatedAtMs = this.now();
      const result = await this.store.commit({ expectedRevision: record.revision, record, events: [{ data: { type: 'conversation.detached' } }] });
      this.publish(result.events);
    });
    this.connections.delete(id);
  }

  /** Permanently close the conversation; retained history remains readable. */
  async close(id: string): Promise<void> {
    const current = await this.get(id);
    this.assertChat(current);
    if (current.status === 'closed') return;
    const connection = await this.acquire(id);
    await this.pause(id);
    if (connection.active) await this.cancel(id, connection.active.turnId);
    connection.disconnecting = true;
    connection.startup.abort();
    await this.starts.get(id)?.catch(() => {});
    await this.stopSession(connection);
    await connection.worker;
    await this.change(connection, async record => {
      const turns: ConversationTurn[] = [];
      let after: number | undefined;
      do {
        const page = await this.store.listTurns(id, { after, status: 'queued', limit: 1000 });
        for (const turn of page.items) turns.push({ ...turn, status: 'cancelled', endedAtMs: this.now() });
        after = page.nextCursor;
      } while (after !== undefined);
      record.status = 'closed'; record.queuePaused = true; delete record.lease;
      return { turns, events: [...turns.map((turn): NewConversationEvent => ({ turnId: turn.id, data: { type: 'turn.finished', status: 'cancelled' } })), { data: { type: 'conversation.closed' } }] };
    });
    clearInterval(connection.timer);
    this.connections.delete(id);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const results = await Promise.allSettled([...this.connections.keys()].map(id => this.disconnect(id)));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'Some conversation sessions could not be shut down');
  }

  async update(id: string, patch: { title?: string; extensions?: ConversationExtensions }): Promise<ConversationRecord> {
    const value = conversationJson(patch);
    const connection = await this.acquire(id);
    await this.change(connection, record => {
      if (value.title !== undefined) record.title = value.title;
      if (value.extensions) record.extensions = { ...record.extensions, ...value.extensions };
      return { events: [{ data: { type: 'conversation.updated' } }] };
    });
    return this.get(id);
  }

  async appendMessage(id: string, message: ConversationMessageInput, turnId?: string): Promise<void> {
    if (!['user', 'assistant', 'system'].includes(message.role)) throw new ConversationError('invalid', 'Invalid message role');
    this.validateContent(message.content);
    await this.append(id, { type: 'message', message: conversationJson(message) }, turnId);
  }
  async appendCustomEvent(id: string, event: { namespace: string; name: string; data: ConversationJson }, turnId?: string): Promise<void> {
    if (!event.namespace.trim() || !event.name.trim()) throw new ConversationError('invalid', 'Custom events need a namespace and name');
    await this.append(id, { type: 'custom', ...conversationJson(event) }, turnId);
  }
  private async append(id: string, data: ConversationEventData, turnId?: string): Promise<void> {
    const connection = await this.acquire(id);
    await this.change(connection, async () => {
      if (turnId) await this.requireTurn(id, turnId);
      return { events: [{ turnId, data }] };
    });
  }

  /** Live events from this instance only. Durable cross-process consumption uses readEvents. */
  subscribe(id: string, listener: (event: ConversationEvent) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }

  async getMessages(id: string, turnId: string) {
    await this.requireTurn(id, turnId);
    const events: ConversationEvent[] = [];
    let after: number | undefined;
    do {
      const page = await this.store.readEvents(id, { turnId, after, limit: 1000 });
      events.push(...page.items); after = page.nextCursor;
    } while (after !== undefined);
    return projectConversationMessages(events);
  }

  async waitForTurn(id: string, turnId: string, options: { signal?: AbortSignal } = {}): Promise<ConversationTurn> {
    while (true) {
      options.signal?.throwIfAborted();
      const turn = await this.requireTurn(id, turnId);
      if (isConversationTurnFinished(turn.status)) return turn;
      const fatal = this.connections.get(id)?.fatal;
      if (fatal) throw fatal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(options.signal?.reason); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, 20);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
  }

  private assertOpen() { if (this.shuttingDown) throw new ConversationError('closed', 'Conversation service is shutting down'); }
  private assertChat(record: ConversationRecord) {
    if (record.mode === 'recording') throw new ConversationError('conflict', 'This conversation is controlled by its source execution; use the host to control it');
  }
  private validateContent(content: unknown): void {
    if (!Array.isArray(content) || !content.every(block => zContentBlock.safeParse(block).success)) {
      throw new ConversationError('invalid', 'Invalid ACP content blocks');
    }
  }
  private async requireTurn(id: string, turnId: string): Promise<ConversationTurn> {
    const turn = await this.store.getTurn(id, turnId);
    if (!turn) throw new ConversationError('not_found', `Turn "${turnId}" does not exist`);
    return turn;
  }
  private lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const settled = result.then(() => {}, () => {});
    this.locks.set(id, settled);
    void settled.then(() => { if (this.locks.get(id) === settled) this.locks.delete(id); });
    return result;
  }
  private publish(events: ConversationEvent[]) {
    for (const event of events) for (const listener of this.listeners.get(event.conversationId) ?? []) {
      try { listener(conversationJson(event)); } catch (error) { this.report(asError(error), event.conversationId); }
    }
  }
  private report(error: Error, id: string) { try { this.options.onError?.(error, id); } catch { /* diagnostics never affect execution */ } }

  private async acquire(id: string, recover = false): Promise<Connection> {
    this.assertOpen();
    return this.lock(id, async () => {
      const local = this.connections.get(id);
      if (local) {
        if (local.fatal) throw local.fatal;
        if (local.disconnecting) throw new ConversationError('busy', 'Conversation is disconnecting');
        if (recover) throw new ConversationError('busy', 'Conversation is already owned by this service');
        const current = await this.get(id);
        if (current.lease?.token !== local.token || current.lease.expiresAtMs <= this.now()) {
          const error = new ConversationError('lease_lost', 'Conversation lease expired or belongs to another owner');
          this.fail(local, error);
          throw error;
        }
        return local;
      }
      const record = await this.get(id);
      this.assertChat(record);
      if (record.status === 'closed') throw new ConversationError('closed', 'Conversation is closed');
      if (record.lease && record.lease.expiresAtMs > this.now()) throw new ConversationError('busy', 'Conversation is owned by another session');
      if ((record.lease || record.activeTurnId) && !recover) throw new ConversationError('recovery_required', 'Previous owner did not detach; call recover before continuing');
      const token = this.createId();
      const turns: ConversationTurn[] = [];
      const events: NewConversationEvent[] = [];
      if (record.activeTurnId) {
        const turn = await this.requireTurn(id, record.activeTurnId);
        turn.status = 'interrupted'; turn.error = 'Previous owner stopped before recording a terminal result'; turn.endedAtMs = this.now();
        this.resolveRecordedPermissions(turn, 'expired', events);
        turns.push(turn);
        events.push({ turnId: turn.id, data: { type: 'turn.finished', status: turn.status, error: turn.error } });
        delete record.activeTurnId;
      }
      if (recover) record.queuePaused = true;
      record.lease = { ownerId: this.ownerId, token, expiresAtMs: this.now() + this.leaseMs };
      record.updatedAtMs = this.now();
      const result = await this.store.commit({ expectedRevision: record.revision, record, turns, events });
      const connection: Connection = { id, token, startup: new AbortController(), pending: new Map(), disconnecting: false, pendingEvents: 0 };
      this.connections.set(id, connection);
      connection.timer = setInterval(() => {
        void this.change(connection, current => {
          current.lease!.expiresAtMs = this.now() + this.leaseMs; return {};
        }).catch(error => this.fail(connection, asError(error)));
      }, this.heartbeatMs);
      connection.timer.unref?.();
      this.publish(result.events);
      return connection;
    });
  }

  private change<T = void>(connection: Connection, mutate: (record: ConversationRecord) =>
    { value?: T; turns?: ConversationTurn[]; events?: NewConversationEvent[] } |
    Promise<{ value?: T; turns?: ConversationTurn[]; events?: NewConversationEvent[] }>): Promise<T> {
    return this.lock(connection.id, async () => {
      if (connection.fatal) throw connection.fatal;
      const record = await this.get(connection.id);
      if (record.lease?.token !== connection.token || record.lease.expiresAtMs <= this.now()) {
        throw new ConversationError('lease_lost', 'Conversation lease expired or belongs to another owner');
      }
      if (record.status === 'closed') throw new ConversationError('closed', 'Conversation is closed');
      const changed = await mutate(record);
      if (record.lease && record.lease.expiresAtMs <= this.now()) throw new ConversationError('lease_lost', 'Conversation lease expired during mutation');
      record.updatedAtMs = this.now();
      const result = await this.store.commit({ expectedRevision: record.revision, record, turns: changed.turns, events: changed.events });
      this.publish(result.events);
      return conversationJson({ value: changed.value }).value as T;
    });
  }

  private fail(connection: Connection, error: Error) {
    if (connection.fatal) return;
    connection.fatal = error;
    clearInterval(connection.timer);
    connection.startup.abort(); connection.active?.abort.abort();
    for (const pending of connection.pending.values()) pending.resolve(cancelledResponse());
    connection.pending.clear();
    this.report(error, connection.id);
    void this.stopSession(connection).catch(error => this.report(asError(error), connection.id));
  }

  private recordEvent(connection: Connection, generation: string, data: ConversationEventData, turnId = connection.active?.turnId) {
    if (connection.generation !== generation || connection.fatal || connection.disconnecting) return;
    try {
      if (++connection.pendingEvents > this.maxPendingEvents) throw new ConversationError('storage_failed', 'Conversation event writer cannot keep up');
      const event = conversationJson({ turnId, data });
      void this.change(connection, () => ({ events: [event] }))
        .catch(error => this.fail(connection, asError(error)))
        .finally(() => { connection.pendingEvents--; });
    } catch (error) { connection.pendingEvents--; this.fail(connection, asError(error)); }
  }

  private async start(connection: Connection): Promise<void> {
    if (connection.session) return;
    // start() can be entered by connect() and the background queue simultaneously.
    const existing = this.starts.get(connection.id);
    if (existing) return existing;
    const starting = this.startSession(connection);
    this.starts.set(connection.id, starting);
    try { await starting; } finally { this.starts.delete(connection.id); }
  }
  private readonly starts = new Map<string, Promise<void>>();

  private async startSession(connection: Connection): Promise<void> {
    const record = await this.get(connection.id);
    const extra = await this.options.resolveSessionOptions?.(record) ?? {};
    if (connection.disconnecting || connection.fatal) throw connection.fatal ?? new ConversationError('closed', 'Conversation is disconnecting');
    const generation = this.createId();
    connection.generation = generation;
    const onEvent = (name: string, data: unknown, callback?: () => void) => {
      this.recordEvent(connection, generation, { type: 'session.event', name, data: data as ConversationJson });
      try { callback?.(); } catch (error) { this.report(asError(error), connection.id); }
    };
    const options: StartAgentSessionOptions = {
      ...extra, ...record.agent, sessionId: record.id, resumeSessionId: record.nativeSessionId,
      forkSessionId: undefined, forkSessionTurnId: undefined, signal: connection.startup.signal,
      onUpdateMessage: notification => {
        this.recordEvent(connection, generation, { type: 'acp.update', notification, origin: connection.active ? 'live' : 'replay' });
        try { extra.onUpdateMessage?.(notification); } catch (error) { this.report(asError(error), connection.id); }
      },
      onRequestPermission: (requestId, request) => this.requestPermission(connection, generation, requestId, request, extra.onRequestPermission),
      onUsageUpdate: (usage, accountingId) => onEvent('usage', { usage, accountingId }, () => extra.onUsageUpdate?.(usage, accountingId)),
      onContextWindowUsageUpdate: usage => onEvent('context_window', usage, () => extra.onContextWindowUsageUpdate?.(usage)),
      onRateLimitUpdate: limits => onEvent('rate_limits', limits, () => extra.onRateLimitUpdate?.(limits)),
      onThreadGoalUpdated: goal => onEvent('goal', goal, () => extra.onThreadGoalUpdated?.(goal)),
      onThreadGoalCleared: threadId => onEvent('goal_cleared', { threadId }, () => extra.onThreadGoalCleared?.(threadId)),
      onSessionTitleUpdate: title => onEvent('title', { title }, () => extra.onSessionTitleUpdate?.(title)),
      onAgentWarning: warning => onEvent('warning', warning, () => extra.onAgentWarning?.(warning)),
      onImageGenerationBegin: event => onEvent('image_generation_begin', event, () => extra.onImageGenerationBegin?.(event)),
      onImageGenerationEnd: event => onEvent('image_generation_end', event, () => extra.onImageGenerationEnd?.(event)),
      onWriteTextFile: async evidence => {
        this.recordEvent(connection, generation, { type: 'session.event', name: 'file_write', data: evidence as unknown as ConversationJson });
        await extra.onWriteTextFile?.(evidence);
      },
    };
    let session: ConversationSession | undefined;
    try {
      // Verify ownership immediately before starting a process, not only when enqueueing.
      await this.change(connection, () => ({}));
      session = await (this.options.startSession ?? startAgentSession)(options);
      if (connection.disconnecting || connection.fatal) throw connection.fatal ?? new ConversationError('closed', 'Conversation disconnected during startup');
      if (record.nativeSessionId && session.acpSessionId !== record.nativeSessionId) throw new ConversationError('conflict', 'Agent resumed a different native session');
      await this.change(connection, current => {
        current.nativeSessionId = session!.acpSessionId;
        return { events: [{ data: { type: 'conversation.attached', detail: { nativeSessionId: session!.acpSessionId } } }] };
      });
      connection.session = session;
    } catch (error) {
      connection.generation = undefined;
      await session?.shutdown();
      throw error;
    }
  }

  private async requestPermission(connection: Connection, generation: string, requestId: string, request: acp.RequestPermissionRequest, policy?: StartAgentSessionOptions['onRequestPermission']): Promise<acp.RequestPermissionResponse> {
    if (connection.generation !== generation || !connection.active || connection.active.abort.signal.aborted) return cancelledResponse();
    const turnId = connection.active.turnId;
    const permission: ConversationPermission = conversationJson({
      id: this.createId(), requestId, turnId, request, status: 'pending', createdAtMs: this.now(),
    });
    const response = new Promise<acp.RequestPermissionResponse>(resolve => connection.pending.set(permission.id, { resolve }));
    try {
      await this.change(connection, async () => {
        const turn = await this.requireTurn(connection.id, turnId);
        if (isConversationTurnFinished(turn.status) || turn.cancelRequestedAtMs !== undefined) throw new ConversationError('conflict', 'Permission turn ended');
        turn.permissions.push(permission); turn.status = 'waiting_permission';
        return { turns: [turn], events: [{ turnId, data: { type: 'permission.requested', permission } }] };
      });
      if (this.options.onPermission || policy) {
        void Promise.resolve().then(async () => {
          const answer = this.options.onPermission
            ? await this.options.onPermission(permission, await this.get(connection.id))
            : await policy!(requestId, request);
          if (answer && connection.pending.has(permission.id)) await this.respondPermission(connection.id, permission.id, answer);
        }).catch(error => { if (connection.pending.has(permission.id)) this.fail(connection, asError(error)); });
      }
      return await response;
    } catch (error) {
      connection.pending.get(permission.id)?.resolve(cancelledResponse());
      connection.pending.delete(permission.id);
      if (!connection.active?.abort.signal.aborted && !connection.disconnecting) this.fail(connection, asError(error));
      return cancelledResponse();
    }
  }

  private kick(connection: Connection) {
    if (connection.worker || connection.disconnecting || connection.fatal) return;
    connection.worker = this.runQueue(connection).catch(error => this.fail(connection, asError(error))).finally(() => {
      connection.worker = undefined;
      // send() may commit after the final empty-queue read but before this finally.
      if (!connection.disconnecting && !connection.fatal) void this.get(connection.id).then(async record => {
        if (!record.queuePaused && (await this.store.listTurns(connection.id, { status: 'queued', limit: 1 })).items.length) this.kick(connection);
      }).catch(error => this.fail(connection, asError(error)));
    });
  }

  private async runQueue(connection: Connection): Promise<void> {
    while (!connection.disconnecting && !connection.fatal) {
      const record = await this.get(connection.id);
      if (record.queuePaused || record.status === 'closed') return;
      if (!(await this.store.listTurns(connection.id, { status: 'queued', limit: 1 })).items.length) return;
      try { await this.start(connection); } catch (error) {
        // No prompt has been sent. Keep queued inputs intact for an explicit retry.
        if (!connection.disconnecting && !connection.fatal) await this.change(connection, current => {
          current.queuePaused = true;
          return { events: [{ data: { type: 'session.event', name: 'connection_error', data: { message: asError(error).message } } }] };
        });
        this.report(asError(error), connection.id);
        return;
      }
      if (connection.disconnecting || connection.fatal) return;
      const turn = await this.change<ConversationTurn | undefined>(connection, async current => {
        if (current.queuePaused) return {};
        const turn = (await this.store.listTurns(connection.id, { status: 'queued', limit: 1 })).items[0];
        if (!turn) return {};
        turn.status = 'running'; turn.startedAtMs = this.now(); current.activeTurnId = turn.id;
        // Set before publishing turn.started so synchronous listeners can cancel safely.
        connection.active = { turnId: turn.id, abort: new AbortController() };
        return { value: turn, turns: [turn], events: [{ turnId: turn.id, data: { type: 'turn.started' } }] };
      });
      if (!turn) return;
      const active = connection.active!;
      let response: acp.PromptResponse | undefined;
      let error: Error | undefined;
      let removeAbort = () => {};
      try {
        const aborted = new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('Conversation turn interrupted'));
          active.abort.signal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => active.abort.signal.removeEventListener('abort', onAbort);
          if (active.abort.signal.aborted) onAbort();
        });
        // A signal-ignoring custom session cannot prevent local cancellation and cleanup.
        active.abort.signal.throwIfAborted();
        response = await Promise.race([connection.session!.prompt(turn.content, { ...turn.promptOptions, signal: active.abort.signal }), aborted]);
      } catch (caught) { error = asError(caught); }
      finally { removeAbort(); }
      if (active.abort.signal.aborted || error || response?.stopReason !== 'end_turn') await this.stopSession(connection);
      // All synchronous ACP callbacks enqueue commits before the prompt settles.
      await this.lock(connection.id, async () => {});
      if (connection.fatal) throw connection.fatal;
      await this.change(connection, async current => {
        const updated = await this.requireTurn(connection.id, turn.id);
        const stopReason = response?.stopReason;
        const status = active.interrupt ? 'interrupted' : updated.cancelRequestedAtMs !== undefined || stopReason === 'cancelled' ? 'cancelled' :
          error ? 'failed' : !response ? 'interrupted' : stopReason === 'end_turn' ? 'completed' :
          stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? 'truncated' : stopReason === 'refusal' ? 'refused' : 'failed';
        updated.status = status; updated.endedAtMs = this.now(); updated.stopReason = stopReason;
        updated.error = error?.message ?? (!response ? 'Agent ended without a prompt response' : status === 'failed' ? `Unknown stop reason: ${String(stopReason)}` : undefined);
        const events: NewConversationEvent[] = [];
        this.resolveRecordedPermissions(updated, 'cancelled', events);
        delete current.activeTurnId;
        if (status !== 'completed' || connection.disconnecting) current.queuePaused = true;
        events.push({ turnId: turn.id, data: { type: 'turn.finished', status, stopReason, error: updated.error, response } });
        return { turns: [updated], events };
      });
      connection.active = undefined;
      for (const pending of connection.pending.values()) pending.resolve(cancelledResponse());
      connection.pending.clear();
    }
  }

  private resolveRecordedPermissions(turn: ConversationTurn, status: 'expired' | 'cancelled', events: NewConversationEvent[]) {
    for (const permission of turn.permissions) if (permission.status === 'pending') {
      permission.status = status; permission.resolvedAtMs = this.now(); permission.response = cancelledResponse();
      events.push({ turnId: turn.id, data: { type: 'permission.resolved', permission } });
    }
  }

  private async stopSession(connection: Connection): Promise<void> {
    if (connection.stop) return connection.stop;
    const session = connection.session;
    connection.generation = undefined;
    connection.session = undefined;
    for (const pending of connection.pending.values()) pending.resolve(cancelledResponse());
    connection.pending.clear();
    if (!session) return;
    connection.stop = session.shutdown();
    try { await connection.stop; } finally { connection.stop = undefined; }
  }
}
