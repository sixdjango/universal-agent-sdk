import {
  type AgentNode,
  type ArtifactReadReceipt,
  type AssessmentRecord,
  type AssessmentVerdict,
  AssessmentVerdictSchema,
  canonicalizeJsonValue,
  type ChiefDecision,
  type CompiledGraphScope,
  type CompiledWorkflowPlan,
  compileWorkflowDefinition,
  type ContextManifest,
  type GateNode,
  type LoopNode,
  listWorkspaceSlots,
  type ManifestWorkspace,
  type ParallelNode,
  type RunWorkspaceBinding,
  type ScriptNode,
  type WaitRequest,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '@universal-agent/workflow-contract';
import {
  buildDataEdgeContextBundle,
  createScopedArtifactReader,
} from './context/bundle-builder';
import {
  InMemoryArtifactStore,
  InMemoryRuntimeStore,
  InMemoryWorkspaceManager,
  SequentialIdGenerator,
  SystemClock,
} from './memory-adapters';
import {
  type AgentAdapter,
  type AgentExecutionResult,
  type AgentRegistry,
  type ArtifactStore,
  type Clock,
  EMPTY_CHIEF_RUN_STATE,
  type AttemptChanges,
  type ExecutionChanges,
  type Executor,
  type GraphScopeState,
  type IdGenerator,
  type IsolatedWorkspace,
  type NodeAttemptRecord,
  type NodeRuntimeState,
  type PinnedAgent,
  type PortValueRecord,
  type RunSnapshotState,
  type RuntimeStore,
  type WorkflowRunState,
  type WorkspaceManager,
  WorkspaceMergeConflictError,
} from './ports';
import {
  computeScopeReadyNodeIds,
  createInitialScopeState,
  evaluateEdgeCondition,
  invalidateSubgraphForRerun,
  reduceScopeTransitions,
  resolveCompiledScopeByKey,
  reviveAncestorScopes,
} from './scheduler/graph-reducer';
import { pinAgent, resolveEffectiveAgentRef } from './agents/agent-resolution';
import { applyChiefDecision } from './chief/apply';
import { allowedChiefCommands, type ChiefSupervisor } from './chief/supervisor';
import { type ChiefTrigger, detectChiefTriggers } from './chief/triggers';
import { diffRunState } from './state/run-log';
import { deriveRunStatus, resolveWaitRequestInState } from './scheduler/wait-resolution';

/** Adapter name used for agent profiles that do not pick one; served by `executor`. */
export const DEFAULT_AGENT_ADAPTER = 'acp';

export interface WorkflowRuntimeOptions {
  readonly store?: RuntimeStore;
  readonly artifacts?: ArtifactStore;
  readonly executor: Executor;
  /** Resolves `agentRef`s on AgentNodes and the chief policy. */
  readonly agentRegistry?: AgentRegistry;
  /**
   * Extra agent adapters keyed by `AgentProfile.runtime.adapter`. Profiles on the
   * default `'acp'` adapter (and legacy role-bound nodes) run on `executor`.
   */
  readonly adapters?: Readonly<Record<string, AgentAdapter>>;
  /** Supervises runs whose definition declares a `chief` policy. */
  readonly chief?: ChiefSupervisor;
  readonly workspaces?: WorkspaceManager;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

export interface StartWorkflowRunInput {
  readonly runId?: string;
  readonly definition: WorkflowDefinition | CompiledWorkflowPlan;
  readonly inputs?: Record<string, unknown>;
  /**
   * Directory for each workspace slot, as a path or a resolved binding. Every required
   * declared slot must be bound; unbound optional slots use the executor's default directory.
   */
  readonly workspaces?: Readonly<Record<string, string | Omit<RunWorkspaceBinding, 'slot'>>>;
}

export class WorkspaceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBindingError';
  }
}

function bindRunWorkspaces(
  definition: WorkflowDefinition,
  input: StartWorkflowRunInput['workspaces']
): Record<string, RunWorkspaceBinding> {
  const slots = listWorkspaceSlots(definition);
  const known = new Set(slots.map((s) => s.name));
  const bound: Record<string, RunWorkspaceBinding> = {};
  for (const [slot, value] of Object.entries(input ?? {})) {
    if (!known.has(slot)) {
      throw new WorkspaceBindingError(`Workflow "${definition.id}" has no workspace slot "${slot}"`);
    }
    const binding = typeof value === 'string' ? { path: value } : value;
    if (!binding.path) throw new WorkspaceBindingError(`Workspace slot "${slot}" is bound to an empty path`);
    bound[slot] = { ...binding, slot };
  }
  const missing = slots.filter((s) => s.required && !bound[s.name]).map((s) => s.name);
  if (missing.length > 0) {
    throw new WorkspaceBindingError(
      `Workflow "${definition.id}" needs a workspace for slot${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}`
    );
  }
  return bound;
}

/** `placement` with its working directory moved to `path` (an isolated copy). */
function withWorkspacePath(
  placement: ReturnType<typeof resolveNodeWorkspace>,
  path: string
): ReturnType<typeof resolveNodeWorkspace> {
  if (!placement.workspace) return placement;
  return {
    ...placement,
    workspace: { ...placement.workspace, path },
    ...(placement.manifest ? { manifest: { ...placement.manifest, path } } : {}),
  };
}

/** The binding a node works in, plus the read-only slots it asked for. */
function resolveNodeWorkspace(
  state: WorkflowRunState,
  compiledScope: CompiledGraphScope,
  node: AgentNode | ScriptNode
): { workspace?: RunWorkspaceBinding; readWorkspaces: RunWorkspaceBinding[]; manifest?: ManifestWorkspace } {
  const workspace = state.workspaces[compiledScope.workspaceSlots[node.id] ?? ''];
  const readWorkspaces =
    node.kind === 'agent'
      ? node.readWorkspaces.flatMap((slot) => (state.workspaces[slot] ? [state.workspaces[slot]!] : []))
      : [];
  return {
    ...(workspace ? { workspace } : {}),
    readWorkspaces,
    ...(workspace
      ? {
          manifest: {
            slot: workspace.slot,
            path: workspace.path,
            writeScopes: [...node.writeScopes],
            readOnly: readWorkspaces.map((w) => ({ slot: w.slot, path: w.path })),
          },
        }
      : {}),
  };
}

/** Output port a step can declare to hand its workspace diff downstream (e.g. to a reviewer). */
export const CHANGES_PORT = 'changes';

export class WriteScopeViolationError extends Error {
  readonly nodeId: string;
  readonly files: readonly string[];

  constructor(nodeId: string, files: readonly string[]) {
    super(`Step "${nodeId}" changed files outside its write scopes: ${files.join(', ')}`);
    this.name = 'WriteScopeViolationError';
    this.nodeId = nodeId;
    this.files = files;
  }
}

/** Changed files that fall outside every write scope (`.` or `*` allow everything). */
export function filesOutsideWriteScopes(
  files: readonly { readonly path: string }[],
  writeScopes: readonly string[]
): string[] {
  const scopes = writeScopes.map((s) => s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  if (scopes.some((s) => s === '' || s === '.' || s === '*')) return [];
  return files
    .map((f) => f.path)
    .filter((path) => !scopes.some((scope) => path === scope || path.startsWith(`${scope}/`)));
}

/** Failures that retrying the same step in the same place cannot fix. */
const isWorkspaceSettleError = (err: unknown) =>
  err instanceof WorkspaceMergeConflictError || err instanceof WriteScopeViolationError;

/** Script logs longer than this are stored as artifacts; the report keeps only their tail. */
const SCRIPT_LOG_INLINE_BYTES = 16 * 1024;

export class ChiefUnavailableError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" has no chief agent; turn on supervision in the workflow to talk to one`);
    this.name = 'ChiefUnavailableError';
  }
}

export class MissingAssessmentError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, detail: string) {
    super(
      `Reviewer node "${nodeId}" ${detail}; a review without a valid verdict counts as failed, never as PASS`
    );
    this.name = 'MissingAssessmentError';
    this.nodeId = nodeId;
  }
}

/**
 * Nodes that produce assessments must return a structured, valid verdict. Anything else is
 * a failed attempt (eligible for technical retries) so an unparseable review can't pass.
 */
function assertReviewVerdict(node: AgentNode, result: AgentExecutionResult): void {
  if (!node.producesAssessment || result.status !== 'COMPLETED') return;
  if (!result.assessment) {
    throw new MissingAssessmentError(node.id, 'returned no structured assessment');
  }
  if (!AssessmentVerdictSchema.safeParse(result.assessment.verdict).success) {
    throw new MissingAssessmentError(
      node.id,
      `returned invalid verdict ${JSON.stringify(result.assessment.verdict)}`
    );
  }
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
}

export class WorkflowRuntime {
  readonly store: RuntimeStore;
  readonly artifacts: ArtifactStore;
  readonly executor: Executor;
  readonly workspaces: WorkspaceManager;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly agentRegistry?: AgentRegistry;
  private readonly adapters: Readonly<Record<string, AgentAdapter>>;
  private readonly chiefSupervisor?: ChiefSupervisor;
  private commitLock: Promise<void> = Promise.resolve();
  private chiefLock: Promise<void> = Promise.resolve();
  /** Per-run event index the chief has already examined in this process. */
  private readonly chiefCursors = new Map<string, number>();

