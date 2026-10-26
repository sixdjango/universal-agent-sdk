import { randomUUID } from 'node:crypto';
import type { ChiefCommand, LiveAttemptProgress, RunWorkspaceBinding, WorkflowDefinition } from '@universal-agent/workflow-contract';
import {
  CHIEF_WAIT_NODE_ID,
  ChiefUnavailableError,
  type Clock,
  type ForkWorkflowRunInput,
  type RunForkPlan,
  type RunLogEntry,
  SystemClock,
  type WorkflowRunState,
  type WorkflowRuntime,
} from '@universal-agent/workflow-runtime';
import { and, desc, eq } from 'drizzle-orm';
import type { WorkflowDatabase } from '../store/sqlite/database';
import * as workflowSchema from '../store/sqlite/schema';
import { conflict, invalid, notFound } from './errors';
import { migrateHostTables } from './migrations';
import { runLeases } from './schema';

export interface RunSummary {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly status: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RunServiceLogger {
  error(obj: unknown, msg?: string): void;
}

interface DriveLoop {
  /** Work for this run, executed strictly one after another. */
  readonly queue: (() => Promise<unknown>)[];
  /** Aborted when the service closes or this process loses the run's lease. */
  readonly abort: AbortController;
  done: Promise<void>;
}

export interface RunServiceOptions {
  readonly runtime: WorkflowRuntime;
  readonly db: WorkflowDatabase;
  readonly logger?: RunServiceLogger;
  readonly clock?: Clock;
  /** Identifies this process in `run_leases` (default: random per service). */
  readonly ownerId?: string;
  /** How long a lease lasts without renewal (default 30 s); renewed every third of that. */
  readonly leaseTtlMs?: number;
  /** Continue a reopened flow after a chief chat reply (default true). False leaves driving to the host. */
  readonly autoContinueAfterChief?: boolean;
}

/** A run whose driver failed is not retried by the orphan sweep for this long. */
const FAILED_RUN_BACKOFF_MS = 5 * 60_000;

/**
 * Starts runs and drives them in the background so callers (HTTP handlers, CLIs, bots)
 * return immediately.
 * Each run has at most one in-process driver loop working through a queue, so answers and
 * reruns never start a second coordinator on the same run.
 */
export class RunService {
  private readonly runtime: WorkflowRuntime;
  private readonly db: WorkflowDatabase;
  private readonly logger: RunServiceLogger;
  private readonly loops = new Map<string, DriveLoop>();
  private readonly abort = new AbortController();
  private readonly clock: Clock;
  readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly autoContinueAfterChief: boolean;
  private readonly failedAt = new Map<string, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  /** Messages per run the chief is still answering. */
  private readonly chiefAnswering = new Map<string, number>();

