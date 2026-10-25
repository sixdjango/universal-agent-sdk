import type {
  ContextManifest,
  WorkflowDefinition,
  WorkflowGraph,
} from '@universal-agent/workflow-contract';
import {
  type AppendRunMutationsInput,
  applyRunLogEntry,
  type Clock,
  CoordinatorFenceError,
  createRunMutations,
  type GraphScopeState,
  RevisionConflictError,
  type RunLogEntry,
  type RunMutation,
  type RunSnapshotState,
  type RuntimeStore,
  SystemClock,
  type WorkflowRunState,
} from '@universal-agent/workflow-runtime';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { WorkflowDatabase } from './database';
import {
  artifactReadReceipts,
  assessments,
  chiefInterventions,
  contextManifests,
  definitionEdges,
  definitionNodes,
  edgeDeliveries,
  nodeAttempts,
  nodeStates,
  runLog,
  runs,
  runScopes,
  runSnapshots,
  waitRequests,
  workflowDefinitions,
} from './schema';

/** Synchronous transaction handle passed to `db.transaction` callbacks. */
type Tx = Parameters<Parameters<WorkflowDatabase['transaction']>[0]>[0];
type Executor = WorkflowDatabase | Tx;

export interface SqliteRuntimeStoreOptions {
  readonly db: WorkflowDatabase;
  readonly clock?: Clock;
  /** Re-snapshot run state after this many log entries (default 64). */
  readonly snapshotInterval?: number;
}

function logLocation(mutation: RunMutation): { scopeKey: string | null; nodeId: string | null } {
  switch (mutation.kind) {
    case 'scope.put':
      return { scopeKey: mutation.scope.scopeKey, nodeId: null };
    case 'scope.deleted':
      return { scopeKey: mutation.scopeKey, nodeId: null };
    case 'attempt.put':
      return { scopeKey: mutation.attempt.scopeKey, nodeId: mutation.attempt.nodeId };
    case 'manifest.put':
      return { scopeKey: mutation.manifest.scopeKey, nodeId: mutation.manifest.nodeId };
    case 'wait_request.put':
      return { scopeKey: mutation.waitRequest.scopeKey, nodeId: mutation.waitRequest.nodeId };
    case 'assessment.put':
      return { scopeKey: null, nodeId: mutation.assessment.nodeId };
    case 'event.emitted': {
      const event = mutation.event as { scopeKey?: string; nodeId?: string };
      return { scopeKey: event.scopeKey ?? null, nodeId: event.nodeId ?? null };
    }
    default:
      return { scopeKey: null, nodeId: null };
  }
}

/**
 * SQLite-backed `RuntimeStore` (via Drizzle on `node:sqlite`).
 *
 * `run_log` is the source of truth. Each append runs in one `BEGIN IMMEDIATE` transaction that
 * checks the coordinator epoch and expected seq, appends entries, and refreshes the query
 * projections, so fencing holds across processes sharing the same database file.
 */
export class SqliteRuntimeStore implements RuntimeStore {
  private readonly db: WorkflowDatabase;
  private readonly clock: Clock;
  private readonly snapshotInterval: number;
  /** Last folded state per run; reused while the stored seq still matches. */
  private readonly cache = new Map<string, WorkflowRunState>();

  constructor(options: SqliteRuntimeStoreOptions) {
    this.db = options.db;
    this.clock = options.clock ?? new SystemClock();
    this.snapshotInterval = Math.max(1, options.snapshotInterval ?? 64);
  }