  constructor(options: WorkflowRuntimeOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new SequentialIdGenerator();
    this.store = options.store ?? new InMemoryRuntimeStore(this.clock);
    this.artifacts = options.artifacts ?? new InMemoryArtifactStore(this.clock);
    this.executor = options.executor;
    this.workspaces = options.workspaces ?? new InMemoryWorkspaceManager();
    this.agentRegistry = options.agentRegistry;
    this.adapters = options.adapters ?? {};
    this.chiefSupervisor = options.chief;
  }

  private resolveAgentAdapter(agent: PinnedAgent | undefined): AgentAdapter {
    const name = agent?.profile.runtime.adapter ?? DEFAULT_AGENT_ADAPTER;
    const adapter = this.adapters[name];
    if (adapter) return adapter;
    if (name === DEFAULT_AGENT_ADAPTER) return this.executor;
    throw new Error(
      `Agent "${agent?.ref}" requires adapter "${name}", but no such adapter is registered`
    );
  }

  private async withCommitLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.commitLock;
    let release!: () => void;
    this.commitLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async applyLinearizedMutation(
    runId: string,
    epoch: number,
    mutate: (latest: WorkflowRunState) => RunSnapshotState
  ): Promise<WorkflowRunState> {
    return await this.withCommitLock(async () => {
      const latest = await this.store.getRun(runId);
      if (!latest) {
        throw new Error(`Run "${runId}" not found`);
      }
      return await this.appendStateDiff(latest, mutate(latest), epoch, latest.revision);
    });
  }

  /** Persists only the delta between `base` and `nextState` as run log mutations. */
  private async appendStateDiff(
    base: WorkflowRunState,
    nextState: RunSnapshotState,
    epoch: number,
    expectedSeq: number
  ): Promise<WorkflowRunState> {
    const mutations = diffRunState(base, nextState);
    if (mutations.length === 0) {
      return base;
    }
    return await this.store.appendMutations({
      runId: base.runId,
      expectedSeq,
      coordinatorEpoch: epoch,
      mutations,
    });
  }

  /**
   * Gives a writing step its own copy of its workspace when its write policy asks for one
   * (it may run alongside other writers) and the workspace manager can make copies.
   */
  private async forkWorkspace(
    runId: string,
    attemptId: string,
    compiledScope: CompiledGraphScope,
    node: AgentNode | ScriptNode,
    workspace: RunWorkspaceBinding | undefined
  ): Promise<IsolatedWorkspace | null> {
    if (!workspace || !compiledScope.writePolicies[node.id]?.isolated || !this.workspaces.isolate) return null;
    return await this.workspaces.isolate({ runId, attemptId, nodeId: node.id, workspace });
  }

  /**
   * After a step ran: merges an isolated step's changes back into the workspace, and enforces
   * `enforceWriteScopes` (an isolated step's out-of-scope changes are dropped, never merged).
   */
  private async settleWorkspaceChanges(
    fork: IsolatedWorkspace | null,
    compiledScope: CompiledGraphScope,
    node: AgentNode | ScriptNode,
    reported: ExecutionChanges | undefined
  ): Promise<ExecutionChanges | undefined> {
    const enforce = compiledScope.writePolicies[node.id]?.enforceWriteScopes ?? false;
    if (fork) {
      if (enforce) {
        const outside = filesOutsideWriteScopes((await fork.changes()).files, node.writeScopes);
        if (outside.length > 0) {
          await fork.discard();
          throw new WriteScopeViolationError(node.id, outside);
        }
      }
      return await fork.integrate();
    }
    if (enforce && reported) {
      const outside = filesOutsideWriteScopes(reported.files, node.writeScopes);
      if (outside.length > 0) throw new WriteScopeViolationError(node.id, outside);
    }
    return reported;
  }

  /**
   * Stores what a step produced: artifacts it returned, its workspace diff (filling a declared
   * `changes` output the step left empty), and artifact-typed outputs it returned as plain values.
   */
  private async storeStepProducts(input: {
    runId: string;
    node: AgentNode | ScriptNode;
    attemptId: string;
    /** Plain output values; updated in place with artifact ids. */
    outputsRecord: Record<string, PortValueRecord>;
    artifacts?: Record<string, { content: string; mediaType?: string; summary?: string }>;
    changes?: ExecutionChanges;
    isolated?: boolean;
  }): Promise<{ producedArtifactIds: string[]; changes?: NodeAttemptRecord['changes'] }> {
    const { node, outputsRecord } = input;
    const producedArtifactIds: string[] = [];
    const put = async (portName: string, content: string, mediaType: string, summary?: string) => {
      const stored = await this.artifacts.put({
        content,
        mediaType,
        producerRunId: input.runId,
        producerNodeId: node.id,
        producerAttemptId: input.attemptId,
        portName,
        ...(summary ? { summary } : {}),
      });
      producedArtifactIds.push(stored.artifactId);
      return stored.artifactId;
    };

    for (const [portName, art] of Object.entries(input.artifacts ?? {})) {
      const artifactId = await put(portName, art.content, art.mediaType ?? 'text/markdown', art.summary);
      outputsRecord[portName] = { value: outputsRecord[portName]?.value ?? art.content, artifactId };
    }

    let changes: AttemptChanges | undefined;
    if (input.changes) {
      const wantsPort = node.outputs.some((p) => p.name === CHANGES_PORT) && !outputsRecord[CHANGES_PORT];
      const outOfScope = filesOutsideWriteScopes(input.changes.files, node.writeScopes);
      const extra = {
        ...(outOfScope.length > 0 ? { outOfScope } : {}),
        ...(input.isolated ? { isolated: true } : {}),
      };
      if (input.changes.files.length > 0 || wantsPort) {
        const summary = `${input.changes.files.length} file(s) changed`;
        const artifactId = await put(CHANGES_PORT, input.changes.diff, 'text/x-diff', summary);
        changes = { artifactId, files: input.changes.files, ...extra };
        if (wantsPort) outputsRecord[CHANGES_PORT] = { value: input.changes.diff, artifactId };
      } else {
        changes = { files: [], ...extra };
      }
    }

    // Artifact-typed outputs returned as plain values are stored as artifacts too.
    for (const outPort of node.outputs) {
      const record = outputsRecord[outPort.name];
      if (outPort.type === 'artifact' && record && !record.artifactId) {
        const raw = record.value;
        const artifactId = await put(
          outPort.name,
          typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
          typeof raw === 'string' ? 'text/plain' : 'application/json'
        );
        outputsRecord[outPort.name] = { value: raw, artifactId };
      }
    }
    return { producedArtifactIds, ...(changes ? { changes } : {}) };
  }

  private ensurePlan(definition: WorkflowDefinition | CompiledWorkflowPlan): CompiledWorkflowPlan {
    if ('rootScope' in definition && 'definitionDigest' in definition) {
      return definition;
    }
    return compileWorkflowDefinition(definition);
  }

  private nextUniqueId(prefix: string, existing?: Readonly<Record<string, unknown>>): string {
    while (true) {
      const candidate = this.idGenerator.nextId(prefix);
      if (!existing || !(candidate in existing)) {
        return candidate;
      }
    }
  }

  async start(input: StartWorkflowRunInput): Promise<WorkflowRunState> {
    const plan = this.ensurePlan(input.definition);
    const workspaces = bindRunWorkspaces(plan.definition, input.workspaces);
    const runId = input.runId ?? this.idGenerator.nextId('run');
    const now = this.clock.nowMs();

    const rootInputs: Record<string, PortValueRecord> = {};
    for (const [key, val] of Object.entries(input.inputs ?? {})) {
      rootInputs[key] = { value: val };
    }

    const rootScopeState = createInitialScopeState(plan.rootScope, '$root', rootInputs);
    const startedEvent: WorkflowEvent = {
      type: 'run.started',
      runId,
      definitionId: plan.definition.id,
      definitionDigest: plan.definitionDigest,
      timestampMs: now,
    };

    const initialState: RunSnapshotState = {
      runId,
      definition: plan.definition,
      definitionDigest: plan.definitionDigest,
      status: 'RUNNING',
      inputs: { ...(input.inputs ?? {}) },
      outputs: {},
      scopes: {
        $root: rootScopeState,
      },
      attempts: {},
      manifests: {},
      assessments: {},
      waitRequests: {},
      readReceipts: [],
      events: [startedEvent],
      workspaces,
      pinnedAgents: {},
      chief: EMPTY_CHIEF_RUN_STATE,
      createdAtMs: now,
    };

    return await this.store.createRun(initialState);
  }

  /**
   * Advances the workflow until it reaches `SUCCEEDED`, `FAILED`, `CANCELLED`, or `WAITING` (paused at a Gate/WaitRequest).
   */
  async runUntilSettled(
    runId: string,
    options?: { coordinatorEpoch?: number; signal?: AbortSignal }
  ): Promise<WorkflowRunState> {
    let state = await this.store.getRun(runId);
    if (!state) {
      throw new Error(`Run "${runId}" not found`);
    }

    let epoch = options?.coordinatorEpoch ?? state.coordinatorEpoch;
    if (options?.coordinatorEpoch === undefined && state.status !== 'RUNNING') {
      const leased = await this.store.acquireCoordinatorEpoch(runId);
      epoch = leased.epoch;
      state = leased.state;
    }

    const plan = compileWorkflowDefinition(state.definition);

    while (state.status === 'RUNNING') {
      options?.signal?.throwIfAborted();
      const stepped = await this.stepScope(plan, state, '$root', plan.rootScope, epoch, options?.signal);
      state = stepped.state;
      if (!stepped.progressed) {
        if (state.status !== 'RUNNING') break;
        // RUNNING with nothing runnable: give the chief a chance before giving up.
        const before = state.revision;
        state = await this.supervise(plan, state, epoch, options?.signal, { stalled: true });
        if (state.revision === before) break;
      }
    }

    return state;
  }