  constructor(options: RunServiceOptions) {
    this.runtime = options.runtime;
    this.db = options.db;
    this.logger = options.logger ?? { error: (obj, msg) => console.error(msg ?? 'workflow run failed', obj) };
    this.clock = options.clock ?? new SystemClock();
    this.ownerId = options.ownerId ?? `host_${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.autoContinueAfterChief = options.autoContinueAfterChief ?? true;
    migrateHostTables(this.db);
  }

  /** Id for a run about to start, so its worktrees can be named before it exists. */
  nextRunId(): string {
    return this.runtime.idGenerator.nextId('run');
  }

  async start(
    definition: WorkflowDefinition,
    inputs: Record<string, unknown>,
    options: { runId?: string; workspaces?: Readonly<Record<string, RunWorkspaceBinding>> } = {}
  ): Promise<WorkflowRunState> {
    const state = await this.runtime
      .start({
        definition,
        inputs,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.workspaces ? { workspaces: options.workspaces } : {}),
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'WorkspaceBindingError') throw invalid(err.message);
        throw err;
      });
    this.drive(state.runId, 'continue');
    return state;
  }

  /** What forking `sourceRunId` from `nodeId` would take over and run again (see `fork`). */
  async planFork(input: Pick<ForkWorkflowRunInput, 'sourceRunId' | 'nodeId' | 'definition'>): Promise<RunForkPlan> {
    await this.get(input.sourceRunId);
    return this.runtime.planFork(input).catch((err: unknown) => {
      throw invalid(err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Starts a run that takes over `sourceRunId`'s results up to `nodeId` and runs that step and
   * everything after it again, and drives it in the background. Workspaces are used as given:
   * replaying the earlier steps' file changes is up to the caller (`WorkflowHost.forkRun` does).
   */
  async fork(input: ForkWorkflowRunInput): Promise<WorkflowRunState> {
    await this.get(input.sourceRunId);
    const state = await this.runtime.forkRun(input).catch((err: unknown) => {
      if (err instanceof Error && (err.name === 'RunForkError' || err.name === 'WorkspaceBindingError')) throw invalid(err.message);
      throw err;
    });
    this.drive(state.runId, 'continue');
    return state;
  }

  async get(runId: string): Promise<WorkflowRunState> {
    const state = await this.runtime.store.getRun(runId);
    if (!state) throw notFound(`Run "${runId}"`);
    return state;
  }

  /** Text of an artifact a run stored (e.g. a step's diff). */
  readArtifactText(artifactId: string): Promise<string> {
    return this.runtime.artifacts.readText(artifactId);
  }

  readLog(runId: string, afterSeq: number): Promise<readonly RunLogEntry[]> {
    return this.runtime.store.readLog(runId, { afterSeq });
  }

  isActive(runId: string): boolean {
    return this.loops.has(runId);
  }

  getLiveProgress(runId: string): readonly LiveAttemptProgress[] {
    return this.runtime.getLiveProgress(runId);
  }

  list(options: { workflowId?: string; limit?: number } = {}): RunSummary[] {
    const { runs, workflowDefinitions } = workflowSchema;
    const query = this.db
      .select({
        runId: runs.runId,
        workflowId: workflowDefinitions.definitionId,
        workflowName: workflowDefinitions.name,
        status: runs.status,
        revision: runs.seq,
        createdAtMs: runs.createdAtMs,
        updatedAtMs: runs.updatedAtMs,
      })
      .from(runs)
      .innerJoin(workflowDefinitions, eq(runs.definitionDigest, workflowDefinitions.definitionDigest))
      .$dynamic();
    const filtered = options.workflowId
      ? query.where(eq(workflowDefinitions.definitionId, options.workflowId))
      : query;
    return filtered.orderBy(desc(runs.createdAtMs)).limit(options.limit ?? 50).all();
  }

  /**
   * Answers a pending WaitRequest. Gate and agent answers commit immediately (the driver
   * picks them up); answers to chief escalations go through the full `respond` so the
   * chief is consulted about the human's decision.
   */
  async respond(input: {
    runId: string;
    requestId: string;
    answer: string | Record<string, unknown>;
    responderId: string;
  }): Promise<WorkflowRunState> {
    const state = await this.get(input.runId);
    const wait = state.waitRequests[input.requestId];
    if (!wait) throw notFound(`WaitRequest "${input.requestId}"`);
    if (wait.status !== 'PENDING') throw conflict(`WaitRequest "${input.requestId}" is already resolved`);

    if (wait.nodeId === CHIEF_WAIT_NODE_ID) {
      this.enqueue(input.runId, () => this.runtime.respond({ ...input, autoResume: true }));
      return state;
    }
    const committed = await this.runtime.respond({ ...input, autoResume: false });
    this.driveUnlessHeldElsewhere(input.runId);
    return committed;
  }

  /**
   * Sends a human message to the run's chief and returns once it is recorded. The chief's
   * answer (and anything it does) arrives later in the run log as a `chief.intervened` event.
   */
  async messageChief(input: { runId: string; text: string; authorId: string }): Promise<{ messageId: string }> {
    await this.get(input.runId);
    if (this.abort.signal.aborted) throw conflict('The run service is shutting down');
    // Reserve the driver/lease before recording, so a second host cannot run a chief against
    // this host's active nodes. While this host is executing the run the chief answers at
    // once; retries and reruns it asks for wait in the driver queue until execution settles.
    const executing = this.loops.get(input.runId);
    let answering: Promise<ChiefCommand[]> = Promise.resolve([]);
    let deliver!: (messageId: string | undefined) => void;
    const recorded = new Promise<string | undefined>(resolve => { deliver = resolve; });
    this.enqueue(input.runId, async signal => {
      const messageId = await recorded;
      if (messageId && !signal.aborted) {
        const held = executing ? await answering : await this.answerChief(input.runId, messageId, signal);
        if (held.length > 0 && !signal.aborted) {
          await this.runtime.applyHeldChiefCommands({ runId: input.runId, messageId, commands: held, signal });
        }
      }
      const state = await this.get(input.runId);
      if (messageId && this.autoContinueAfterChief && state.status === 'RUNNING' && !signal.aborted) {
        await this.runtime.runUntilSettled(input.runId, { signal });
      }
    });
    try {
      const { messageId } = await this.runtime.postChiefMessage(input);
      if (executing) answering = this.answerChief(input.runId, messageId, executing.abort.signal, true);
      deliver(messageId);
      return { messageId };
    } catch (err) {
      deliver(undefined);
      if (err instanceof ChiefUnavailableError) throw invalid(err.message);
      throw invalid(err instanceof Error ? err.message : String(err));
    }
  }

  /** Whether the chief is still working on an answer for `runId` in this process. */
  isChiefAnswering(runId: string): boolean {
    return (this.chiefAnswering.get(runId) ?? 0) > 0;
  }

  /** Has the chief answer; returns the retries and reruns held until execution settles. */
  private async answerChief(runId: string, messageId: string, signal: AbortSignal, holdWhileBusy = false): Promise<ChiefCommand[]> {
    this.chiefAnswering.set(runId, (this.chiefAnswering.get(runId) ?? 0) + 1);
    try {
      return (await this.runtime.replyToChiefMessage({ runId, messageId, signal, holdWhileBusy })).held;
    } catch (err) {
      if (!signal.aborted) this.logger.error({ err, runId }, 'chief could not answer a message');
      return [];
    } finally {
      const left = (this.chiefAnswering.get(runId) ?? 1) - 1;
      if (left > 0) this.chiefAnswering.set(runId, left);
      else this.chiefAnswering.delete(runId);
    }
  }

  /**
   * Stops a run for good. Steps this process is executing are aborted (their agent sessions
   * and scripts are cancelled) and queued work is dropped; whatever a step still returns is not
   * recorded. A run another process drives is cancelled too: its driver stops at its next commit.
   */
  async cancel(runId: string): Promise<WorkflowRunState> {
    await this.get(runId);
    const loop = this.loops.get(runId);
    if (loop) {
      loop.queue.length = 0;
      loop.abort.abort();
    }
    return await this.runtime.cancelRun({ runId });
  }

  async rerunFromNode(input: { runId: string; nodeId: string; scopeKey?: string }): Promise<WorkflowRunState> {
    await this.get(input.runId);
    if (this.isActive(input.runId) || this.heldElsewhere(input.runId)) {
      throw conflict('Run is still executing; rerun once it has settled');
    }
    const state = await this.runtime.rerunFromNode({ ...input, autoRun: false }).catch((err: unknown) => {
      throw invalid(err instanceof Error ? err.message : String(err));
    });
    this.drive(input.runId, 'continue');
    return state;
  }

  /**
   * Picks up runs left RUNNING that no live process is driving (crash or restart), and keeps
   * checking every lease period so runs orphaned later are picked up too. Runs another process
   * holds a live lease on are left alone.
   */
  resumeInterrupted(options: { watch?: boolean } = {}): string[] {
    if (options.watch !== false && !this.sweeper && !this.abort.signal.aborted) {
      this.sweeper = setInterval(() => this.sweepOrphans(), this.leaseTtlMs);
      this.sweeper.unref();
    }
    return this.sweepOrphans();
  }

  /** Who is driving `runId`, if anyone holds a live lease. */
  leaseHolder(runId: string): string | null {
    const row = this.db.select().from(runLeases).where(eq(runLeases.runId, runId)).get();
    return row && row.expiresAtMs > this.clock.nowMs() ? row.ownerId : null;
  }

  /** Stops driving runs and releases their leases (they stay RUNNING and resume elsewhere or later). */
  async close(): Promise<void> {
    this.abort.abort();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.allSettled([...this.loops.values()].map((l) => l.done));
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private sweepOrphans(): string[] {
    const { runs } = workflowSchema;
    const now = this.clock.nowMs();
    const resumed: string[] = [];
    for (const { runId } of this.db.select({ runId: runs.runId }).from(runs).where(eq(runs.status, 'RUNNING')).all()) {
      if (this.loops.has(runId)) continue;
      const failed = this.failedAt.get(runId);
      if (failed !== undefined && now - failed < FAILED_RUN_BACKOFF_MS) continue;
      try {
        this.drive(runId, 'resume');
        resumed.push(runId);
      } catch {
        // Another process holds a live lease on it.
      }
    }
    return resumed;
  }

  /** Takes (or renews) the lease on `runId`; false when another process holds a live one. */
  private claim(runId: string): boolean {
    const now = this.clock.nowMs();
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(runLeases).where(eq(runLeases.runId, runId)).get();
        if (row && row.ownerId !== this.ownerId && row.expiresAtMs > now) return false;
        const lease = { ownerId: this.ownerId, expiresAtMs: now + this.leaseTtlMs };
        tx.insert(runLeases).values({ runId, ...lease }).onConflictDoUpdate({ target: runLeases.runId, set: lease }).run();
        return true;
      },
      { behavior: 'immediate' }
    );
  }

  private releaseLease(runId: string): void {
    this.db.delete(runLeases).where(and(eq(runLeases.runId, runId), eq(runLeases.ownerId, this.ownerId))).run();
  }

  /** Renews every lease this process drives; a loop whose lease was taken over is stopped. */
  private renewLeases(): void {
    const expiresAtMs = this.clock.nowMs() + this.leaseTtlMs;
    for (const [runId, loop] of this.loops) {
      const renewed = this.db
        .update(runLeases)
        .set({ expiresAtMs })
        .where(and(eq(runLeases.runId, runId), eq(runLeases.ownerId, this.ownerId)))
        .run();
      if (renewed.changes === 0 && !loop.abort.signal.aborted) {
        this.logger.error({ runId }, 'lost the lease on a workflow run; another process took it over');
        loop.abort.abort();
      }
    }
  }

  private heldElsewhere(runId: string): boolean {
    const holder = this.leaseHolder(runId);
    return holder !== null && holder !== this.ownerId;
  }

  /** After committing an answer: the process already driving the run picks it up itself. */
  private driveUnlessHeldElsewhere(runId: string): void {
    if (!this.heldElsewhere(runId)) this.drive(runId, 'continue');
  }

  private drive(runId: string, mode: 'continue' | 'resume'): void {
    // One pending continuation is enough: it re-reads the latest state when it runs.
    const loop = this.loops.get(runId);
    if (mode === 'continue' && loop && loop.queue.length > 0) return;
    this.enqueue(runId, async (signal) => {
      if (mode === 'resume') {
        await this.runtime.resume(runId, { signal });
      } else {
        await this.runtime.runUntilSettled(runId, { signal });
      }
    });
  }

  /**
   * Queues work on the run's driver loop, starting one (and taking the run's lease) if needed.
   * Throws `conflict` when another process is driving the run.
   */
  private enqueue(runId: string, work: (signal: AbortSignal) => Promise<unknown>): void {
    const existing = this.loops.get(runId);
    if (existing) {
      existing.queue.push(() => work(existing.abort.signal));
      return;
    }
    if (this.abort.signal.aborted) throw conflict('The run service is shutting down');
    if (!this.claim(runId)) throw conflict(`Run "${runId}" is being driven by another process`);
    const abort = new AbortController();
    const stop = () => abort.abort();
    this.abort.signal.addEventListener('abort', stop, { once: true });
    const loop: DriveLoop = { queue: [() => work(abort.signal)], abort, done: Promise.resolve() };
    this.loops.set(runId, loop);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.renewLeases(), Math.max(10, Math.floor(this.leaseTtlMs / 3)));
      this.heartbeat.unref();
    }
    loop.done = (async () => {
      try {
        while (loop.queue.length > 0 && !abort.signal.aborted) {
          const next = loop.queue.shift()!;
          try {
            await next();
            this.failedAt.delete(runId);
          } catch (err) {
            if (!abort.signal.aborted) {
              this.failedAt.set(runId, this.clock.nowMs());
              this.logger.error({ err, runId }, 'workflow run driver failed');
            }
          }
        }
      } finally {
        this.abort.signal.removeEventListener('abort', stop);
        this.loops.delete(runId);
        this.releaseLease(runId);
        if (this.loops.size === 0 && this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = null;
        }
      }
    })();
  }
}
