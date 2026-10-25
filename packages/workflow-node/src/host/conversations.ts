import { ConversationService, type ConversationServiceOptions, type ConversationStore } from '@universal-agent/client';
import type { WorkflowDatabase } from '../store/sqlite/database';
import { SqliteConversationStore } from '../store/sqlite/sqlite-conversation-store';

/** Node's default durable assembly; works without a Flow runtime, HTTP server or Symphony. */
export function createNodeConversationService(options: ConversationServiceOptions & { db: WorkflowDatabase }): ConversationService {
  const { db, ...service } = options;
  return new ConversationService({ ...service, store: service.store ?? new SqliteConversationStore({ db }) });
}

/** Find every actual Agent call, including failed calls whose Flow receipt has no session. */
export function listWorkflowConversations(store: ConversationStore, query: {
  runId: string; scopeKey?: string; nodeId?: string; attemptId?: string; invocationId?: string;
  retryIndex?: number; roundIndex?: number; afterId?: string; limit?: number;
}) {
  const { afterId, limit, ...fields } = query;
  return store.list({ afterId, limit, source: { namespace: 'workflow', identifiers:
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])),
  } });
}

export { ConversationService, ConversationError } from '@universal-agent/client';
export type {
  ConversationAgent, ConversationRecord, ConversationTurn, ConversationPermission, ConversationMessage,
  ConversationEvent, ConversationStore, ConversationServiceOptions, SendConversationInput,
  ConversationSource, ConversationListOptions,
} from '@universal-agent/client';