  /**
   * Resume a paused or interrupted workflow run under a fresh coordinator epoch fence.
   */
  async resume(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunState> {
    const { epoch, state } = await this.store.acquireCoordinatorEpoch(runId);
    if (state.status === 'SUCCEEDED' || state.status === 'FAILED' || state.status === 'CANCELLED') {
      return state;
    }
    return await this.runUntilSettled(runId, { coordinatorEpoch: epoch, signal: options?.signal });
  }

  /**
   * Respond to a pending `WaitRequest` (human decision gate or agent question).
   * Idempotent when called repeatedly with the same `requestId` and answer.
   */
  async respond(input: {
    runId: string;
    requestId: string;
    answer: string | Record<string, unknown>;
    responderId: string;
    expectedRevision?: number;
    autoResume?: boolean;
  }): Promise<WorkflowRunState> {
    const current = await this.store.getRun(input.runId);
    if (!current) {
      throw new Error(`Run "${input.runId}" not found`);
    }

    const plan = compileWorkflowDefinition(current.definition);
    const nextState = resolveWaitRequestInState(plan, current, {
      requestId: input.requestId,
      answer: input.answer,
      responderId: input.responderId,
      nowMs: this.clock.nowMs(),
    });
    if (!nextState) {
      return current;
    }

    const committed = await this.withCommitLock(async () =>
      this.appendStateDiff(
        current,
        nextState,
        current.coordinatorEpoch,
        input.expectedRevision ?? current.revision
      )
    );

    if (input.autoResume === false) {
      return committed;
    }
    // An answered escalation may leave a failed run terminal until the chief acts on it.
    const afterChief = await this.supervise(plan, committed, committed.coordinatorEpoch);
    if (afterChief.status === 'RUNNING') {
      return await this.runUntilSettled(afterChief.runId, {
        coordinatorEpoch: afterChief.coordinatorEpoch,
      });
    }
    return afterChief;
  }

  /**
   * Invalidates `targetNodeId` and only its reachable downstream subgraph (`STALE`),
   * leaving unrelated parallel branches intact, and optionally runs to completion.
   */
  async rerunFromNode(input: {
    runId: string;
    nodeId: string;
    scopeKey?: string;
    overrideInputs?: Record<string, unknown>;
    autoRun?: boolean;
  }): Promise<WorkflowRunState> {
    const { epoch, state } = await this.store.acquireCoordinatorEpoch(input.runId);
    const plan = compileWorkflowDefinition(state.definition);
    const scopeKey = input.scopeKey ?? '$root';

    const invalidated = invalidateSubgraphForRerun(
      plan,
      state,
      input.nodeId,
      scopeKey,
      this.clock.nowMs()
    );

    let nextScopes = invalidated.nextState.scopes;
    let nextInputs = invalidated.nextState.inputs;
    if (input.overrideInputs && scopeKey === '$root') {
      nextInputs = { ...nextInputs, ...input.overrideInputs };
      const rootScope = nextScopes.$root!;
      const updatedRootInputs = { ...rootScope.inputs };
      for (const [k, v] of Object.entries(input.overrideInputs)) {
        updatedRootInputs[k] = { value: v };
      }
      nextScopes = {
        ...nextScopes,
        $root: {
          ...rootScope,
          inputs: updatedRootInputs,
        },
      };
    }

    const committed = await this.withCommitLock(async () =>
      this.appendStateDiff(
        state,
        {
          ...invalidated.nextState,
          inputs: nextInputs,
          scopes: nextScopes,
        },
        epoch,
        state.revision
      )
    );

    if (input.autoRun !== false) {
      return await this.runUntilSettled(committed.runId, { coordinatorEpoch: epoch });
    }
    return committed;
  }

  private resolveCompiledScope(plan: CompiledWorkflowPlan, scopeKey: string): CompiledGraphScope {
    return resolveCompiledScopeByKey(plan, scopeKey);
  }

  private async stepScope(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    epoch: number,
    signal?: AbortSignal
  ): Promise<{ state: WorkflowRunState; progressed: boolean }> {
    const startRevision = state.revision;
    // An open chief escalation parks every scope until a human answers it.
    state = await this.supervise(plan, state, epoch, signal);
    if (state.chief.pendingEscalationId) {
      return { state, progressed: false };
    }

    const rawScope = state.scopes[scopeKey];
    if (!rawScope) {
      return { state, progressed: false };
    }

    // 1. Reduce dead-path SKIPPED nodes and scope outputs
    const reducedScope = reduceScopeTransitions(compiledScope, rawScope);
    if (
      canonicalizeJsonValue(reducedScope) !== canonicalizeJsonValue(rawScope) ||
      (scopeKey === '$root' && reducedScope.status !== state.status)
    ) {
      state = await this.commitNodeOrScopeTransition(plan, state.runId, scopeKey, compiledScope, epoch, () => ({
        scopeOverride: reducedScope,
      }));
      if (state.status !== 'RUNNING') {
        return { state, progressed: true };
      }
    }

    // 2. Compute conflict-free Ready Set in this scope
    const readyNodeIds = computeScopeReadyNodeIds(compiledScope, state.scopes[scopeKey]!);
    if (readyNodeIds.length === 0) {
      return { state, progressed: state.revision !== startRevision };
    }

    // 3. Execute all conflict-free ready nodes concurrently!
    if (readyNodeIds.length === 1) {
      state = await this.executeNodeInScope(
        plan,
        state,
        scopeKey,
        compiledScope,
        readyNodeIds[0]!,
        epoch,
        signal
      );
    } else {
      await Promise.all(
        readyNodeIds.map((nodeId) =>
          this.executeNodeInScope(plan, state, scopeKey, compiledScope, nodeId, epoch, signal)
        )
      );
      state = (await this.store.getRun(state.runId)) ?? state;
    }

    // 4. Let the chief react to what just happened before the caller inspects the scope.
    state = await this.supervise(plan, state, epoch, signal);
    // Progress means something was committed; a paused container leaves the log untouched.
    return { state, progressed: state.revision !== startRevision };
  }

  private async withChiefLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chiefLock;
    let release!: () => void;
    this.chiefLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Consults the chief for triggers raised since its last look (and for `stalled` runs),
   * then applies each decision through the policy filter as one logged transition.
   */
  /**
   * Records a human's message to the run's chief (as a `chief.user_message` event) without
   * waiting for the answer; call `answerChiefMessage` to have the chief reply and act.
   */
  async postChiefMessage(input: {
    runId: string;
    text: string;
    authorId: string;
  }): Promise<{ state: WorkflowRunState; messageId: string }> {
    const text = input.text.trim();
    if (!text) throw new Error('The message is empty');
    return await this.withCommitLock(async () => {
      const latest = await this.store.getRun(input.runId);
      if (!latest) throw new Error(`Run "${input.runId}" not found`);
      if (!latest.definition.chief) throw new ChiefUnavailableError(input.runId);
      const messageId = this.nextUniqueId('msg');
      const event: WorkflowEvent = {
        type: 'chief.user_message',
        runId: latest.runId,
        messageId,
        text,
        authorId: input.authorId,
        timestampMs: this.clock.nowMs(),
      };
      const state = await this.appendStateDiff(
        latest,
        { ...latest, events: [...latest.events, event] },
        latest.coordinatorEpoch,
        latest.revision
      );
      return { state, messageId };
    });
  }

  /**
   * Has the chief answer a `chief.user_message`: it replies in plain language and may issue
   * commands, which are checked against the run's chief policy like any other intervention.
   * A run the commands set running again (e.g. a rerun) still needs a driver.
   */
  async answerChiefMessage(input: { runId: string; messageId: string; signal?: AbortSignal }): Promise<WorkflowRunState> {
    const supervisor = this.chiefSupervisor;
    const initial = await this.store.getRun(input.runId);
    if (!initial) throw new Error(`Run "${input.runId}" not found`);
    const policy = initial.definition.chief;
    if (!policy || !supervisor) throw new ChiefUnavailableError(input.runId);
    const message = initial.events.find(
      (e): e is Extract<WorkflowEvent, { type: 'chief.user_message' }> =>
        e.type === 'chief.user_message' && e.messageId === input.messageId
    );
    if (!message) throw new Error(`Message "${input.messageId}" not found in run "${input.runId}"`);
    const plan = compileWorkflowDefinition(initial.definition);

    return await this.withChiefLock(async () => {
      const latest = (await this.store.getRun(input.runId)) ?? initial;
      const trigger: ChiefTrigger = { kind: 'user.message', messageId: message.messageId, detail: message.text };
      const chiefAgent = policy.agentRef
        ? await pinAgent(this.agentRegistry, latest, policy.agentRef).catch(() => undefined)
        : undefined;
      let decision: ChiefDecision;
      try {
        decision = await supervisor.review({
          plan,
          state: latest,
          policy,
          trigger,
          ...(chiefAgent ? { chiefAgent } : {}),
          adapter: this.resolveAgentAdapter(chiefAgent),
          allowedCommands: allowedChiefCommands(policy),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        if (isAbortError(err, input.signal)) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        decision = { rationale: `Chief review failed: ${reason}`, reply: `I could not answer: ${reason}`, commands: [] };
      }
      const resolvedAgents: Record<string, PinnedAgent> = {};
      for (const command of decision.commands) {
        if (command.kind !== 'swap_agent') continue;
        const pinned = await pinAgent(this.agentRegistry, latest, command.agentRef).catch(() => undefined);
        if (pinned) resolvedAgents[command.agentRef] = pinned;
      }
      return await this.applyLinearizedMutation(input.runId, latest.coordinatorEpoch, (fresh) =>
        applyChiefDecision({
          plan,
          state: fresh,
          policy,
          trigger,
          decision,
          processedEventCount: fresh.chief.processedEventCount,
          ...(chiefAgent ? { chiefAgent } : {}),
          resolvedAgents,
          nowMs: this.clock.nowMs(),
          newId: (prefix) => this.nextUniqueId(prefix, fresh.waitRequests),
        }).nextState
      );
    });
  }

  private async supervise(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    epoch: number,
    signal?: AbortSignal,
    options: { stalled?: boolean } = {}
  ): Promise<WorkflowRunState> {
    const policy = plan.definition.chief;
    if (!policy || !this.chiefSupervisor) return state;
    const runId = state.runId;
    const seen = Math.max(this.chiefCursors.get(runId) ?? 0, state.chief.processedEventCount);
    if (!options.stalled && seen >= state.events.length) return state;

    const supervisor = this.chiefSupervisor;
    return await this.withChiefLock(async () => {
      let latest = (await this.store.getRun(runId)) ?? state;
      if (latest.coordinatorEpoch !== epoch) return latest;

      const fromEventIndex = Math.max(
        this.chiefCursors.get(runId) ?? 0,
        latest.chief.processedEventCount
      );
      const triggers = detectChiefTriggers(plan, latest, policy, {
        fromEventIndex,
        stalled: options.stalled,
      });
      const processedEventCount = latest.events.length;
      this.chiefCursors.set(runId, processedEventCount);

      for (const trigger of triggers) {
        if (
          latest.chief.interventionCount >= policy.maxInterventionsPerRun ||
          latest.chief.pendingEscalationId
        ) {
          break;
        }
        const chiefAgent = policy.agentRef
          ? await pinAgent(this.agentRegistry, latest, policy.agentRef).catch(() => undefined)
          : undefined;

        let decision: ChiefDecision;
        try {
          decision = await supervisor.review({
            plan,
            state: latest,
            policy,
            trigger,
            ...(chiefAgent ? { chiefAgent } : {}),
            adapter: this.resolveAgentAdapter(chiefAgent),
            allowedCommands: allowedChiefCommands(policy),
            ...(signal ? { signal } : {}),
          });
        } catch (err) {
          if (isAbortError(err, signal)) throw err;
          const message = err instanceof Error ? err.message : String(err);
          decision = { rationale: `Chief review failed: ${message}`, commands: [] };
        }

        const resolvedAgents: Record<string, PinnedAgent> = {};
        for (const command of decision.commands) {
          if (command.kind !== 'swap_agent') continue;
          const pinned = await pinAgent(this.agentRegistry, latest, command.agentRef).catch(
            () => undefined
          );
          if (pinned) resolvedAgents[command.agentRef] = pinned;
        }

        latest = await this.applyLinearizedMutation(runId, epoch, (fresh) =>
          applyChiefDecision({
            plan,
            state: fresh,
            policy,
            trigger,
            decision,
            processedEventCount,
            ...(chiefAgent ? { chiefAgent } : {}),
            resolvedAgents,
            nowMs: this.clock.nowMs(),
            newId: (prefix) => this.nextUniqueId(prefix, fresh.waitRequests),
          }).nextState
        );
      }
      return latest;
    });
  }

  private async executeNodeInScope(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    nodeId: string,
    epoch: number,
    signal?: AbortSignal
  ): Promise<WorkflowRunState> {
    const node = compiledScope.nodesById[nodeId]!;
    switch (node.kind) {
      case 'agent':
        return await this.executeAgentNode(plan, state, scopeKey, compiledScope, node, epoch, signal);
      case 'script':
        return await this.executeScriptNode(plan, state, scopeKey, compiledScope, node, epoch, signal);
      case 'gate':
        return await this.executeGateNode(plan, state, scopeKey, compiledScope, node, epoch);
      case 'loop':
        return await this.executeLoopNode(plan, state, scopeKey, compiledScope, node, epoch, signal);
      case 'parallel':
        return await this.executeParallelNode(plan, state, scopeKey, compiledScope, node, epoch, signal);
    }
  }

  private resolveNodeInputsFromDataEdges(
    compiledScope: CompiledGraphScope,
    scopeState: GraphScopeState,
    nodeId: string
  ): Record<string, PortValueRecord> {
    const bound: Record<string, PortValueRecord> = {};
    for (const edge of compiledScope.incomingDataEdges[nodeId] ?? []) {
      if (edge.fromNodeId === '$input') {
        const val = scopeState.inputs[edge.fromPort];
        if (val !== undefined) bound[edge.toPort] = val;
      } else {
        const up = scopeState.nodes[edge.fromNodeId]?.outputs[edge.fromPort];
        if (up !== undefined) bound[edge.toPort] = up;
      }
    }
    return bound;
  }

  /**
   * Executes an `AgentNode` following the 4-phase stage lifecycle:
   * `open -> prepare -> accept -> publish`
   */
  private async executeAgentNode(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    node: AgentNode,
    epoch: number,
    signal?: AbortSignal
  ): Promise<WorkflowRunState> {
    const scopeState = state.scopes[scopeKey]!;
    const prevNodeState = scopeState.nodes[node.id]!;
    const attemptId = this.nextUniqueId('att', state.attempts);
    const invocationId = this.nextUniqueId('inv');
    const roundIndex = scopeState.roundIndex ?? 0;

    // Check if resuming from a resolved WaitRequest on this node
    const resolvedWait = prevNodeState.activeWaitRequestId
      ? state.waitRequests[prevNodeState.activeWaitRequestId]
      : undefined;

    // Resolve the delegated agent (pinned per run) before taking any lease
    let agent: PinnedAgent | undefined;
    let agentAdapter: AgentAdapter;
    const agentRef = resolveEffectiveAgentRef(plan, scopeKey, node, state.chief);
    try {
      agent = agentRef ? await pinAgent(this.agentRegistry, state, agentRef) : undefined;
      agentAdapter = this.resolveAgentAdapter(agent);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const failedAtMs = this.clock.nowMs();
      return await this.commitNodeOrScopeTransition(
        plan,
        state.runId,
        scopeKey,
        compiledScope,
        epoch,
        (latestScope) => ({
          nodeId: node.id,
          nodeState: {
            ...latestScope.nodes[node.id]!,
            status: 'FAILED',
            latestAttemptId: attemptId,
            error: errorMessage,
            activeWaitRequestId: undefined,
          },
          attempt: {
            attemptId,
            invocationId,
            runId: state.runId,
            scopeKey,
            nodeId: node.id,
            retryIndex: prevNodeState.retryCount,
            roundIndex,
            phase: 'open',
            status: 'FAILED',
            producedArtifactIds: [],
            error: errorMessage,
            startedAtMs: failedAtMs,
            completedAtMs: failedAtMs,
          },
          events: [
            {
              type: 'node.completed',
              runId: state.runId,
              scopeKey,
              nodeId: node.id,
              attemptId,
              status: 'FAILED',
              timestampMs: failedAtMs,
            },
          ],
        })
      );
    }
    const agentStamp = agent
      ? { ref: agent.ref, agentId: agent.agentId, version: agent.version, digest: agent.digest }
      : undefined;
    const chiefGuidance = state.chief.guidance
      .filter((g) => g.nodeId === node.id && (g.scopeKey === undefined || g.scopeKey === scopeKey))
      .map((g) => g.text);

    const bound = resolveNodeWorkspace(state, compiledScope, node);
    // A step that may write alongside others works in its own copy, merged back afterwards.
    const fork = await this.forkWorkspace(state.runId, attemptId, compiledScope, node, bound.workspace);
    let forkSettled = false;
    const placement = fork ? withWorkspacePath(bound, fork.path) : bound;

    // PHASE 1: OPEN (acquire write lease, create attempt record). An isolated step needs no
    // lease: nobody else writes in its copy.
    const lease = await this.workspaces.acquireLease({
      runId: state.runId,
      attemptId,
      writeScopes: fork ? [] : node.writeScopes,
      ...(placement.workspace ? { workspace: placement.workspace.path } : {}),
    });

    try {
      // Gather prior round feedback if inside a LoopNode round > 0
      const priorFeedbackRaw = scopeState.inputs.__priorRoundFeedback?.value as
        | {
            roundIndex: number;
            verdict: string;
            summary: string;
            findings: { severity: string; message: string; filePath?: string }[];
          }
        | undefined;

      // PHASE 2: PREPARE (freeze ContextManifest along incoming DataEdges)
      const bundle = await buildDataEdgeContextBundle({
        runId: state.runId,
        scopeKey,
        attemptId,
        node,
        compiledScope,
        scopeState,
        artifactStore: this.artifacts,
        clock: this.clock,
        idGenerator: this.idGenerator,
        agent,
        chiefGuidance,
        ...(placement.manifest ? { workspace: placement.manifest } : {}),
        priorRoundFeedback: priorFeedbackRaw,
      });

      const artifactReader = createScopedArtifactReader({
        manifest: bundle.manifest,
        artifactStore: this.artifacts,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });

      const startedAtMs = this.clock.nowMs();
      let execResult;
      let retryCount = prevNodeState.retryCount;

      while (true) {
        try {
          execResult = await agentAdapter.executeAgent({
            runId: state.runId,
            scopeKey,
            attemptId,
            invocationId,
            node,
            agent,
            manifest: bundle.manifest,
            renderedPrompt: bundle.renderedPrompt,
            inputs: bundle.resolvedInputs,
            artifactReader,
            ...(placement.workspace ? { workspace: placement.workspace } : {}),
            ...(placement.readWorkspaces.length ? { readWorkspaces: placement.readWorkspaces } : {}),
            ...(fork ? { isolated: true } : {}),
            resumeSessionBinding: resolvedWait?.sessionBinding,
            humanAnswer: resolvedWait?.response
              ? {
                  answer: resolvedWait.response.answer,
                  responderId: resolvedWait.response.responderId,
                }
              : undefined,
            signal,
          });
          assertReviewVerdict(node, execResult);
          forkSettled = fork !== null;
          const changes = await this.settleWorkspaceChanges(fork, compiledScope, node, execResult.changes);
          execResult = { ...execResult, ...(changes ? { changes } : {}) };
          break;
        } catch (err) {
          if (isAbortError(err, signal)) {
            throw err;
          }
          if (retryCount < node.maxTechnicalRetries && !isWorkspaceSettleError(err)) {
            retryCount += 1;
            continue;
          }
          const failedAtMs = this.clock.nowMs();
          const errorMessage = err instanceof Error ? err.message : String(err);
          const failedAttempt: NodeAttemptRecord = {
            attemptId,
            invocationId,
            runId: state.runId,
            scopeKey,
            nodeId: node.id,
            ...(agentStamp ? { agent: agentStamp } : {}),
            retryIndex: retryCount,
            roundIndex,
            phase: 'publish',
            status: 'FAILED',
            contextManifestId: bundle.manifest.manifestId,
            producedArtifactIds: [],
            error: errorMessage,
            receipt: {
              attemptId,
              durationMs: Math.max(0, failedAtMs - startedAtMs),
            },
            startedAtMs,
            completedAtMs: failedAtMs,
          };

          return await this.commitNodeOrScopeTransition(
            plan,
            state.runId,
            scopeKey,
            compiledScope,
            epoch,
            (latestScope) => ({
              nodeId: node.id,
              nodeState: {
                ...latestScope.nodes[node.id]!,
                status: 'FAILED',
                latestAttemptId: attemptId,
                retryCount,
                error: errorMessage,
                activeWaitRequestId: undefined,
              },
              attempt: failedAttempt,
              manifest: bundle.manifest,
              pinnedAgent: agent,
              readReceipts: artifactReader.getReceipts(),
              events: [
                {
                  type: 'node.completed',
                  runId: state.runId,
                  scopeKey,
                  nodeId: node.id,
                  attemptId,
                  status: 'FAILED',
                  timestampMs: failedAtMs,
                },
              ],
            })
          );
        }
      }

      const now = this.clock.nowMs();

      // Handle mid-turn WaitRequest from Agent
      if (execResult.status === 'WAIT_REQUESTED' && execResult.waitRequest) {
        const requestId = this.nextUniqueId('wait', state.waitRequests);
        const waitRequest: WaitRequest = {
          requestId,
          runId: state.runId,
          scopeKey,
          nodeId: node.id,
          attemptId,
          prompt: execResult.waitRequest.prompt,
          options: execResult.waitRequest.options ?? [],
          requiredRole: execResult.waitRequest.requiredRole,
          ...(execResult.receipt?.sessionId && execResult.receipt?.acpSessionId
            ? {
                sessionBinding: {
                  sessionId: execResult.receipt.sessionId,
                  acpSessionId: execResult.receipt.acpSessionId,
                  agentType: execResult.receipt.agentType ?? node.agentType ?? node.role,
                },
              }
            : {}),
          status: 'PENDING',
          createdAtMs: now,
        };

        const attemptRecord: NodeAttemptRecord = {
          attemptId,
          invocationId,
          runId: state.runId,
          scopeKey,
          nodeId: node.id,
          ...(agentStamp ? { agent: agentStamp } : {}),
          retryIndex: retryCount,
          roundIndex,
          phase: 'accept',
          status: 'WAITING',
          contextManifestId: bundle.manifest.manifestId,
          producedArtifactIds: [],
          startedAtMs,
        };

        return await this.commitNodeOrScopeTransition(
          plan,
          state.runId,
          scopeKey,
          compiledScope,
          epoch,
          (latestScope) => ({
            nodeId: node.id,
            nodeState: {
              ...latestScope.nodes[node.id]!,
              status: 'WAITING',
              latestAttemptId: attemptId,
              retryCount,
              activeWaitRequestId: requestId,
            },
            attempt: attemptRecord,
            manifest: bundle.manifest,
            pinnedAgent: agent,
            waitRequest,
            readReceipts: artifactReader.getReceipts(),
            events: [
              {
                type: 'node.waiting',
                runId: state.runId,
                scopeKey,
                nodeId: node.id,
                attemptId,
                requestId,
                prompt: waitRequest.prompt,
                timestampMs: now,
              },
            ],
          })
        );
      }

      // PHASE 3: ACCEPT (store produced artifacts, validate outputs & assessments)
      const outputsRecord: Record<string, PortValueRecord> = {};
      for (const [portName, val] of Object.entries(execResult.outputs ?? {})) {
        outputsRecord[portName] = { value: val };
      }
      const { producedArtifactIds, changes } = await this.storeStepProducts({
        runId: state.runId,
        node,
        attemptId,
        outputsRecord,
        ...(execResult.artifacts ? { artifacts: execResult.artifacts } : {}),
        ...(execResult.changes ? { changes: execResult.changes } : {}),
        ...(fork ? { isolated: true } : {}),
      });

      let assessmentRecord: AssessmentRecord | undefined;
      if (execResult.assessment) {
        const assessmentId = this.nextUniqueId('assess', state.assessments);
        assessmentRecord = {
          assessmentId,
          runId: state.runId,
          nodeId: node.id,
          attemptId,
          targetArtifactIds: bundle.manifest.authorizedArtifactIds,
          verdict: execResult.assessment.verdict,
          summary: execResult.assessment.summary,
          findings: execResult.assessment.findings ?? [],
          independentReviewer: node.producesAssessment,
          stale: false,
          createdAtMs: now,
        };
        for (const outPort of node.outputs) {
          if (outPort.type === 'assessment' && !outputsRecord[outPort.name]) {
            outputsRecord[outPort.name] = { value: assessmentRecord };
          }
        }
      }

      // PHASE 4: PUBLISH (atomic CAS + CoordinatorEpoch commit)
      const attemptRecord: NodeAttemptRecord = {
        attemptId,
        invocationId,
        runId: state.runId,
        scopeKey,
        nodeId: node.id,
        ...(agentStamp ? { agent: agentStamp } : {}),
        retryIndex: retryCount,
        roundIndex,
        phase: 'publish',
        status: 'SUCCEEDED',
        contextManifestId: bundle.manifest.manifestId,
        producedArtifactIds,
        ...(changes ? { changes } : {}),
        ...(assessmentRecord ? { assessmentId: assessmentRecord.assessmentId } : {}),
        receipt: {
          attemptId,
          durationMs: Math.max(0, now - startedAtMs),
          ...execResult.receipt,
        },
        startedAtMs,
        completedAtMs: now,
      };

      return await this.commitNodeOrScopeTransition(
        plan,
        state.runId,
        scopeKey,
        compiledScope,
        epoch,
        () => ({
          nodeId: node.id,
          nodeState: {
            nodeId: node.id,
            status: 'SUCCEEDED',
            latestAttemptId: attemptId,
            retryCount,
            outputs: outputsRecord,
            latestVerdict: assessmentRecord?.verdict,
            latestAssessmentId: assessmentRecord?.assessmentId,
            activeWaitRequestId: undefined,
          },
          attempt: attemptRecord,
          manifest: bundle.manifest,
          pinnedAgent: agent,
          assessment: assessmentRecord,
          readReceipts: artifactReader.getReceipts(),
          events: [
            {
              type: 'node.completed',
              runId: state.runId,
              scopeKey,
              nodeId: node.id,
              attemptId,
              status: 'SUCCEEDED',
              ...(assessmentRecord ? { verdict: assessmentRecord.verdict } : {}),
              timestampMs: now,
            },
          ],
        })
      );
    } finally {
      if (fork && !forkSettled) await fork.discard().catch(() => undefined);
      await this.workspaces.releaseLease(lease.leaseId);
    }
  }

  private async executeScriptNode(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    node: ScriptNode,
    epoch: number,
    signal?: AbortSignal
  ): Promise<WorkflowRunState> {
    const scopeState = state.scopes[scopeKey]!;
    const prevNodeState = scopeState.nodes[node.id]!;
    const attemptId = this.nextUniqueId('att', state.attempts);
    const invocationId = this.nextUniqueId('inv');
    const roundIndex = scopeState.roundIndex ?? 0;

    const boundPorts = this.resolveNodeInputsFromDataEdges(compiledScope, scopeState, node.id);
    const resolvedInputs: Record<string, unknown> = {};
    const targetArtifactIds: string[] = [];
    for (const [k, v] of Object.entries(boundPorts)) {
      resolvedInputs[k] = v.value;
      if (v.artifactId) targetArtifactIds.push(v.artifactId);
    }

    const bound = resolveNodeWorkspace(state, compiledScope, node).workspace;
    const fork = await this.forkWorkspace(state.runId, attemptId, compiledScope, node, bound);
    let forkSettled = false;
    const workspace = fork && bound ? { ...bound, path: fork.path } : bound;
    const lease = await this.workspaces.acquireLease({
      runId: state.runId,
      attemptId,
      writeScopes: fork ? [] : node.writeScopes,
      ...(workspace ? { workspace: workspace.path } : {}),
    });

    try {
      const startedAtMs = this.clock.nowMs();
      let scriptRes;
      try {
        scriptRes = await this.executor.executeScript({
          runId: state.runId,
          scopeKey,
          attemptId,
          invocationId,
          node,
          inputs: resolvedInputs,
          ...(workspace ? { workspace } : {}),
          ...(fork ? { isolated: true } : {}),
          signal,
        });
        forkSettled = fork !== null;
        const changes = await this.settleWorkspaceChanges(fork, compiledScope, node, scriptRes.changes);
        scriptRes = { ...scriptRes, ...(changes ? { changes } : {}) };
      } catch (err) {
        if (isAbortError(err, signal)) {
          throw err;
        }
        const failedAtMs = this.clock.nowMs();
        const errorMessage = err instanceof Error ? err.message : String(err);
        const failedAttempt: NodeAttemptRecord = {
          attemptId,
          invocationId,
          runId: state.runId,
          scopeKey,
          nodeId: node.id,
          retryIndex: prevNodeState.retryCount,
          roundIndex,
          phase: 'publish',
          status: 'FAILED',
          producedArtifactIds: [],
          error: errorMessage,
          receipt: {
            attemptId,
            durationMs: Math.max(0, failedAtMs - startedAtMs),
          },
          startedAtMs,
          completedAtMs: failedAtMs,
        };
        return await this.commitNodeOrScopeTransition(
          plan,
          state.runId,
          scopeKey,
          compiledScope,
          epoch,
          (latestScope) => ({
            nodeId: node.id,
            nodeState: {
              ...latestScope.nodes[node.id]!,
              status: 'FAILED',
              latestAttemptId: attemptId,
              error: errorMessage,
            },
            attempt: failedAttempt,
            events: [
              {
                type: 'node.completed',
                runId: state.runId,
                scopeKey,
                nodeId: node.id,
                attemptId,
                status: 'FAILED',
                timestampMs: failedAtMs,
              },
            ],
          })
        );
      }

      const now = this.clock.nowMs();

      const verdict: AssessmentVerdict =
        scriptRes.assessment?.verdict ?? (scriptRes.exitCode === 0 ? 'PASS' : 'NEEDS_FIX');
      const summary =
        scriptRes.assessment?.summary ??
        (scriptRes.exitCode === 0
          ? `Script "${node.command}" succeeded (exit 0)`
          : `Script "${node.command}" exited with code ${scriptRes.exitCode}: ${scriptRes.stderr.slice(0, 300)}`);

      let assessmentRecord: AssessmentRecord | undefined;
      if (node.producesAssessment) {
        const assessmentId = this.nextUniqueId('assess', state.assessments);
        assessmentRecord = {
          assessmentId,
          runId: state.runId,
          nodeId: node.id,
          attemptId,
          targetArtifactIds,
          verdict,
          summary,
          findings:
            scriptRes.assessment?.findings ??
            (scriptRes.exitCode !== 0
              ? [
                  {
                    id: `script_exit_${scriptRes.exitCode}`,
                    severity: 'major',
                    message: (scriptRes.stderr || scriptRes.stdout || summary).trim(),
                  },
                ]
              : []),
          independentReviewer: true,
          stale: false,
          createdAtMs: now,
        };
      }

      // Long logs stay out of the run state: keep their tail inline and the full text as an artifact.
      const logArtifactIds: string[] = [];
      const keepLog = async (name: 'stdout' | 'stderr', text: string) => {
        if (Buffer.byteLength(text) <= SCRIPT_LOG_INLINE_BYTES) return { [name]: text };
        const stored = await this.artifacts.put({
          content: text,
          mediaType: 'text/plain',
          producerRunId: state.runId,
          producerNodeId: node.id,
          producerAttemptId: attemptId,
          portName: `$${name}`,
        });
        logArtifactIds.push(stored.artifactId);
        return { [name]: `…${text.slice(-SCRIPT_LOG_INLINE_BYTES)}`, [`${name}ArtifactId`]: stored.artifactId };
      };
      const defaultReport = {
        exitCode: scriptRes.exitCode,
        ...(await keepLog('stdout', scriptRes.stdout)),
        ...(await keepLog('stderr', scriptRes.stderr)),
        verdict,
      };
      const outputsRecord: Record<string, PortValueRecord> = {};
      for (const outPort of node.outputs) {
        const customVal = scriptRes.outputs?.[outPort.name];
        if (customVal !== undefined) outputsRecord[outPort.name] = { value: customVal };
        else if (!scriptRes.artifacts?.[outPort.name] && !(outPort.name === CHANGES_PORT && scriptRes.changes)) {
          outputsRecord[outPort.name] = { value: defaultReport };
        }
      }
      if (node.outputs.length === 0) {
        outputsRecord.testReport = { value: defaultReport };
      }
      const products = await this.storeStepProducts({
        runId: state.runId,
        node,
        attemptId,
        outputsRecord,
        ...(scriptRes.artifacts ? { artifacts: scriptRes.artifacts } : {}),
        ...(scriptRes.changes ? { changes: scriptRes.changes } : {}),
        ...(fork ? { isolated: true } : {}),
      });

      const attemptRecord: NodeAttemptRecord = {
        attemptId,
        invocationId,
        runId: state.runId,
        scopeKey,
        nodeId: node.id,
        retryIndex: prevNodeState.retryCount,
        roundIndex,
        phase: 'publish',
        status: 'SUCCEEDED',
        producedArtifactIds: [...products.producedArtifactIds, ...logArtifactIds],
        ...(products.changes ? { changes: products.changes } : {}),
        ...(assessmentRecord ? { assessmentId: assessmentRecord.assessmentId } : {}),
        receipt: {
          attemptId,
          exitCode: scriptRes.exitCode,
          durationMs: scriptRes.durationMs,
        },
        startedAtMs,
        completedAtMs: now,
      };

      return await this.commitNodeOrScopeTransition(
        plan,
        state.runId,
        scopeKey,
        compiledScope,
        epoch,
        () => ({
          nodeId: node.id,
          nodeState: {
            nodeId: node.id,
            status: 'SUCCEEDED',
            latestAttemptId: attemptId,
            retryCount: prevNodeState.retryCount,
            outputs: outputsRecord,
            latestVerdict: assessmentRecord?.verdict,
            latestAssessmentId: assessmentRecord?.assessmentId,
          },
          attempt: attemptRecord,
          assessment: assessmentRecord,
          events: [
            {
              type: 'node.completed',
              runId: state.runId,
              scopeKey,
              nodeId: node.id,
              attemptId,
              status: 'SUCCEEDED',
              ...(assessmentRecord ? { verdict: assessmentRecord.verdict } : {}),
              timestampMs: now,
            },
          ],
        })
      );
    } finally {
      if (fork && !forkSettled) await fork.discard().catch(() => undefined);
      await this.workspaces.releaseLease(lease.leaseId);
    }
  }

  private async executeGateNode(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    node: GateNode,
    epoch: number
  ): Promise<WorkflowRunState> {
    const scopeState = state.scopes[scopeKey]!;
    const prevNodeState = scopeState.nodes[node.id]!;
    const attemptId = this.nextUniqueId('att', state.attempts);
    const invocationId = this.nextUniqueId('inv');
    const requestId = this.nextUniqueId('wait', state.waitRequests);
    const now = this.clock.nowMs();

    const waitRequest: WaitRequest = {
      requestId,
      runId: state.runId,
      scopeKey,
      nodeId: node.id,
      attemptId,
      prompt: node.prompt,
      options: node.options,
      requiredRole: node.requiredRole,
      status: 'PENDING',
      createdAtMs: now,
    };

    const attemptRecord: NodeAttemptRecord = {
      attemptId,
      invocationId,
      runId: state.runId,
      scopeKey,
      nodeId: node.id,
      retryIndex: prevNodeState.retryCount,
      roundIndex: scopeState.roundIndex ?? 0,
      phase: 'accept',
      status: 'WAITING',
      producedArtifactIds: [],
      startedAtMs: now,
    };

    return await this.commitNodeOrScopeTransition(
      plan,
      state.runId,
      scopeKey,
      compiledScope,
      epoch,
      (latestScope) => ({
        nodeId: node.id,
        nodeState: {
          ...latestScope.nodes[node.id]!,
          status: 'WAITING',
          latestAttemptId: attemptId,
          activeWaitRequestId: requestId,
        },
        attempt: attemptRecord,
        waitRequest,
        events: [
          {
            type: 'node.waiting',
            runId: state.runId,
            scopeKey,
            nodeId: node.id,
            attemptId,
            requestId,
            prompt: node.prompt,
            timestampMs: now,
          },
        ],
      })
    );
  }

  private async executeLoopNode(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    node: LoopNode,
    epoch: number,
    signal?: AbortSignal
  ): Promise<WorkflowRunState> {
    const childCompiledScope = compiledScope.childScopes[node.id]!;
    const parentScope = state.scopes[scopeKey]!;
    const loopInputs = this.resolveNodeInputsFromDataEdges(compiledScope, parentScope, node.id);

    let roundIndex = 0;
    let priorRoundFeedback:
      | {
          roundIndex: number;
          verdict: string;
          summary: string;
          findings: readonly { severity: string; message: string; filePath?: string }[];
        }
      | undefined;

    // Chief may grant extra rounds while the loop runs, so re-read the limit every round.
    const roundLimit = () =>
      node.maxRounds + (state.chief.loopExtensions[`${scopeKey}/${node.id}`] ?? 0);

    while (roundIndex < roundLimit()) {
      const roundScopeKey = `${scopeKey}/${node.id}:round_${roundIndex}`;
      if (!state.scopes[roundScopeKey]) {
        const roundInputs: Record<string, PortValueRecord> = {
          ...loopInputs,
          ...(priorRoundFeedback
            ? { __priorRoundFeedback: { value: priorRoundFeedback } }
            : {}),
        };
        const initialRoundScope = createInitialScopeState(
          childCompiledScope,
          roundScopeKey,
          roundInputs,
          { roundIndex }
        );
        state = await this.applyLinearizedMutation(state.runId, epoch, (latest) => ({
          ...latest,
          scopes: {
            ...latest.scopes,
            [roundScopeKey]: initialRoundScope,
          },
          events: [
            ...latest.events,
            {
              type: 'loop.round.advanced',
              runId: latest.runId,
              scopeKey,
              loopNodeId: node.id,
              roundIndex,
              timestampMs: this.clock.nowMs(),
            },
          ],
        }));
      }

      // Advance the round's bodyGraph until settled (if not already SUCCEEDED in a prior run)
      while (state.scopes[roundScopeKey]?.status === 'RUNNING') {
        const stepped = await this.stepScope(
          plan,
          state,
          roundScopeKey,
          childCompiledScope,
          epoch,
          signal
        );
        state = stepped.state;
        if (!stepped.progressed) break;
      }

      const settledRoundScope = state.scopes[roundScopeKey]!;
      if (settledRoundScope.status === 'RUNNING') {
        // Round paused (e.g. chief escalation) rather than finished; leave the loop PENDING.
        return state;
      }
      if (settledRoundScope.status === 'WAITING') {
        return await this.commitNodeOrScopeTransition(
          plan,
          state.runId,
          scopeKey,
          compiledScope,
          epoch,
          (latestScope) => ({
            nodeId: node.id,
            nodeState: {
              ...latestScope.nodes[node.id]!,
              status: 'WAITING',
            },
          })
        );
      }

      if (settledRoundScope.status === 'FAILED') {
        return await this.commitNodeOrScopeTransition(
          plan,
          state.runId,
          scopeKey,
          compiledScope,
          epoch,
          (latestScope) => ({
            nodeId: node.id,
            nodeState: {
              ...latestScope.nodes[node.id]!,
              status: 'FAILED',
            },
          })
        );
      }

      // Check loop continuation predicate (`continueWhen`, e.g. `verdict_is: NEEDS_FIX`)
      const lastNodeId =
        node.continueWhen.kind !== 'always' && node.continueWhen.sourceNodeId
          ? node.continueWhen.sourceNodeId
          : childCompiledScope.topologicalOrder[childCompiledScope.topologicalOrder.length - 1]!;
      const shouldContinue = evaluateEdgeCondition(
        node.continueWhen,
        lastNodeId,
        settledRoundScope
      );

      const lastNodeState = settledRoundScope.nodes[lastNodeId];
      const latestAssessment = lastNodeState?.latestAssessmentId
        ? state.assessments[lastNodeState.latestAssessmentId]
        : undefined;

      if (!shouldContinue) {
        // Leaving the loop is only a success on a passing (or absent) verdict: a reviewer that
        // returns FAIL or BLOCKED ends the loop as a failure, never as done.
        const verdict = lastNodeState?.latestVerdict;
        if (verdict && verdict !== 'PASS') {
          const decidingName = childCompiledScope.nodesById[lastNodeId]?.name ?? lastNodeId;
          const error = `Loop "${node.id}" stopped in round ${roundIndex + 1}: "${decidingName}" returned ${verdict}${
            latestAssessment?.summary ? ` (${latestAssessment.summary})` : ''
          }`;
          return await this.commitNodeOrScopeTransition(
            plan,
            state.runId,
            scopeKey,
            compiledScope,
            epoch,
            (latestScope) => ({
              nodeId: node.id,
              nodeState: {
                ...latestScope.nodes[node.id]!,
                status: 'FAILED',
                outputs: settledRoundScope.outputs,
                latestVerdict: verdict,
                latestAssessmentId: lastNodeState?.latestAssessmentId,
                error,
              },
            })
          );
        }
        return await this.commitNodeOrScopeTransition(
          plan,
          state.runId,
          scopeKey,
          compiledScope,
          epoch,
          (latestScope) => ({
            nodeId: node.id,
            nodeState: {
              ...latestScope.nodes[node.id]!,
              status: 'SUCCEEDED',
              outputs: settledRoundScope.outputs,
              latestVerdict: verdict,
              latestAssessmentId: lastNodeState?.latestAssessmentId,
            },
          })
        );
      }

      // Prepare feedback for next round
      if (latestAssessment) {
        priorRoundFeedback = {
          roundIndex,
          verdict: latestAssessment.verdict,
          summary: latestAssessment.summary,
          findings: latestAssessment.findings,
        };
      }
      roundIndex += 1;
    }

    // Loop exhausted `maxRounds` while `continueWhen` was still true!
    const totalRounds = roundLimit();
    const lastRoundKey = `${scopeKey}/${node.id}:round_${totalRounds - 1}`;
    const lastRoundScope = state.scopes[lastRoundKey]!;
    if (node.onExhausted === 'pass_with_findings') {
      return await this.commitNodeOrScopeTransition(
        plan,
        state.runId,
        scopeKey,
        compiledScope,
        epoch,
        (latestScope) => ({
          nodeId: node.id,
          nodeState: {
            ...latestScope.nodes[node.id]!,
            status: 'SUCCEEDED',
            outputs: lastRoundScope.outputs,
            latestVerdict: 'NEEDS_FIX',
          },
        })
      );
    }

    if (node.onExhausted === 'gate') {
      const loopNodeState = state.scopes[scopeKey]?.nodes[node.id];
      const existingWait = loopNodeState?.activeWaitRequestId
        ? state.waitRequests[loopNodeState.activeWaitRequestId]
        : undefined;

      if (existingWait?.status === 'RESOLVED' && existingWait.response) {
        const ans = String(existingWait.response.answer).toLowerCase();
        const approved = ans === 'approve' || ans === 'pass' || ans === 'continue';
        if (approved) {
          return await this.commitNodeOrScopeTransition(
            plan,
            state.runId,
            scopeKey,
            compiledScope,
            epoch,
            (latestScope) => ({
              nodeId: node.id,
              nodeState: {
                ...latestScope.nodes[node.id]!,
                status: 'SUCCEEDED',
                outputs: lastRoundScope.outputs,
                latestVerdict: 'PASS',
                activeWaitRequestId: undefined,
              },
            })
          );
        }
      } else if (!existingWait) {
        const attemptId = this.nextUniqueId('att', state.attempts);
        const invocationId = this.nextUniqueId('inv');
        const requestId = this.nextUniqueId('wait', state.waitRequests);
        const now = this.clock.nowMs();
        const prompt = `Loop "${node.name}" (${node.id}) exhausted ${totalRounds} rounds without reaching PASS. Approve current output or reject?`;
        const waitRequest: WaitRequest = {
          requestId,
          runId: state.runId,
          scopeKey,
          nodeId: node.id,
          attemptId,
          prompt,
          options: [
            { value: 'approve', label: 'Approve & Continue' },
            { value: 'reject', label: 'Reject & Fail' },
          ],
          status: 'PENDING',
          createdAtMs: now,
        };
        const attemptRecord: NodeAttemptRecord = {
          attemptId,
          invocationId,
          runId: state.runId,
          scopeKey,
          nodeId: node.id,
          retryIndex: 0,
          roundIndex: totalRounds - 1,
          phase: 'accept',
          status: 'WAITING',
          producedArtifactIds: [],
          startedAtMs: now,
        };
        return await this.commitNodeOrScopeTransition(
          plan,
          state.runId,
          scopeKey,
          compiledScope,
          epoch,
          (latestScope) => ({
            nodeId: node.id,
            nodeState: {
              ...latestScope.nodes[node.id]!,
              status: 'WAITING',
              latestAttemptId: attemptId,
              activeWaitRequestId: requestId,
            },
            attempt: attemptRecord,
            waitRequest,
            events: [
              {
                type: 'node.waiting',
                runId: state.runId,
                scopeKey,
                nodeId: node.id,
                attemptId,
                requestId,
                prompt,
                timestampMs: now,
              },
            ],
          })
        );
      }
    }

    return await this.commitNodeOrScopeTransition(
      plan,
      state.runId,
      scopeKey,
      compiledScope,
      epoch,
      (latestScope) => ({
        nodeId: node.id,
        nodeState: {
          ...latestScope.nodes[node.id]!,
          status: 'FAILED',
          outputs: lastRoundScope.outputs,
          latestVerdict: 'NEEDS_FIX',
          error: `Loop "${node.id}" exhausted ${totalRounds} rounds without reaching PASS`,
          activeWaitRequestId: undefined,
        },
      })
    );
  }

  private async executeParallelNode(
    plan: CompiledWorkflowPlan,
    state: WorkflowRunState,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    node: ParallelNode,
    epoch: number,
    signal?: AbortSignal
  ): Promise<WorkflowRunState> {
    const childCompiledScope = compiledScope.childScopes[node.id]!;
    const parentScope = state.scopes[scopeKey]!;
    const parallelInputs = this.resolveNodeInputsFromDataEdges(compiledScope, parentScope, node.id);
    const rawItems = parallelInputs[node.itemsPort]?.value;
    const items = Array.isArray(rawItems) ? rawItems : [];

    const itemScopeKeys: string[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      itemScopeKeys.push(`${scopeKey}/${node.id}[${idx}]`);
    }

    state = await this.applyLinearizedMutation(state.runId, epoch, (latest) => {
      const nextScopes = { ...latest.scopes };
      for (let idx = 0; idx < items.length; idx++) {
        const itemKey = itemScopeKeys[idx]!;
        if (!nextScopes[itemKey]) {
          nextScopes[itemKey] = createInitialScopeState(childCompiledScope, itemKey, {
            ...parallelInputs,
            item: { value: items[idx] },
            itemIndex: { value: idx },
          });
        }
      }
      return {
        ...latest,
        scopes: nextScopes,
      };
    });

    // Execute item scopes with bounded concurrency (`node.maxConcurrency`)
    const concurrency = Math.max(1, Math.min(node.maxConcurrency, itemScopeKeys.length || 1));
    let queueIndex = 0;
    let failFastTriggered = false;

    const runItemWorker = async (): Promise<void> => {
      while (!failFastTriggered) {
        const idx = queueIndex++;
        if (idx >= itemScopeKeys.length) break;
        const itemKey = itemScopeKeys[idx]!;

        while (!failFastTriggered) {
          const latest = await this.store.getRun(state.runId);
          if (!latest || latest.scopes[itemKey]?.status !== 'RUNNING') {
            break;
          }
          const stepped = await this.stepScope(
            plan,
            latest,
            itemKey,
            childCompiledScope,
            epoch,
            signal
          );
          if (
            stepped.state.scopes[itemKey]?.status === 'FAILED' &&
            node.failurePolicy === 'fail_fast'
          ) {
            failFastTriggered = true;
            break;
          }
          if (!stepped.progressed) break;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runItemWorker()));

    const finalState = (await this.store.getRun(state.runId)) ?? state;
    if (!failFastTriggered && itemScopeKeys.some((k) => finalState.scopes[k]?.status === 'RUNNING')) {
      // Items paused (e.g. chief escalation) rather than finished; leave the node PENDING.
      return finalState;
    }
    const anyWaiting = itemScopeKeys.some((k) => finalState.scopes[k]?.status === 'WAITING');
    if (anyWaiting) {
      return await this.commitNodeOrScopeTransition(
        plan,
        state.runId,
        scopeKey,
        compiledScope,
        epoch,
        (latestScope) => ({
          nodeId: node.id,
          nodeState: {
            ...latestScope.nodes[node.id]!,
            status: 'WAITING',
          },
        })
      );
    }

    const anyFailed = itemScopeKeys.some((k) => finalState.scopes[k]?.status === 'FAILED');
    if (anyFailed && node.failurePolicy === 'fail_fast') {
      return await this.commitNodeOrScopeTransition(
        plan,
        state.runId,
        scopeKey,
        compiledScope,
        epoch,
        (latestScope) => ({
          nodeId: node.id,
          nodeState: {
            ...latestScope.nodes[node.id]!,
            status: 'FAILED',
          },
        })
      );
    }

    const aggregatedResults: unknown[] = [];
    for (const itemKey of itemScopeKeys) {
      const itemScope = finalState.scopes[itemKey]!;
      const firstOutputPort = node.outputs[0]?.name ?? 'results';
      const itemOut =
        itemScope.outputs[firstOutputPort]?.value ??
        Object.values(itemScope.outputs)[0]?.value;
      aggregatedResults.push(itemOut);
    }

    const outPortName = node.outputs[0]?.name ?? 'results';
    return await this.commitNodeOrScopeTransition(
      plan,
      state.runId,
      scopeKey,
      compiledScope,
      epoch,
      (latestScope) => ({
        nodeId: node.id,
        nodeState: {
          ...latestScope.nodes[node.id]!,
          status: 'SUCCEEDED',
          outputs: {
            [outPortName]: { value: aggregatedResults },
          },
        },
      })
    );
  }

  private async commitNodeOrScopeTransition(
    _plan: CompiledWorkflowPlan,
    runId: string,
    scopeKey: string,
    compiledScope: CompiledGraphScope,
    epoch: number,
    buildDelta: (latestScope: GraphScopeState) => {
      scopeOverride?: GraphScopeState;
      nodeId?: string;
      nodeState?: NodeRuntimeState;
      attempt?: NodeAttemptRecord;
      manifest?: ContextManifest;
      assessment?: AssessmentRecord;
      waitRequest?: WaitRequest;
      readReceipts?: readonly ArtifactReadReceipt[];
      pinnedAgent?: PinnedAgent;
      events?: readonly WorkflowEvent[];
    }
  ): Promise<WorkflowRunState> {
    return await this.applyLinearizedMutation(runId, epoch, (latest) => {
      const currentScope = latest.scopes[scopeKey]!;
      const delta = buildDelta(currentScope);

      const baseScope = delta.scopeOverride
        ? delta.scopeOverride
        : delta.nodeId && delta.nodeState
          ? {
              ...currentScope,
              nodes: {
                ...currentScope.nodes,
                [delta.nodeId]: delta.nodeState,
              },
            }
          : currentScope;

      const updatedScope = reduceScopeTransitions(compiledScope, baseScope);
      const scopes = {
        ...latest.scopes,
        [scopeKey]: updatedScope,
      };

      const rootScope = scopeKey === '$root' ? updatedScope : scopes.$root!;
      const runStatus = deriveRunStatus(rootScope, latest.chief);
      const events: WorkflowEvent[] = [...latest.events, ...(delta.events ?? [])];

      // Containers (loop/parallel) settle without an attempt of their own; still announce it
      // so observers such as the chief see every node that finished.
      const settled = delta.nodeId && delta.nodeState ? delta.nodeState.status : undefined;
      if (
        delta.nodeId &&
        (settled === 'SUCCEEDED' || settled === 'FAILED') &&
        currentScope.nodes[delta.nodeId]?.status !== settled &&
        !delta.events?.some((e) => e.type === 'node.completed' && e.nodeId === delta.nodeId)
      ) {
        events.push({
          type: 'node.completed',
          runId: latest.runId,
          scopeKey,
          nodeId: delta.nodeId,
          attemptId: delta.nodeState!.latestAttemptId ?? `container:${delta.nodeId}`,
          status: settled,
          ...(delta.nodeState!.latestVerdict ? { verdict: delta.nodeState!.latestVerdict } : {}),
          timestampMs: this.clock.nowMs(),
        });
      }
      if ((runStatus === 'SUCCEEDED' || runStatus === 'FAILED') && latest.status !== runStatus) {
        events.push({
          type: 'run.finished',
          runId: latest.runId,
          status: runStatus,
          timestampMs: this.clock.nowMs(),
        });
      }

      const workflowOutputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rootScope.outputs)) {
        workflowOutputs[k] = v.value;
      }

      return {
        ...latest,
        status: runStatus,
        outputs: workflowOutputs,
        scopes,
        attempts: delta.attempt
          ? { ...latest.attempts, [delta.attempt.attemptId]: delta.attempt }
          : latest.attempts,
        manifests: delta.manifest
          ? { ...latest.manifests, [delta.manifest.manifestId]: delta.manifest }
          : latest.manifests,
        assessments: delta.assessment
          ? { ...latest.assessments, [delta.assessment.assessmentId]: delta.assessment }
          : latest.assessments,
        waitRequests: delta.waitRequest
          ? { ...latest.waitRequests, [delta.waitRequest.requestId]: delta.waitRequest }
          : latest.waitRequests,
        readReceipts: delta.readReceipts
          ? [...latest.readReceipts, ...delta.readReceipts]
          : latest.readReceipts,
        pinnedAgents:
          delta.pinnedAgent && !latest.pinnedAgents[delta.pinnedAgent.ref]
            ? { ...latest.pinnedAgents, [delta.pinnedAgent.ref]: delta.pinnedAgent }
            : latest.pinnedAgents,
        events,
      };
    });
  }
}

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  return new WorkflowRuntime(options);
}
