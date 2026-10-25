import { canonicalizeJsonValue } from '@universal-agent/workflow-contract';
import {
  type RunLogEntry,
  type RunMutation,
  type RunSnapshotState,
  type WorkflowRunState,
} from '../ports';

/**
 * Applies one log entry to `state`. Pure: never mutates its inputs.
 * `state` must be `null` exactly when `entry` is the run's `run.created` entry.
 */
export function applyRunLogEntry(
  state: WorkflowRunState | null,
  entry: RunLogEntry
): WorkflowRunState {
  const { mutation } = entry;
  if (mutation.kind === 'run.created') {
    if (state) {
      throw new Error(`Run "${entry.runId}" received a second "run.created" entry at seq ${entry.seq}`);
    }
    return {
      ...mutation.state,
      revision: entry.seq,
      coordinatorEpoch: entry.coordinatorEpoch,
      updatedAtMs: entry.recordedAtMs,
    };
  }
  if (!state) {
    throw new Error(`Run "${entry.runId}" log must start with "run.created" (got "${mutation.kind}")`);
  }
  if (entry.seq !== state.revision + 1) {
    throw new Error(
      `Run "${entry.runId}" log gap: expected seq ${state.revision + 1}, got ${entry.seq}`
    );
  }

  const base = { ...state, revision: entry.seq, updatedAtMs: entry.recordedAtMs };
  switch (mutation.kind) {
    case 'coordinator.acquired':
      return { ...base, coordinatorEpoch: mutation.epoch };
    case 'run.patched':
      return {
        ...base,
        ...(mutation.status !== undefined ? { status: mutation.status } : {}),
        ...(mutation.inputs !== undefined ? { inputs: mutation.inputs } : {}),
        ...(mutation.outputs !== undefined ? { outputs: mutation.outputs } : {}),
      };
    case 'scope.put':
      return { ...base, scopes: { ...state.scopes, [mutation.scope.scopeKey]: mutation.scope } };
    case 'scope.deleted': {
      const { [mutation.scopeKey]: _removed, ...rest } = state.scopes;
      return { ...base, scopes: rest };
    }
    case 'attempt.put':
      return {
        ...base,
        attempts: { ...state.attempts, [mutation.attempt.attemptId]: mutation.attempt },
      };
    case 'manifest.put':
      return {
        ...base,
        manifests: { ...state.manifests, [mutation.manifest.manifestId]: mutation.manifest },
      };
    case 'assessment.put':
      return {
        ...base,
        assessments: {
          ...state.assessments,
          [mutation.assessment.assessmentId]: mutation.assessment,
        },
      };
    case 'wait_request.put':
      return {
        ...base,
        waitRequests: {
          ...state.waitRequests,
          [mutation.waitRequest.requestId]: mutation.waitRequest,
        },
      };
    case 'read_receipts.appended':
      return { ...base, readReceipts: [...state.readReceipts, ...mutation.receipts] };
    case 'event.emitted':
      return { ...base, events: [...state.events, mutation.event] };
    case 'agent.pinned':
      return {
        ...base,
        pinnedAgents: { ...state.pinnedAgents, [mutation.agent.ref]: mutation.agent },
      };
    case 'chief.updated':
      return { ...base, chief: mutation.chief };
  }
}

/**
 * Mutations that open a run's log. Initial events are logged as separate `event.emitted`
 * entries so every public event can be read back uniformly from the log.
 */
export function createRunMutations(initialState: RunSnapshotState): RunMutation[] {
  return [
    { kind: 'run.created', state: { ...initialState, events: [] } },
    ...initialState.events.map((event): RunMutation => ({ kind: 'event.emitted', event })),
  ];
}

/** Rebuilds run state from `entries`, optionally starting from a snapshot taken at an earlier seq. */
export function foldRunLog(
  entries: readonly RunLogEntry[],
  snapshot: WorkflowRunState | null = null
): WorkflowRunState | null {
  let state = snapshot;
  for (const entry of entries) {
    state = applyRunLogEntry(state, entry);
  }
  return state;
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || canonicalizeJsonValue(a) === canonicalizeJsonValue(b);
}

function diffRecordPuts<T>(
  prev: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>,
  toMutation: (value: T) => RunMutation
): RunMutation[] {
  const mutations: RunMutation[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (!(key in prev) || !sameJson(prev[key], value)) {
      mutations.push(toMutation(value));
    }
  }
  return mutations;
}

function appendedTail<T>(prev: readonly T[], next: readonly T[], label: string): readonly T[] {
  if (next.length < prev.length) {
    throw new Error(`Run state "${label}" is append-only but shrank from ${prev.length} to ${next.length}`);
  }
  return next.slice(prev.length);
}

/**
 * Derives the minimal mutation list that turns `prev` into `next`.
 * Lets the runtime keep computing whole next states while stores only persist the delta.
 */
export function diffRunState(prev: WorkflowRunState, next: RunSnapshotState): RunMutation[] {
  const mutations: RunMutation[] = [];

  for (const key of Object.keys(prev.scopes)) {
    if (!(key in next.scopes)) {
      mutations.push({ kind: 'scope.deleted', scopeKey: key });
    }
  }
  mutations.push(...diffRecordPuts(prev.scopes, next.scopes, (scope) => ({ kind: 'scope.put', scope })));
  mutations.push(
    ...diffRecordPuts(prev.attempts, next.attempts, (attempt) => ({ kind: 'attempt.put', attempt }))
  );
  mutations.push(
    ...diffRecordPuts(prev.manifests, next.manifests, (manifest) => ({
      kind: 'manifest.put',
      manifest,
    }))
  );
  mutations.push(
    ...diffRecordPuts(prev.assessments, next.assessments, (assessment) => ({
      kind: 'assessment.put',
      assessment,
    }))
  );
  mutations.push(
    ...diffRecordPuts(prev.waitRequests, next.waitRequests, (waitRequest) => ({
      kind: 'wait_request.put',
      waitRequest,
    }))
  );

  mutations.push(
    ...diffRecordPuts(prev.pinnedAgents, next.pinnedAgents, (agent) => ({
      kind: 'agent.pinned',
      agent,
    }))
  );
  if (!sameJson(prev.chief, next.chief)) {
    mutations.push({ kind: 'chief.updated', chief: next.chief });
  }

  const receipts = appendedTail(prev.readReceipts, next.readReceipts, 'readReceipts');
  if (receipts.length > 0) {
    mutations.push({ kind: 'read_receipts.appended', receipts });
  }

  const patch: { status?: WorkflowRunState['status']; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> } = {};
  if (prev.status !== next.status) patch.status = next.status;
  if (!sameJson(prev.inputs, next.inputs)) patch.inputs = { ...next.inputs };
  if (!sameJson(prev.outputs, next.outputs)) patch.outputs = { ...next.outputs };
  if (Object.keys(patch).length > 0) {
    mutations.push({ kind: 'run.patched', ...patch });
  }

  // Events go last so a fold observes them after the state changes they describe.
  for (const event of appendedTail(prev.events, next.events, 'events')) {
    mutations.push({ kind: 'event.emitted', event });
  }

  return mutations;
}
