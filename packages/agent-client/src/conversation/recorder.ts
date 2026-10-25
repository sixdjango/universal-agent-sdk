import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { StartAgentSessionOptions } from '../types';
import { ConversationError, conversationJson } from './store';
import type {
  ConversationAgent, ConversationEventData, ConversationExtensions, ConversationJson,
  ConversationPermission, ConversationRecord, ConversationSource, ConversationStore,
  ConversationTurn, ConversationTurnStatus, NewConversationEvent,
} from './types';

export interface ConversationRecorderOptions {
  store: ConversationStore;
  agent: ConversationAgent;
  source: ConversationSource;
  content: acp.ContentBlock[];
  extensions?: ConversationExtensions;
  signal?: AbortSignal;
  /** Bounds queued callbacks, never message size or total history. Overflow fails execution. */
  maxPendingEvents?: number;
}

/**
 * Records one externally scheduled execution in the same store as chats. It never starts an
 * Agent, retries, queues prompts or acquires a chat lease. The caller owns session cleanup.
 * Use a fresh recorder for every invocation, including retries and resumed native sessions.
 */
export class ConversationRecorder {
  readonly conversationId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  private readonly abort = new AbortController();
  private record: ConversationRecord;
  private turn: ConversationTurn;
  private writes: Promise<void> = Promise.resolve();
  private fatal?: Error;
  private pendingEvents = 0;
  private accepting = true;
  private running = false;
  private prompting = false;
  private response?: acp.PromptResponse;
  private readonly maxPendingEvents: number;

  private constructor(private readonly options: ConversationRecorderOptions) {
    this.conversationId = randomUUID();
    this.turnId = randomUUID();
    this.signal = options.signal ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal;
    this.maxPendingEvents = options.maxPendingEvents ?? 1024;
    if (!Number.isSafeInteger(this.maxPendingEvents) || this.maxPendingEvents < 1) throw new ConversationError('invalid', 'Invalid event buffer size');
    const now = Date.now();
    this.record = conversationJson({
      schemaVersion: 1, id: this.conversationId, agent: options.agent, mode: 'recording', source: options.source,
      status: 'open', revision: 0, lastEventSequence: 0, lastTurnNumber: 1,
      activeTurnId: this.turnId, queuePaused: true, createdAtMs: now, updatedAtMs: now,
      extensions: options.extensions ?? {},
    });
    this.turn = conversationJson({
      id: this.turnId, conversationId: this.conversationId, number: 1, content: options.content,
      status: 'running', createdAtMs: now, startedAtMs: now, permissions: [], extensions: {},
    });
  }

  static async create(options: ConversationRecorderOptions): Promise<ConversationRecorder> {
    const recorder = new ConversationRecorder(options);
    await options.store.create(recorder.record);
    await recorder.commit([
      { data: { type: 'conversation.created' } },
      { turnId: recorder.turnId, data: { type: 'turn.queued', turn: { ...recorder.turn, status: 'queued' } } },
      { turnId: recorder.turnId, data: { type: 'turn.started' } },
    ], true);
    return recorder;
  }