  async createRun(initialState: RunSnapshotState): Promise<WorkflowRunState> {
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select({ runId: runs.runId })
          .from(runs)
          .where(eq(runs.runId, initialState.runId))
          .get();
        if (existing) {
          throw new Error(`Run "${initialState.runId}" already exists`);
        }
        this.registerDefinition(tx, initialState.definition, initialState.definitionDigest);
        return this.append(tx, initialState.runId, null, 1, createRunMutations(initialState));
      },
      { behavior: 'immediate' }
    );
  }

  async getRun(runId: string): Promise<WorkflowRunState | null> {
    const state = this.load(this.db, runId);
    return state ? structuredClone(state) : null;
  }

  async acquireCoordinatorEpoch(
    runId: string
  ): Promise<{ epoch: number; state: WorkflowRunState }> {
    return this.db.transaction(
      (tx) => {
        const current = this.load(tx, runId);
        if (!current) {
          throw new Error(`Run "${runId}" not found`);
        }
        const epoch = current.coordinatorEpoch + 1;
        const state = this.append(tx, runId, current, epoch, [
          { kind: 'coordinator.acquired', epoch },
        ]);
        return { epoch, state };
      },
      { behavior: 'immediate' }
    );
  }

  async appendMutations(input: AppendRunMutationsInput): Promise<WorkflowRunState> {
    return this.db.transaction(
      (tx) => {
        const current = this.load(tx, input.runId);
        if (!current) {
          throw new Error(`Run "${input.runId}" not found`);
        }
        if (current.coordinatorEpoch !== input.coordinatorEpoch) {
          throw new CoordinatorFenceError(
            input.runId,
            input.coordinatorEpoch,
            current.coordinatorEpoch
          );
        }
        if (current.revision !== input.expectedSeq) {
          throw new RevisionConflictError(input.runId, input.expectedSeq, current.revision);
        }
        return this.append(tx, input.runId, current, current.coordinatorEpoch, input.mutations);
      },
      { behavior: 'immediate' }
    );
  }

  async readLog(
    runId: string,
    options?: { afterSeq?: number; limit?: number }
  ): Promise<readonly RunLogEntry[]> {
    return this.readEntries(this.db, runId, options?.afterSeq ?? 0, options?.limit);
  }

  private readEntries(
    executor: Executor,
    runId: string,
    afterSeq: number,
    limit?: number
  ): RunLogEntry[] {
    const query = executor
      .select()
      .from(runLog)
      .where(and(eq(runLog.runId, runId), gt(runLog.seq, afterSeq)))
      .orderBy(asc(runLog.seq));
    const rows = limit !== undefined ? query.limit(limit).all() : query.all();
    return rows.map((row) => ({
      runId: row.runId,
      seq: row.seq,
      coordinatorEpoch: row.coordinatorEpoch,
      mutation: row.mutation as RunMutation,
      recordedAtMs: row.recordedAtMs,
    }));
  }

  /** Latest snapshot + log tail, short-circuited by the in-process cache when the seq matches. */
  private load(executor: Executor, runId: string): WorkflowRunState | null {
    const head = executor
      .select({ seq: runs.seq })
      .from(runs)
      .where(eq(runs.runId, runId))
      .get();
    if (!head) {
      this.cache.delete(runId);
      return null;
    }
    const cached = this.cache.get(runId);
    if (cached?.revision === head.seq) {
      return cached;
    }

    const snapshotRow = executor
      .select()
      .from(runSnapshots)
      .where(eq(runSnapshots.runId, runId))
      .get();
    // A cache entry ahead of the stored seq came from a rolled-back transaction; discard it.
    const usableCache =
      cached && cached.revision <= head.seq && cached.revision > (snapshotRow?.seq ?? 0);
    let state = usableCache ? cached : null;
    if (!state && snapshotRow) {
      state = snapshotRow.state as WorkflowRunState;
    }
    for (const entry of this.readEntries(executor, runId, state?.revision ?? 0)) {
      state = applyRunLogEntry(state, entry);
    }
    if (state) {
      this.cache.set(runId, state);
    }
    return state;
  }

  private append(
    tx: Tx,
    runId: string,
    current: WorkflowRunState | null,
    coordinatorEpoch: number,
    mutations: readonly RunMutation[]
  ): WorkflowRunState {
    let state = current;
    const recordedAtMs = this.clock.nowMs();
    const firstSeq = (current?.revision ?? 0) + 1;

    mutations.forEach((mutation, idx) => {
      const entry: RunLogEntry = {
        runId,
        seq: firstSeq + idx,
        coordinatorEpoch,
        mutation,
        recordedAtMs,
      };
      state = applyRunLogEntry(state, entry);
      tx.insert(runLog)
        .values({
          runId,
          seq: entry.seq,
          kind: mutation.kind,
          coordinatorEpoch,
          ...logLocation(mutation),
          mutation,
          recordedAtMs,
        })
        .run();
      this.project(tx, runId, entry.seq, mutation);
    });

    const next = state as WorkflowRunState | null;
    if (!next) {
      throw new Error(`Run "${runId}" has no state after append`);
    }

    const runRow = {
      runId,
      definitionDigest: next.definitionDigest,
      status: next.status,
      seq: next.revision,
      coordinatorEpoch: next.coordinatorEpoch,
      inputs: next.inputs,
      outputs: next.outputs,
      createdAtMs: next.createdAtMs,
      updatedAtMs: next.updatedAtMs,
    };
    tx.insert(runs).values(runRow).onConflictDoUpdate({ target: runs.runId, set: runRow }).run();

    const snapshotRow = tx
      .select({ seq: runSnapshots.seq })
      .from(runSnapshots)
      .where(eq(runSnapshots.runId, runId))
      .get();
    if (next.revision - (snapshotRow?.seq ?? 0) >= this.snapshotInterval) {
      tx.insert(runSnapshots)
        .values({ runId, seq: next.revision, state: next })
        .onConflictDoUpdate({
          target: runSnapshots.runId,
          set: { seq: next.revision, state: next },
        })
        .run();
    }

    this.cache.set(runId, next);
    return structuredClone(next);
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------

  private project(tx: Tx, runId: string, seq: number, mutation: RunMutation): void {
    switch (mutation.kind) {
      case 'run.created':
        for (const scope of Object.values(mutation.state.scopes)) {
          this.projectScope(tx, runId, scope);
        }
        return;
      case 'scope.put':
        this.projectScope(tx, runId, mutation.scope);
        return;
      case 'scope.deleted':
        tx.delete(nodeStates)
          .where(and(eq(nodeStates.runId, runId), eq(nodeStates.scopeKey, mutation.scopeKey)))
          .run();
        tx.delete(runScopes)
          .where(and(eq(runScopes.runId, runId), eq(runScopes.scopeKey, mutation.scopeKey)))
          .run();
        return;
      case 'attempt.put': {
        const a = mutation.attempt;
        const row = {
          runId,
          attemptId: a.attemptId,
          scopeKey: a.scopeKey,
          nodeId: a.nodeId,
          invocationId: a.invocationId,
          retryIndex: a.retryIndex,
          roundIndex: a.roundIndex,
          phase: a.phase,
          status: a.status,
          contextManifestId: a.contextManifestId ?? null,
          producedArtifactIds: a.producedArtifactIds,
          assessmentId: a.assessmentId ?? null,
          receipt: a.receipt ?? null,
          agentId: a.agent?.agentId ?? null,
          agentVersion: a.agent?.version ?? null,
          agentDigest: a.agent?.digest ?? null,
          error: a.error ?? null,
          startedAtMs: a.startedAtMs,
          completedAtMs: a.completedAtMs ?? null,
        };
        tx.insert(nodeAttempts)
          .values(row)
          .onConflictDoUpdate({ target: [nodeAttempts.runId, nodeAttempts.attemptId], set: row })
          .run();
        return;
      }
      case 'manifest.put':
        this.projectManifest(tx, runId, mutation.manifest);
        return;
      case 'assessment.put': {
        const a = mutation.assessment;
        const row = {
          runId,
          assessmentId: a.assessmentId,
          nodeId: a.nodeId,
          attemptId: a.attemptId,
          verdict: a.verdict,
          summary: a.summary,
          findings: a.findings,
          targetArtifactIds: a.targetArtifactIds,
          independentReviewer: a.independentReviewer,
          stale: a.stale,
          createdAtMs: a.createdAtMs,
        };
        tx.insert(assessments)
          .values(row)
          .onConflictDoUpdate({ target: [assessments.runId, assessments.assessmentId], set: row })
          .run();
        return;
      }
      case 'wait_request.put': {
        const w = mutation.waitRequest;
        const row = {
          runId,
          requestId: w.requestId,
          scopeKey: w.scopeKey,
          nodeId: w.nodeId,
          attemptId: w.attemptId,
          status: w.status,
          prompt: w.prompt,
          options: w.options,
          requiredRole: w.requiredRole ?? null,
          sessionBinding: w.sessionBinding ?? null,
          response: w.response ?? null,
          createdAtMs: w.createdAtMs,
        };
        tx.insert(waitRequests)
          .values(row)
          .onConflictDoUpdate({ target: [waitRequests.runId, waitRequests.requestId], set: row })
          .run();
        return;
      }
      case 'read_receipts.appended':
        for (const r of mutation.receipts) {
          tx.insert(artifactReadReceipts)
            .values({
              runId,
              receiptId: r.receiptId,
              attemptId: r.attemptId,
              artifactId: r.artifactId,
              offsetBytes: r.offsetBytes,
              readBytes: r.readBytes,
              section: r.section ?? null,
              timestampMs: r.timestampMs,
            })
            .run();
        }
        return;
      case 'event.emitted': {
        const event = mutation.event;
        if (event.type === 'chief.intervened') {
          tx.insert(chiefInterventions)
            .values({
              runId,
              seq,
              trigger: event.trigger,
              scopeKey: event.scopeKey ?? null,
              nodeId: event.nodeId ?? null,
              rationale: event.rationale,
              applied: event.applied,
              rejected: event.rejected,
              timestampMs: event.timestampMs,
            })
            .run();
        }
        return;
      }
      case 'coordinator.acquired':
      case 'run.patched':
      case 'agent.pinned':
      case 'chief.updated':
        // Reflected in the `runs` row / `run_log` only.
        return;
    }
  }

  private projectScope(tx: Tx, runId: string, scope: GraphScopeState): void {
    const scopeRow = {
      runId,
      scopeKey: scope.scopeKey,
      scopePath: scope.scopePath,
      status: scope.status,
      roundIndex: scope.roundIndex ?? null,
      inputs: scope.inputs,
      outputs: scope.outputs,
    };
    tx.insert(runScopes)
      .values(scopeRow)
      .onConflictDoUpdate({ target: [runScopes.runId, runScopes.scopeKey], set: scopeRow })
      .run();

    for (const node of Object.values(scope.nodes)) {
      const nodeRow = {
        runId,
        scopeKey: scope.scopeKey,
        nodeId: node.nodeId,
        status: node.status,
        latestAttemptId: node.latestAttemptId ?? null,
        retryCount: node.retryCount,
        latestVerdict: node.latestVerdict ?? null,
        latestAssessmentId: node.latestAssessmentId ?? null,
        activeWaitRequestId: node.activeWaitRequestId ?? null,
        error: node.error ?? null,
        outputs: node.outputs,
      };
      tx.insert(nodeStates)
        .values(nodeRow)
        .onConflictDoUpdate({
          target: [nodeStates.runId, nodeStates.scopeKey, nodeStates.nodeId],
          set: nodeRow,
        })
        .run();
    }
  }

  private projectManifest(tx: Tx, runId: string, manifest: ContextManifest): void {
    const row = {
      runId,
      manifestId: manifest.manifestId,
      scopeKey: manifest.scopeKey,
      nodeId: manifest.nodeId,
      attemptId: manifest.attemptId,
      totalInlineBytes: manifest.totalInlineBytes,
      manifest,
      createdAtMs: manifest.createdAtMs,
    };
    tx.insert(contextManifests)
      .values(row)
      .onConflictDoUpdate({
        target: [contextManifests.runId, contextManifests.manifestId],
        set: row,
      })
      .run();

    tx.delete(edgeDeliveries)
      .where(
        and(eq(edgeDeliveries.runId, runId), eq(edgeDeliveries.manifestId, manifest.manifestId))
      )
      .run();
    for (const entry of manifest.entries) {
      tx.insert(edgeDeliveries)
        .values({
          runId,
          manifestId: manifest.manifestId,
          scopeKey: manifest.scopeKey,
          attemptId: manifest.attemptId,
          toNodeId: manifest.nodeId,
          toPort: entry.portName,
          fromNodeId: entry.sourceNodeId,
          fromPort: entry.sourcePort,
          mode: entry.mode,
          artifactId: entry.artifactRef?.artifactId ?? null,
          byteSize: entry.byteSize,
          selectionReason: entry.selectionReason,
        })
        .run();
    }
  }

  /** Stores the immutable node/edge contract once per definition digest. */
  private registerDefinition(tx: Tx, definition: WorkflowDefinition, digest: string): void {
    const inserted = tx
      .insert(workflowDefinitions)
      .values({
        definitionDigest: digest,
        definitionId: definition.id,
        version: definition.version,
        name: definition.name,
        definition,
        createdAtMs: this.clock.nowMs(),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) {
      return;
    }

    const visit = (graph: WorkflowGraph, scopePath: string): void => {
      for (const node of graph.nodes) {
        tx.insert(definitionNodes)
          .values({
            definitionDigest: digest,
            scopePath,
            nodeId: node.id,
            kind: node.kind,
            name: node.name,
            role: node.kind === 'agent' ? node.role : null,
            inputs: node.inputs,
            outputs: node.outputs,
            writeScopes: node.writeScopes,
          })
          .run();
        if (node.kind === 'loop') visit(node.bodyGraph, `${scopePath}/${node.id}`);
        if (node.kind === 'parallel') visit(node.itemGraph, `${scopePath}/${node.id}`);
      }
      for (const edge of graph.controlEdges) {
        tx.insert(definitionEdges)
          .values({
            definitionDigest: digest,
            scopePath,
            edgeId: edge.id,
            edgeKind: 'control',
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
            condition: edge.when ?? null,
            loop: edge.loop ?? null,
          })
          .run();
      }
      for (const edge of graph.dataEdges) {
        tx.insert(definitionEdges)
          .values({
            definitionDigest: digest,
            scopePath,
            edgeId: edge.id,
            edgeKind: 'data',
            fromNodeId: edge.fromNodeId,
            fromPort: edge.fromPort,
            toNodeId: edge.toNodeId,
            toPort: edge.toPort,
            required: edge.required,
            delivery: edge.delivery,
          })
          .run();
      }
    };
    visit(definition.graph, '$root');
  }
}
