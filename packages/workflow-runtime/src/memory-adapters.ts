import { type ArtifactVersion, sha256Hex } from '@universal-agent/workflow-contract';
import {
  type ArtifactPageSlice,
  type ArtifactStore,
  type Clock,
  type AppendRunMutationsInput,
  CoordinatorFenceError,
  type IdGenerator,
  type PutArtifactInput,
  RevisionConflictError,
  type RunLogEntry,
  type RunMutation,
  type RunSnapshotState,
  type RuntimeStore,
  type WorkflowRunState,
  type WorkspaceLease,
  type WorkspaceManager,
} from './ports';
import { extractMarkdownSections, sliceArtifactBytes } from './artifacts/slicing';
import { applyRunLogEntry, createRunMutations } from './state/run-log';

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class DeterministicClock implements Clock {
  private currentMs: number;
  private readonly stepMs: number;

  constructor(initialMs = 1_700_000_000_000, stepMs = 10) {
    this.currentMs = initialMs;
    this.stepMs = stepMs;
  }

  nowMs(): number {
    const val = this.currentMs;
    this.currentMs += this.stepMs;
    return val;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();

  nextId(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}_${next}`;
  }
}

export class InMemoryRuntimeStore implements RuntimeStore {
  private readonly logs = new Map<string, RunLogEntry[]>();
  private readonly states = new Map<string, WorkflowRunState>();
  private readonly clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  async createRun(initialState: RunSnapshotState): Promise<WorkflowRunState> {
    if (this.logs.has(initialState.runId)) {
      throw new Error(`Run "${initialState.runId}" already exists`);
    }
    this.logs.set(initialState.runId, []);
    return this.append(initialState.runId, 1, createRunMutations(initialState));
  }

  async getRun(runId: string): Promise<WorkflowRunState | null> {
    const existing = this.states.get(runId);
    return existing ? structuredClone(existing) : null;
  }

  async acquireCoordinatorEpoch(
    runId: string
  ): Promise<{ epoch: number; state: WorkflowRunState }> {
    const existing = this.states.get(runId);
    if (!existing) {
      throw new Error(`Run "${runId}" not found`);
    }
    const epoch = existing.coordinatorEpoch + 1;
    const state = this.append(runId, epoch, [{ kind: 'coordinator.acquired', epoch }]);
    return { epoch, state };
  }

  async appendMutations(input: AppendRunMutationsInput): Promise<WorkflowRunState> {
    const existing = this.states.get(input.runId);
    if (!existing) {
      throw new Error(`Run "${input.runId}" not found`);
    }
    if (existing.coordinatorEpoch !== input.coordinatorEpoch) {
      throw new CoordinatorFenceError(
        input.runId,
        input.coordinatorEpoch,
        existing.coordinatorEpoch
      );
    }
    if (existing.revision !== input.expectedSeq) {
      throw new RevisionConflictError(input.runId, input.expectedSeq, existing.revision);
    }
    return this.append(input.runId, existing.coordinatorEpoch, input.mutations);
  }

  async readLog(
    runId: string,
    options?: { afterSeq?: number; limit?: number }
  ): Promise<readonly RunLogEntry[]> {
    const afterSeq = options?.afterSeq ?? 0;
    const entries = (this.logs.get(runId) ?? []).filter((e) => e.seq > afterSeq);
    return structuredClone(options?.limit !== undefined ? entries.slice(0, options.limit) : entries);
  }

  private append(
    runId: string,
    coordinatorEpoch: number,
    mutations: readonly RunMutation[]
  ): WorkflowRunState {
    const log = this.logs.get(runId)!;
    let state = this.states.get(runId) ?? null;
    const recordedAtMs = this.clock.nowMs();
    const entries = mutations.map((mutation, idx) =>
      structuredClone({ runId, seq: log.length + idx + 1, coordinatorEpoch, mutation, recordedAtMs })
    );
    for (const entry of entries) {
      state = applyRunLogEntry(state, entry);
    }
    log.push(...entries);
    this.states.set(runId, state!);
    return structuredClone(state!);
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly metaById = new Map<string, ArtifactVersion>();
  private readonly bytesById = new Map<string, Uint8Array>();
  private readonly clock: Clock;
  private seq = 0;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  async put(input: PutArtifactInput): Promise<ArtifactVersion> {
    const bytes =
      typeof input.content === 'string'
        ? new TextEncoder().encode(input.content)
        : new Uint8Array(input.content);
    const sha256 = sha256Hex(bytes);
    this.seq += 1;
    const artifactId = `art_${sha256.slice(0, 12)}_${this.seq}`;
    const textContent =
      typeof input.content === 'string'
        ? input.content
        : new TextDecoder().decode(bytes);
    const sections = extractMarkdownSections(textContent);

    const version: ArtifactVersion = {
      artifactId,
      sha256,
      mediaType: input.mediaType ?? 'text/plain',
      sizeBytes: bytes.byteLength,
      producerRunId: input.producerRunId,
      producerNodeId: input.producerNodeId,
      producerAttemptId: input.producerAttemptId,
      portName: input.portName,
      summary: input.summary ?? textContent.slice(0, 240),
      ...(sections.length > 0 ? { sections } : {}),
      createdAtMs: this.clock.nowMs(),
    };

    this.metaById.set(artifactId, version);
    this.bytesById.set(artifactId, bytes);
    return version;
  }

  async getMeta(artifactId: string): Promise<ArtifactVersion | null> {
    return this.metaById.get(artifactId) ?? null;
  }

  async readText(artifactId: string): Promise<string> {
    const bytes = this.bytesById.get(artifactId);
    if (!bytes) {
      throw new Error(`Artifact "${artifactId}" not found`);
    }
    return new TextDecoder().decode(bytes);
  }

  async readSlice(
    artifactId: string,
    options?: { offsetBytes?: number; maxBytes?: number; section?: string }
  ): Promise<ArtifactPageSlice> {
    const bytes = this.bytesById.get(artifactId);
    if (!bytes) {
      throw new Error(`Artifact "${artifactId}" not found`);
    }
    return sliceArtifactBytes(artifactId, bytes, options);
  }

}

function scopesOverlap(scopeA: string, scopeB: string): boolean {
  const normA = scopeA.replace(/\\/g, '/').replace(/\/+$/, '');
  const normB = scopeB.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normA || !normB) return false;
  if (normA === '*' || normB === '*' || normA === '.' || normB === '.') return true;
  if (normA === normB) return true;
  return normA.startsWith(`${normB}/`) || normB.startsWith(`${normA}/`);
}

function anyScopeOverlaps(
  scopesA: readonly string[],
  scopesB: readonly string[]
): boolean {
  for (const a of scopesA) {
    for (const b of scopesB) {
      if (scopesOverlap(a, b)) return true;
    }
  }
  return false;
}

export class InMemoryWorkspaceManager implements WorkspaceManager {
  private readonly activeLeases = new Map<string, WorkspaceLease>();
  private readonly waitQueue: (() => void)[] = [];
  private seq = 0;

  async acquireLease(input: {
    runId: string;
    attemptId: string;
    writeScopes: readonly string[];
    workspace?: string;
  }): Promise<WorkspaceLease> {
    if (input.writeScopes.length > 0) {
      while (this.hasConflict(input.workspace, input.writeScopes)) {
        await new Promise<void>((resolve) => {
          this.waitQueue.push(resolve);
        });
      }
    }
    this.seq += 1;
    const lease: WorkspaceLease = {
      leaseId: `lease_${this.seq}`,
      runId: input.runId,
      attemptId: input.attemptId,
      writeScopes: [...input.writeScopes],
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    };
    this.activeLeases.set(lease.leaseId, lease);
    return lease;
  }

  async releaseLease(leaseId: string): Promise<void> {
    this.activeLeases.delete(leaseId);
    const waiters = this.waitQueue.splice(0);
    for (const wake of waiters) {
      wake();
    }
  }

  /** Write scopes are paths inside a workspace, so only leases on the same workspace can clash. */
  private hasConflict(workspace: string | undefined, requestedScopes: readonly string[]): boolean {
    for (const active of this.activeLeases.values()) {
      if (active.workspace !== workspace) continue;
      if (anyScopeOverlaps(requestedScopes, active.writeScopes)) {
        return true;
      }
    }
    return false;
  }
}
