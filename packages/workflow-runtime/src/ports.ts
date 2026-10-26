import type { NodeDataAccess } from './node-data';
import type {
  AgentNode,
  AgentProfile,
  ArtifactReadReceipt,
  ArtifactVersion,
  AssessmentFinding,
  AssessmentRecord,
  AssessmentVerdict,
  ContextManifest,
  LiveAttemptProgress,
  NodeExecutionStatus,
  RunWorkspaceBinding,
  ScriptNode,
  StagePhase,
  ThinkingStep,
  WaitRequest,
  WorkflowDefinition,
  WorkflowEvent,
  WorkspaceMergeCheck,
  WorkflowRunStatus,
} from '@universal-agent/workflow-contract';

export class CoordinatorFenceError extends Error {
  readonly runId: string;
  readonly expectedEpoch: number;
  readonly actualEpoch: number;

  constructor(runId: string, expectedEpoch: number, actualEpoch: number) {
    super(
      `Coordinator fence violation on run "${runId}": expected epoch ${expectedEpoch}, but store is at epoch ${actualEpoch}`
    );
    this.name = 'CoordinatorFenceError';
    this.runId = runId;
    this.expectedEpoch = expectedEpoch;
    this.actualEpoch = actualEpoch;
  }
}

export class RevisionConflictError extends Error {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(runId: string, expectedRevision: number, actualRevision: number) {
    super(
      `CAS revision conflict on run "${runId}": expected revision ${expectedRevision}, actual ${actualRevision}`
    );
    this.name = 'RevisionConflictError';
    this.runId = runId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface PortValueRecord {
  readonly value: unknown;
  readonly artifactId?: string;
  /** Metadata for aggregated values, so a later per-item node retains artifact access. */
  readonly items?: readonly (PortValueRecord | null)[];
}

export interface NodeRuntimeState {
  readonly nodeId: string;
  readonly status: NodeExecutionStatus;
  readonly latestAttemptId?: string;
  readonly retryCount: number;
  readonly outputs: Readonly<Record<string, PortValueRecord>>;
  readonly latestVerdict?: AssessmentVerdict;
  readonly latestAssessmentId?: string;
  readonly activeWaitRequestId?: string;
  readonly error?: string;
  /** Ordered per-item results, including original artifact references and failed items. */
  readonly parallelItems?: readonly {
    readonly scopeKey: string;
    readonly status: WorkflowRunStatus;
    readonly outputs: Readonly<Record<string, PortValueRecord>>;
    readonly error?: string;
    readonly verdict?: AssessmentVerdict;
  }[];
}

export interface GraphScopeState {
  readonly scopeKey: string;
  readonly scopePath: string;
  readonly status: WorkflowRunStatus;
  readonly inputs: Readonly<Record<string, PortValueRecord>>;
  readonly outputs: Readonly<Record<string, PortValueRecord>>;
  readonly nodes: Readonly<Record<string, NodeRuntimeState>>;
  /** For LoopNode container scopes: current 0-based round index. */
  readonly roundIndex?: number;
  /** For ParallelNode container scopes: active item scope keys. */
  readonly itemScopeKeys?: readonly string[];
}

export interface EffectReceipt {
  readonly attemptId: string;
  /** Unified history of this actual executor call; retries have separate recordings. */
  readonly conversationId?: string;
  readonly conversationTurnId?: string;
  readonly sessionId?: string;
  readonly acpSessionId?: string;
  readonly agentType?: string;
  /** Model and effort the attempt actually ran with, when the executor knows them. */
  readonly modelId?: string;
  readonly effort?: string;
  readonly capabilitySourceVersion?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalCostUsd?: number;
  readonly exitCode?: number | null;
  readonly durationMs: number;
  /** Thinking and tool-call steps captured during execution. */
  readonly steps?: readonly ThinkingStep[];
}

/** An agent profile resolved once per run and reused for every later reference to the same ref. */
export interface PinnedAgent {
  /** The ref as written in the definition or chief command (`id` or `id@version`). */
  readonly ref: string;
  readonly agentId: string;
  readonly version: string;
  readonly digest: string;
  readonly profile: AgentProfile;
}

export interface AgentRegistry {
  /** Resolves `"<agentId>"` (latest version) or `"<agentId>@<version>"`; null when unknown. */
  resolve(ref: string): Promise<AgentProfile | null>;
}

export interface ChiefGuidance {
  readonly nodeId: string;
  /** Absent: applies wherever `nodeId` runs (e.g. every loop round). */
  readonly scopeKey?: string;
  readonly text: string;
  readonly createdAtMs: number;
}

export interface ChiefAgentOverride {
  readonly nodeId: string;
  readonly scopeKey?: string;
  readonly agentRef: string;
}

/** Durable chief bookkeeping carried in the run state. */
export interface ChiefRunState {
  readonly interventionCount: number;
  /** Events before this index have already been examined for triggers. */
  readonly processedEventCount: number;
  readonly guidance: readonly ChiefGuidance[];
  readonly agentOverrides: readonly ChiefAgentOverride[];
  /** Extra rounds granted per loop, keyed by `<scopeKey>/<loopNodeId>`. */
  readonly loopExtensions: Readonly<Record<string, number>>;
  readonly budgetTriggered: boolean;
  /** WaitRequest raised by an `escalate` command while it is pending. */
  readonly pendingEscalationId?: string;
}

export const EMPTY_CHIEF_RUN_STATE: ChiefRunState = {
  interventionCount: 0,
  processedEventCount: 0,
  guidance: [],
  agentOverrides: [],
  loopExtensions: {},
  budgetTriggered: false,
};

/** Files a step changed in its workspace, captured by the executor (e.g. from git). */
export interface ExecutionChanges {
  /** Unified diff; empty when nothing changed. */
  readonly diff: string;
  readonly files: readonly { readonly path: string; readonly status: string }[];
  /** Git trees of the repository before and after, when the host can tell (lets a fork replay the change). */
  readonly trees?: { readonly before: string; readonly after: string };
}

/** Changes recorded on an attempt; the diff itself lives in an artifact. */
export interface AttemptChanges {
  readonly artifactId?: string;
  readonly files: ExecutionChanges['files'];
  /** Changed files outside the step's `writeScopes`. */
  readonly outOfScope?: readonly string[];
  /** Ran in its own copy of the workspace and was merged back. */
  readonly isolated?: boolean;
  /** Git trees of the repository before and after the change. */
  readonly trees?: { readonly before: string; readonly after: string };
}

export interface NodeAttemptRecord {
  readonly attemptId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly retryIndex: number;
  readonly roundIndex: number;
  readonly phase: StagePhase;
  readonly status: 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  readonly contextManifestId?: string;
  readonly producedArtifactIds: readonly string[];
  readonly assessmentId?: string;
  readonly receipt?: EffectReceipt;
  /** Agent profile that performed an AgentNode attempt. */
  readonly agent?: Omit<PinnedAgent, 'profile'>;
  /** What the attempt changed in its workspace; the diff is stored as an artifact. */
  readonly changes?: AttemptChanges;
  readonly startedAtMs: number;
  readonly completedAtMs?: number;
  readonly error?: string;
}

export interface WorkflowRunState {
  readonly runId: string;
  readonly definition: WorkflowDefinition;
  readonly definitionDigest: string;
  readonly status: WorkflowRunStatus;
  /** Sequence number of the last applied `RunLogEntry`. */
  readonly revision: number;
  readonly coordinatorEpoch: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly scopes: Readonly<Record<string, GraphScopeState>>;
  readonly attempts: Readonly<Record<string, NodeAttemptRecord>>;
  readonly manifests: Readonly<Record<string, ContextManifest>>;
  readonly assessments: Readonly<Record<string, AssessmentRecord>>;
  readonly waitRequests: Readonly<Record<string, WaitRequest>>;
  readonly readReceipts: readonly ArtifactReadReceipt[];
  readonly events: readonly WorkflowEvent[];
  /** Directory bound to each workspace slot, fixed at start. Absent slots use the executor's default. */
  readonly workspaces: Readonly<Record<string, RunWorkspaceBinding>>;
  /** Agent profiles pinned by this run, keyed by `PinnedAgent.ref`. */
  readonly pinnedAgents: Readonly<Record<string, PinnedAgent>>;
  readonly chief: ChiefRunState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * A single state-changing fact appended to a run's log. `WorkflowRunState` is always
 * `foldRunLog(entries)`; stores persist these entries append-only and may keep
 * snapshots or query projections derived from them.
 */
export type RunMutation =
  | { readonly kind: 'run.created'; readonly state: RunSnapshotState }
  | { readonly kind: 'coordinator.acquired'; readonly epoch: number }
  | {
      readonly kind: 'run.patched';
      readonly status?: WorkflowRunStatus;
      readonly inputs?: Readonly<Record<string, unknown>>;
      readonly outputs?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'scope.put'; readonly scope: GraphScopeState }
  | { readonly kind: 'scope.deleted'; readonly scopeKey: string }
  | { readonly kind: 'attempt.put'; readonly attempt: NodeAttemptRecord }
  | { readonly kind: 'manifest.put'; readonly manifest: ContextManifest }
  | { readonly kind: 'assessment.put'; readonly assessment: AssessmentRecord }
  | { readonly kind: 'wait_request.put'; readonly waitRequest: WaitRequest }
  | { readonly kind: 'read_receipts.appended'; readonly receipts: readonly ArtifactReadReceipt[] }
  | { readonly kind: 'agent.pinned'; readonly agent: PinnedAgent }
  | { readonly kind: 'chief.updated'; readonly chief: ChiefRunState }
  | { readonly kind: 'event.emitted'; readonly event: WorkflowEvent };

export type RunMutationKind = RunMutation['kind'];

/** Run state as recorded by `run.created` (log-derived fields are filled in by the fold). */
export type RunSnapshotState = Omit<WorkflowRunState, 'revision' | 'coordinatorEpoch' | 'updatedAtMs'>;

export interface RunLogEntry {
  readonly runId: string;
  /** 1-based, gap-free sequence number within the run. */
  readonly seq: number;
  readonly coordinatorEpoch: number;
  readonly mutation: RunMutation;
  readonly recordedAtMs: number;
}

export interface AppendRunMutationsInput {
  readonly runId: string;
  /** Sequence number of the last entry the caller observed (`WorkflowRunState.revision`). */
  readonly expectedSeq: number;
  readonly coordinatorEpoch: number;
  readonly mutations: readonly RunMutation[];
}

export interface RuntimeStore {
  /** Appends `run.created` for `initialState` as seq 1. */
  createRun(initialState: RunSnapshotState): Promise<WorkflowRunState>;
  getRun(runId: string): Promise<WorkflowRunState | null>;
  /** Appends `coordinator.acquired` with the next epoch, fencing out older coordinators. */
  acquireCoordinatorEpoch(runId: string): Promise<{ epoch: number; state: WorkflowRunState }>;
  /**
   * Atomically appends `mutations` if the run is still at `expectedSeq` and `coordinatorEpoch`.
   * Throws `RevisionConflictError` / `CoordinatorFenceError` otherwise.
   */
  appendMutations(input: AppendRunMutationsInput): Promise<WorkflowRunState>;
  readLog(
    runId: string,
    options?: { afterSeq?: number; limit?: number }
  ): Promise<readonly RunLogEntry[]>;
}

export interface PutArtifactInput {
  readonly content: string | Uint8Array;
  readonly mediaType?: string;
  readonly producerRunId: string;
  readonly producerNodeId: string;
  readonly producerAttemptId: string;
  readonly portName: string;
  readonly summary?: string;
}

export interface ArtifactPageSlice {
  readonly artifactId: string;
  readonly content: string;
  readonly offsetBytes: number;
  readonly readBytes: number;
  readonly totalBytes: number;
  readonly hasMore: boolean;
  readonly nextOffsetBytes?: number;
  readonly section?: string;
}

export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactVersion>;
  getMeta(artifactId: string): Promise<ArtifactVersion | null>;
  readText(artifactId: string): Promise<string>;
  readSlice(
    artifactId: string,
    options?: { offsetBytes?: number; maxBytes?: number; section?: string }
  ): Promise<ArtifactPageSlice>;
}

export interface ScopedArtifactReader {
  readPage(
    artifactId: string,
    options?: { offsetBytes?: number; maxBytes?: number; section?: string }
  ): Promise<ArtifactPageSlice>;
  /** Remaining cumulative read quota, or null when no quota is configured. */
  getRemainingQuotaBytes(): number | null;
  getReceipts(): readonly ArtifactReadReceipt[];
}

export interface AgentExecutionRequest {
  readonly runId: string;
  readonly scopeKey: string;
  readonly attemptId: string;
  readonly invocationId: string;
  /** Existing scheduler counters, exposed only for execution correlation. */
  readonly retryIndex?: number;
  readonly roundIndex?: number;
  readonly node: AgentNode;
  /** Agent profile the node is delegated to; absent for legacy role-bound nodes. */
  readonly agent?: PinnedAgent;
  readonly manifest: ContextManifest;
  readonly renderedPrompt: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly artifactReader: ScopedArtifactReader;
  /** The step's intermediate data, bound to this attempt (see `NodeDataAccess`). */
  readonly data?: NodeDataAccess;
  /** Directory bound to the node's slot; absent when the run left the slot unbound. */
  readonly workspace?: RunWorkspaceBinding;
  /** Slots listed in `node.readWorkspaces` that the run bound. */
  readonly readWorkspaces?: readonly RunWorkspaceBinding[];
  /** `workspace` is a private copy the runtime merges back; executors need not record changes. */
  readonly isolated?: boolean;
  readonly resumeSessionBinding?: {
    readonly sessionId: string;
    readonly acpSessionId: string;
    readonly agentType: string;
  };
  readonly humanAnswer?: {
    readonly answer: string | Record<string, unknown>;
    readonly responderId: string;
  };
  /** Live callback invoked as the agent streams thoughts, tool calls, or plans. */
  readonly onProgress?: (steps: readonly ThinkingStep[]) => void;
  readonly signal?: AbortSignal;
}

export interface AgentExecutionResult {
  readonly status: 'COMPLETED' | 'WAIT_REQUESTED';
  readonly outputs?: Record<string, unknown>;
  /** Raw text or structured artifacts produced per output port. */
  readonly artifacts?: Record<
    string,
    { content: string; mediaType?: string; summary?: string }
  >;
  readonly assessment?: {
    readonly verdict: AssessmentVerdict;
    readonly summary: string;
    readonly findings?: readonly AssessmentFinding[];
  };
  readonly waitRequest?: {
    readonly prompt: string;
    readonly options?: readonly { value: string; label: string; description?: string }[];
    readonly requiredRole?: string;
  };
  readonly receipt?: Partial<EffectReceipt>;
  /** Workspace changes made by the attempt, when the executor can tell. */
  readonly changes?: ExecutionChanges;
}

export interface ScriptExecutionRequest {
  readonly runId: string;
  readonly scopeKey: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly node: ScriptNode;
  readonly inputs: Readonly<Record<string, unknown>>;
  /** The step's intermediate data, bound to this attempt (see `NodeDataAccess`). */
  readonly data?: NodeDataAccess;
  /** Directory bound to the node's slot; `node.cwd` is relative to it. */
  readonly workspace?: RunWorkspaceBinding;
  /** `workspace` is a private copy the runtime merges back; executors need not record changes. */
  readonly isolated?: boolean;
  readonly signal?: AbortSignal;
}

export interface ScriptExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly outputs?: Record<string, unknown>;
  /** Contents to store as artifacts, per output port. */
  readonly artifacts?: Record<string, { content: string; mediaType?: string; summary?: string }>;
  readonly assessment?: {
    readonly verdict: AssessmentVerdict;
    readonly summary: string;
    readonly findings?: readonly AssessmentFinding[];
  };
  /** Workspace changes made by the script, when the executor can tell. */
  readonly changes?: ExecutionChanges;
}

/** Runs agent tasks on one kind of client (ACP sessions, a direct model API, a mock, ...). */
export interface AgentAdapter {
  executeAgent(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}

export interface Executor extends AgentAdapter {
  executeScript(request: ScriptExecutionRequest): Promise<ScriptExecutionResult>;
  cancel?(attemptId: string): Promise<void>;
}

export interface WorkspaceLease {
  readonly leaseId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly writeScopes: readonly string[];
  /** Directory the write scopes are relative to; leases on different workspaces never clash. */
  readonly workspace?: string;
}

export interface WorkspaceManager {
  acquireLease(input: {
    runId: string;
    attemptId: string;
    writeScopes: readonly string[];
    workspace?: string;
  }): Promise<WorkspaceLease>;
  releaseLease(leaseId: string): Promise<void>;
  /**
   * Optional: gives one attempt its own copy of `workspace` so it can write while other steps
   * write too. Returns null when the workspace cannot be copied (the attempt then runs in
   * place under its write lease). Isolating an attempt again, once its copy was merged or
   * discarded, gives a fresh copy at the same path. `mergeCheck` runs on merged code before
   * it lands whenever the attempt's changes merge with changes made meanwhile.
   */
  isolate?(input: {
    runId: string;
    attemptId: string;
    nodeId: string;
    workspace: RunWorkspaceBinding;
    mergeCheck?: WorkspaceMergeCheck;
  }): Promise<IsolatedWorkspace | null>;
}

/** A private copy of a workspace for one attempt. */
export interface IsolatedWorkspace {
  /** Directory of the copy, standing in for the workspace's path. */
  readonly path: string;
  /** What the attempt changed in its copy so far. */
  changes(): Promise<ExecutionChanges>;
  /**
   * Merges the attempt's changes into the workspace and removes the copy. Throws
   * `WorkspaceMergeConflictError` (keeping the changes on a branch) when they do not apply.
   */
  integrate(): Promise<ExecutionChanges>;
  /** Removes the copy without merging anything. */
  discard(): Promise<void>;
}

export class WorkspaceMergeConflictError extends Error {
  readonly files: readonly string[];
  /** Where the attempt's changes were kept, if anywhere. */
  readonly branch?: string;
  /** The changes merged line by line, but the workspace's merge check failed on the result. */
  readonly check?: { readonly command: string; readonly output: string };

  constructor(files: readonly string[], branch?: string, check?: { command: string; output: string }) {
    const kept = branch ? `; the changes are kept on branch ${branch}` : '';
    super(
      check
        ? `The step's changes merged with changes made meanwhile, but \`${check.command}\` failed on the result${kept}`
        : `Could not merge the step's changes back into the workspace: ${files.length > 0 ? files.join(', ') : 'conflicting edits'} changed meanwhile${kept}`
    );
    this.name = 'WorkspaceMergeConflictError';
    this.files = files;
    if (branch) this.branch = branch;
    if (check) this.check = check;
  }
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  nextId(prefix: string): string;
}