  /** Run the caller's entire lifecycle, including shutdown, before recording the terminal state. */
  async run<T>(execute: () => Promise<T>): Promise<T> {
    if (this.running) throw new ConversationError('conflict', 'Recorder executions cannot be reused');
    this.running = true;
    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      this.signal.throwIfAborted();
      result = await execute();
      this.signal.throwIfAborted();
    } catch (error) { failure = error; failed = true; }
    this.accepting = false;
    await this.writes;
    if (this.fatal) { failure = this.fatal; failed = true; }
    const cancelled = this.options.signal?.aborted || (!this.fatal &&
      (this.response?.stopReason === 'cancelled' || (failure instanceof Error && failure.name === 'AbortError')));
    let status: ConversationTurnStatus = 'failed';
    if (cancelled) status = 'cancelled';
    else if (!this.fatal && (this.response?.stopReason === 'max_tokens' || this.response?.stopReason === 'max_turn_requests')) status = 'truncated';
    else if (!this.fatal && this.response?.stopReason === 'refusal') status = 'refused';
    else if (!failed && this.response?.stopReason === 'end_turn') status = 'completed';
    if (!failed && status !== 'completed') {
      failure = cancelled ? new DOMException('Agent execution cancelled', 'AbortError') : new Error(`Agent execution ended without end_turn (${this.response?.stopReason ?? 'missing response'})`);
      failed = true;
    }
    // Re-read after a failed write: local mutations may not have committed. A persistent
    // store failure is propagated, never replaced with a successful execution result.
    this.record = (await this.options.store.get(this.conversationId))!;
    this.turn = (await this.options.store.getTurn(this.conversationId, this.turnId))!;
    const events: NewConversationEvent[] = [];
    for (const permission of this.turn.permissions.filter(p => p.status === 'pending')) {
      permission.status = cancelled ? 'cancelled' : 'expired';
      permission.resolvedAtMs = Date.now();
      if (cancelled) permission.response = { outcome: { outcome: 'cancelled' } };
      events.push({ turnId: this.turnId, data: { type: 'permission.resolved', permission } });
    }
    this.turn.status = status;
    this.turn.endedAtMs = Date.now();
    this.turn.stopReason = this.response?.stopReason;
    if (cancelled) this.turn.cancelRequestedAtMs = this.turn.endedAtMs;
    if (failed) this.turn.error = failure instanceof Error ? failure.message : String(failure);
    this.record.status = 'closed';
    delete this.record.activeTurnId;
    events.push({ turnId: this.turnId, data: { type: 'turn.finished', status, stopReason: this.turn.stopReason, error: this.turn.error, response: this.response } },
      { data: { type: 'conversation.closed' } });
    await this.commit(events, true);
    if (failed) throw failure;
    return result as T;
  }

  async attach(session: { sessionId?: string; acpSessionId: string }, resumedFrom?: string): Promise<void> {
    await this.write(async () => {
      this.record.nativeSessionId = session.acpSessionId;
      await this.commit([{ data: { type: 'conversation.attached', detail: {
        sessionId: session.sessionId ?? null, nativeSessionId: session.acpSessionId, resumedFrom: resumedFrom ?? null,
      } } }]);
    });
  }

  /** Startup/load history is replay; only notifications after this point belong to this turn. */
  beginPrompt(): void { this.signal.throwIfAborted(); this.prompting = true; }
  setResponse(response: acp.PromptResponse | undefined): void { this.response = conversationJson({ response }).response; }

  wrapSessionOptions(options: StartAgentSessionOptions): StartAgentSessionOptions {
    const event = (name: string, data: unknown, callback?: () => void) => {
      this.capture({ type: 'session.event', name, data: data as ConversationJson });
      callback?.();
    };
    return {
      ...options, signal: this.signal,
      onUpdateMessage: notification => {
        this.capture({ type: 'acp.update', notification, origin: this.prompting ? 'live' : 'replay' }, this.prompting ? this.turnId : null);
        options.onUpdateMessage?.(notification);
      },
      onRequestPermission: (requestId, request) => this.permission(requestId, request, options.onRequestPermission),
      onUsageUpdate: (usage, accountingId) => event('usage', { usage, accountingId }, () => options.onUsageUpdate?.(usage, accountingId)),
      onContextWindowUsageUpdate: usage => event('context_window', usage, () => options.onContextWindowUsageUpdate?.(usage)),
      onRateLimitUpdate: limits => event('rate_limits', limits, () => options.onRateLimitUpdate?.(limits)),
      onThreadGoalUpdated: goal => event('goal', goal, () => options.onThreadGoalUpdated?.(goal)),
      onThreadGoalCleared: threadId => event('goal_cleared', { threadId }, () => options.onThreadGoalCleared?.(threadId)),
      onSessionTitleUpdate: title => event('title', { title }, () => options.onSessionTitleUpdate?.(title)),
      onAgentWarning: warning => event('warning', warning, () => options.onAgentWarning?.(warning)),
      onImageGenerationBegin: value => event('image_generation_begin', value, () => options.onImageGenerationBegin?.(value)),
      onImageGenerationEnd: value => event('image_generation_end', value, () => options.onImageGenerationEnd?.(value)),
      onStartupStage: value => event('startup', value, () => options.onStartupStage?.(value)),
      onWriteTextFile: async evidence => {
        this.capture({ type: 'session.event', name: 'file_write', data: evidence as unknown as ConversationJson });
        await options.onWriteTextFile?.(evidence);
      },
    };
  }

  private capture(data: ConversationEventData, turnId: string | null = this.turnId) {
    if (!this.accepting || this.fatal) return;
    try {
      if (this.pendingEvents >= this.maxPendingEvents) throw new ConversationError('storage_failed', 'Conversation event writer cannot keep up');
      // Clone before returning to the producer, which may reuse/mutate its notification.
      const entry = conversationJson({ turnId: turnId ?? undefined, data });
      this.pendingEvents++;
      void this.write(() => this.commit([entry])).catch(() => {}).finally(() => { this.pendingEvents--; });
    } catch (error) { this.fail(error); }
  }

  private async permission(requestId: string, request: acp.RequestPermissionRequest, policy: StartAgentSessionOptions['onRequestPermission']): Promise<acp.RequestPermissionResponse> {
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (!this.accepting || this.signal.aborted) return cancelled;
    const permission = conversationJson<ConversationPermission>({
      id: randomUUID(), requestId, turnId: this.turnId, request, status: 'pending', createdAtMs: Date.now(),
    });
    await this.write(async () => {
      this.turn.permissions.push(permission);
      this.turn.status = 'waiting_permission';
      await this.commit([{ turnId: this.turnId, data: { type: 'permission.requested', permission } }], true);
    });
    let abortListener: (() => void) | undefined;
    let response: acp.RequestPermissionResponse;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => this.signal.aborted ? cancelled : policy(requestId, request)),
        new Promise<acp.RequestPermissionResponse>(resolve => {
          abortListener = () => resolve(cancelled);
          this.signal.addEventListener('abort', abortListener, { once: true });
          if (this.signal.aborted) abortListener();
        }),
      ]);
    } finally { if (abortListener) this.signal.removeEventListener('abort', abortListener); }
    if (!this.accepting || this.fatal) return cancelled;
    const value = conversationJson(response);
    await this.write(async () => {
      permission.response = value;
      permission.status = value.outcome.outcome === 'cancelled' ? 'cancelled' : 'answered';
      permission.resolvedAtMs = Date.now();
      this.turn.status = this.turn.permissions.some(p => p.status === 'pending') ? 'waiting_permission' : 'running';
      await this.commit([{ turnId: this.turnId, data: { type: 'permission.resolved', permission } }], true);
    });
    return value;
  }

  private fail(error: unknown) {
    this.fatal ??= error instanceof Error ? error : new Error(String(error));
    this.abort.abort(this.fatal);
  }
  private write(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(async () => { if (this.fatal) throw this.fatal; await operation(); });
    this.writes = result.catch(error => this.fail(error));
    return result;
  }
  private async commit(events: NewConversationEvent[], saveTurn = false): Promise<void> {
    const result = await this.options.store.commit(conversationJson({
      expectedRevision: this.record.revision, record: { ...this.record, updatedAtMs: Date.now() },
      ...(saveTurn ? { turns: [this.turn] } : {}), events,
    }));
    this.record = result.record;
  }
}
