import type { WorkflowDefinition } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';
import type {
  AgentListing,
  AgentRuntimeInfo,
  CanvasLayout,
  ConversationReader,
  NodeDataReader,
  NodeDataRecord,
  WorkspaceIsolation,
  WorkspaceRecord,
} from '@universal-agent/workflow-ui';

export type { AgentListing, AgentRuntimeInfo, CanvasLayout, WorkspaceIsolation, WorkspaceRecord };

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  digest: string;
  updatedAtMs: number;
}

export interface WorkflowRecord extends WorkflowSummary {
  definition: WorkflowDefinition;
  layout: CanvasLayout;
  /** Workspace id each slot binds to by default (the last run's choice). */
  workspaceBindings: Record<string, string>;
  versions: { digest: string; createdAtMs: number }[];
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await fetch(`./api${path}`, {
    ...init,
    headers: init?.json !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as { error?: string; details?: unknown };
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? `Request failed (${response.status})`, body.details);
  }
  return body as T;
}

export const api = {
  listWorkflows: () => request<{ workflows: WorkflowSummary[] }>('/workflows').then((r) => r.workflows),
  getWorkflow: (id: string) => request<WorkflowRecord>(`/workflows/${encodeURIComponent(id)}`),
  createWorkflow: (definition: unknown, layout?: CanvasLayout) =>
    request<WorkflowRecord>('/workflows', { method: 'POST', json: { definition, ...(layout ? { layout } : {}) } }),
  updateWorkflow: (definition: WorkflowDefinition, layout?: CanvasLayout) =>
    request<WorkflowRecord>(`/workflows/${encodeURIComponent(definition.id)}`, {
      method: 'PUT',
      json: { definition, ...(layout ? { layout } : {}) },
    }),
  saveLayout: (id: string, layout: CanvasLayout) =>
    request<void>(`/workflows/${encodeURIComponent(id)}/layout`, { method: 'PUT', json: layout }),
  loadSample: () => request<WorkflowRecord>('/samples', { method: 'POST', json: {} }),
  listAgents: () => request<{ agents: AgentListing[] }>('/agents').then((r) => r.agents),
  listRuntimes: () => request<{ runtimes: AgentRuntimeInfo[] }>('/runtimes').then((r) => r.runtimes),
  refreshRuntime: (agentType: string) =>
    request<{ runtime: AgentRuntimeInfo }>(`/runtimes/${encodeURIComponent(agentType)}/refresh`, { method: 'POST', json: {} }).then(
      (r) => r.runtime
    ),
  listRuns: (workflowId: string) =>
    request<{ runs: RunSummary[] }>(`/runs?workflowId=${encodeURIComponent(workflowId)}&limit=20`).then(
      (r) => r.runs
    ),
  startRun: (workflowId: string, inputs: Record<string, unknown>, workspaces: Record<string, string> = {}) =>
    request<{ runId: string }>('/runs', { method: 'POST', json: { workflowId, inputs, workspaces } }),
  listWorkspaces: () => request<{ workspaces: WorkspaceRecord[]; defaultWorkspaceId: string }>('/workspaces'),
  createWorkspace: (input: { name?: string; path: string; isolation?: WorkspaceIsolation }) =>
    request<WorkspaceRecord>('/workspaces', { method: 'POST', json: input }),
  updateWorkspace: (id: string, patch: { name?: string; path?: string; isolation?: WorkspaceIsolation }) =>
    request<WorkspaceRecord>(`/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch }),
  deleteWorkspace: (id: string) => request<void>(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  respond: (runId: string, requestId: string, answer: string | Record<string, unknown>) =>
    request<void>(`/runs/${encodeURIComponent(runId)}/respond`, {
      method: 'POST',
      json: { requestId, answer, responderId: 'web' },
    }),
  messageChief: (runId: string, text: string) =>
    request<{ messageId: string }>(`/runs/${encodeURIComponent(runId)}/chief/messages`, { method: 'POST', json: { text } }),
  cancelRun: (runId: string) => request<void>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  rerun: (runId: string, nodeId: string, scopeKey?: string) =>
    request<void>(`/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST', json: { nodeId, ...(scopeKey ? { scopeKey } : {}) } }),
  forkRun: (runId: string, nodeId: string) =>
    request<{ runId: string; fromNodeId: string; inherited: string[] }>(`/runs/${encodeURIComponent(runId)}/fork`, { method: 'POST', json: { nodeId } }),
  readArtifact: (artifactId: string) =>
    request<{ meta: { mediaType: string; sizeBytes: number; summary?: string }; slice: { content: string; hasMore: boolean } }>(
      `/artifacts/${encodeURIComponent(artifactId)}`
    ),
};

const queryString = (values: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();

/** Read-only bridge. Scheduling, retry and permission decisions remain in Flow. */
/** Loads what steps saved (`GET /api/runs/:id/data`). */
export const nodeDataReader: NodeDataReader = {
  list: (query, signal) =>
    request<{ records: NodeDataRecord[] }>(
      `/runs/${encodeURIComponent(query.runId)}/data?${queryString({
        ...(query.nodeId ? { nodeId: query.nodeId } : {}),
        ...(query.scopeKey ? { scopeKey: query.scopeKey } : {}),
        ...(query.namespace ? { namespace: query.namespace } : {}),
      })}`,
      { signal }
    ).then((r) => r.records),
};

export const conversationReader: ConversationReader = {
  list: (target, page, signal) => request<{ conversations: Awaited<ReturnType<ConversationReader['list']>> }>(
    `/runs/${encodeURIComponent(target.runId)}/conversations?${queryString({ nodeId: target.nodeId, scopeKey: target.scopeKey, ...page })}`, { signal },
  ).then(result => result.conversations),
  get: (id, signal) => request(`/conversations/${encodeURIComponent(id)}`, { signal }),
  turns: (id, page, signal) => request(`/conversations/${encodeURIComponent(id)}/turns?${queryString({ ...page })}`, { signal }),
  events: (id, page, signal) => request(`/conversations/${encodeURIComponent(id)}/events?${queryString({ ...page })}`, { signal }),
};

export type { WorkflowRunState };
