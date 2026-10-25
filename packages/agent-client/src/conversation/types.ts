import type * as acp from '@agentclientprotocol/sdk';
import type { AcpSessionNotification, ManagedAgentSession, StartAgentSessionOptions } from '../types';

export type ConversationJson = null | boolean | number | string | ConversationJson[] | { [key: string]: ConversationJson };
/** Hosts own their namespaces, e.g. { 'symphony.task': { issueId: '123' } }. */
export type ConversationExtensions = Record<string, ConversationJson>;

/** Immutable, host-defined execution identity. The conversation layer does not interpret it. */
export interface ConversationSource {
  namespace: string;
  identifiers: Record<string, string>;
}
export interface ConversationListOptions {
  afterId?: string;
  limit?: number;
  /** Matches namespace and every supplied identifier; omitted identifiers are unrestricted. */
  source?: { namespace: string; identifiers?: Record<string, string> };
}

/** Persistable launch settings. Secrets and host callbacks belong in resolveSessionOptions. */
export type ConversationAgent = Pick<StartAgentSessionOptions,
  'workdir' | 'target' | 'agentType' | 'customCommand' | 'initialConfig' | 'modelId' | 'modeId' |
  'configOptionValues' | 'mcpServers' | 'providerId' | 'extraArgs' | 'piExtensions'>;

export interface ConversationLease {
  ownerId: string;
  /** Changes on every acquisition, including acquisition by the same owner. */
  token: string;
  expiresAtMs: number;
}

export interface ConversationRecord<E extends ConversationExtensions = ConversationExtensions> {
  schemaVersion: 1;
  id: string;
  title?: string;
  agent: ConversationAgent;
  /** Omitted on older records means chat. Recording lifecycles belong to the embedding host. */
  mode?: 'chat' | 'recording';
  source?: ConversationSource;
  status: 'open' | 'closed';
  revision: number;
  lastEventSequence: number;
  lastTurnNumber: number;
  nativeSessionId?: string;
  lease?: ConversationLease;
  activeTurnId?: string;
  queuePaused: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  extensions: E;
}

export type ConversationTurnStatus = 'queued' | 'running' | 'waiting_permission' |
  'completed' | 'cancelled' | 'truncated' | 'refused' | 'failed' | 'interrupted';

export interface ConversationPermission {
  id: string;
  requestId: string;
  turnId: string;
  request: acp.RequestPermissionRequest;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  response?: acp.RequestPermissionResponse;
  createdAtMs: number;
  resolvedAtMs?: number;
}

export interface ConversationTurn<E extends ConversationExtensions = ConversationExtensions> {
  id: string;
  conversationId: string;
  number: number;
  idempotencyKey?: string;
  content: acp.ContentBlock[];
  promptOptions?: Pick<NonNullable<Parameters<ManagedAgentSession['prompt']>[1]>, '_meta' | 'goalControl'>;
  status: ConversationTurnStatus;
  createdAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  cancelRequestedAtMs?: number;
  stopReason?: string;
  error?: string;
  permissions: ConversationPermission[];
  extensions: E;
}

export interface ConversationMessageInput {
  role: 'user' | 'assistant' | 'system';
  content: acp.ContentBlock[];
  extensions?: ConversationExtensions;
}

export type ConversationEventData =
  | { type: 'conversation.created' | 'conversation.attached' | 'conversation.detached' |
      'conversation.closed' | 'queue.paused' | 'queue.resumed' | 'conversation.updated'; detail?: ConversationJson }
  | { type: 'turn.queued'; turn: ConversationTurn }
  | { type: 'turn.started' }
  | { type: 'turn.finished'; status: ConversationTurnStatus; stopReason?: string; error?: string; response?: acp.PromptResponse }
  | { type: 'acp.update'; notification: AcpSessionNotification; origin: 'live' | 'replay' }
  | { type: 'permission.requested' | 'permission.resolved'; permission: ConversationPermission }
  | { type: 'session.event'; name: string; data: ConversationJson }
  | { type: 'message'; message: ConversationMessageInput }
  | { type: 'custom'; namespace: string; name: string; data: ConversationJson };

export interface ConversationEvent {
  conversationId: string;
  sequence: number;
  timestampMs: number;
  turnId?: string;
  data: ConversationEventData;
}

export type NewConversationEvent = Pick<ConversationEvent, 'turnId' | 'data'>;
export interface ConversationPage<T> { items: T[]; nextCursor?: number }
export interface ConversationReadOptions { after?: number; limit?: number }

export interface ConversationCommit {
  expectedRevision: number;
  record: ConversationRecord;
  turns?: ConversationTurn[];
  events?: NewConversationEvent[];
}

/**
 * Every commit atomically CASes the record, upserts the changed turns, and appends events.
 * Implementations must return detached JSON values and enforce (conversationId, idempotencyKey)
 * uniqueness. Never replace prior events. No callback or Agent execution runs in a transaction.
 * list() applies source filters before pagination; source and execution mode are immutable.
 */
export interface ConversationStore {
  create(record: ConversationRecord): Promise<void>;
  get(id: string): Promise<ConversationRecord | undefined>;
  list(options?: ConversationListOptions): Promise<ConversationRecord[]>;
  commit(input: ConversationCommit): Promise<{ record: ConversationRecord; events: ConversationEvent[] }>;
  getTurn(id: string, turnId: string): Promise<ConversationTurn | undefined>;
  findTurn(id: string, idempotencyKey: string): Promise<ConversationTurn | undefined>;
  listTurns(id: string, options?: ConversationReadOptions & { status?: ConversationTurnStatus }): Promise<ConversationPage<ConversationTurn>>;
  readEvents(id: string, options?: ConversationReadOptions & { turnId?: string }): Promise<ConversationPage<ConversationEvent>>;
}

export type ConversationSession = Pick<ManagedAgentSession, 'acpSessionId' | 'prompt' | 'cancel' | 'shutdown'>;
export type ConversationSessionFactory = (options: StartAgentSessionOptions) => Promise<ConversationSession>;

export interface ConversationServiceOptions {
  store?: ConversationStore;
  startSession?: ConversationSessionFactory;
  /** Supplies host credentials, process configuration and existing Client callbacks at connection time. */
  resolveSessionOptions?: (conversation: ConversationRecord) => Partial<StartAgentSessionOptions> | Promise<Partial<StartAgentSessionOptions>>;
  /** Return a response to automate a permission, or undefined to leave it pending for respondPermission. */
  onPermission?: (permission: ConversationPermission, conversation: ConversationRecord) =>
    acp.RequestPermissionResponse | void | Promise<acp.RequestPermissionResponse | void>;
  onError?: (error: Error, conversationId: string) => void;
  ownerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  /** Backpressure protection for synchronous ACP callbacks; never truncates message contents. */
  maxPendingEvents?: number;
  now?: () => number;
  createId?: () => string;
}

export interface SendConversationInput {
  content: acp.ContentBlock[];
  idempotencyKey?: string;
  promptOptions?: ConversationTurn['promptOptions'];
  extensions?: ConversationExtensions;
}
