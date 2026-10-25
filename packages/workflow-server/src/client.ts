import type { LiveAttemptProgress, WorkflowDefinition } from '@universal-agent/workflow-contract';
import type { OpenFinding, RunLogEntry, WorkflowRunState } from '@universal-agent/workflow-runtime';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4317';

export class WorkflowClientError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'WorkflowClientError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly digest: string;
  readonly updatedAtMs: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly status: WorkflowRunState['status'];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RunView {
  readonly run: WorkflowRunState;
  readonly active: boolean;
  readonly chiefAnswering: boolean;
  readonly liveProgress: readonly LiveAttemptProgress[];
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/** What following a run yields: log entries, and now and then who is executing. */
export type RunStreamEvent =
  | { readonly type: 'log'; readonly entry: RunLogEntry }
  | { readonly type: 'activity'; readonly active: boolean; readonly chiefAnswering: boolean; readonly liveProgress: readonly LiveAttemptProgress[] };

/** A small client for the workflow server's HTTP API (see `GET /api/openapi.json`). */
export class WorkflowClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_SERVER_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new WorkflowClientError(0, `Cannot reach the workflow server at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (response.status === 204) return undefined as T;
    const json = (await response.json().catch(() => ({}))) as { error?: string; details?: unknown };
    if (!response.ok) throw new WorkflowClientError(response.status, json.error ?? `Request failed (${response.status})`, json.details);
    return json as T;
  }

  listWorkflows(): Promise<WorkflowSummary[]> {
    return this.request<{ workflows: WorkflowSummary[] }>('GET', '/api/workflows').then((r) => r.workflows);
  }

  getWorkflow(id: string): Promise<{ id: string; definition: WorkflowDefinition }> {
    return this.request('GET', `/api/workflows/${encodeURIComponent(id)}`);
  }

  /** Saves a definition: a new version when the workflow exists, else a new workflow. */
  async saveWorkflow(definition: WorkflowDefinition): Promise<{ id: string }> {
    const exists = (await this.listWorkflows()).some((w) => w.id === definition.id);
    return exists
      ? this.request('PUT', `/api/workflows/${encodeURIComponent(definition.id)}`, { definition })
      : this.request('POST', '/api/workflows', { definition });
  }

  listRuns(options: { workflowId?: string; limit?: number } = {}): Promise<RunSummary[]> {
    const query = new URLSearchParams();
    if (options.workflowId) query.set('workflowId', options.workflowId);
    if (options.limit) query.set('limit', String(options.limit));
    return this.request<{ runs: RunSummary[] }>('GET', `/api/runs${query.size ? `?${query}` : ''}`).then((r) => r.runs);
  }

  /** Starts a run; `workspaces` maps slots to workspace ids. */
  startRun(input: { workflowId: string; inputs?: Record<string, unknown>; workspaces?: Record<string, string> }): Promise<{ runId: string }> {
    return this.request('POST', '/api/runs', { workflowId: input.workflowId, inputs: input.inputs ?? {}, workspaces: input.workspaces ?? {} });
  }

  getRun(runId: string): Promise<RunView> {
    return this.request('GET', `/api/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId: string): Promise<WorkflowRunState> {
    return this.request<{ run: WorkflowRunState }>('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`).then((r) => r.run);
  }

  respond(runId: string, input: { requestId: string; answer: string | Record<string, unknown>; responderId?: string }): Promise<void> {
    return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/respond`, input);
  }

  messageChief(runId: string, text: string, authorId?: string): Promise<{ messageId: string }> {
    return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/chief/messages`, { text, ...(authorId ? { authorId } : {}) });
  }

  /** Problems still open in a run (see `WorkflowRuntime.getOpenFindings`). */
  listFindings(runId: string): Promise<OpenFinding[]> {
    return this.request<{ findings: OpenFinding[] }>('GET', `/api/runs/${encodeURIComponent(runId)}/findings`).then((r) => r.findings);
  }

  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.request<{ workspaces: WorkspaceSummary[] }>('GET', '/api/workspaces').then((r) => r.workspaces);
  }

  /** The workspace registered for `path`, registering it first when there is none. */
  async workspaceFor(path: string): Promise<WorkspaceSummary> {
    const existing = (await this.listWorkspaces()).find((w) => w.path === path);
    return existing ?? this.request<WorkspaceSummary>('POST', '/api/workspaces', { path });
  }

  /**
   * Follows a run's log (Server-Sent Events) from after `after`, reconnecting where it left off
   * when the connection drops. Ends when `signal` aborts; callers stop iterating when done.
   */
  async *followRun(runId: string, options: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<RunStreamEvent> {
    let after = options.after ?? 0;
    while (!options.signal?.aborted) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/runs/${encodeURIComponent(runId)}/stream?after=${after}`, {
          headers: { accept: 'text/event-stream' },
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (err) {
        if (options.signal?.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (!response.ok || !response.body) {
        const json = (await response.json().catch(() => ({}))) as { error?: string };
        throw new WorkflowClientError(response.status, json.error ?? `Cannot follow run ${runId} (${response.status})`);
      }
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('\n');
            if (!data) continue;
            if (event === 'log') {
              const entry = JSON.parse(data) as RunLogEntry;
              after = entry.seq;
              yield { type: 'log', entry };
            } else if (event === 'activity') {
              yield { type: 'activity', ...(JSON.parse(data) as Omit<Extract<RunStreamEvent, { type: 'activity' }>, 'type'>) };
            }
          }
        }
      } catch (err) {
        if (options.signal?.aborted) return;
      }
    }
  }

  openApi(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/openapi.json');
  }
}
