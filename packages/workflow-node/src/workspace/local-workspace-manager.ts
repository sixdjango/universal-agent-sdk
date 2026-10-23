import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunWorkspaceBinding } from '@universal-agent/workflow-contract';
import type { IsolatedWorkspace, WorkspaceLease, WorkspaceManager } from '@universal-agent/workflow-runtime';
import { eq, lt } from 'drizzle-orm';
import type { WorkflowDatabase } from '../store/sqlite/database';
import { workspaceLeases } from '../store/sqlite/schema';
import { forkWorkspace } from './fork';
import { shortRunId } from './git-worktree';

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

/** Branch and directory names may only use characters git and file systems accept everywhere. */
const safe = (value: string) => value.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 64) || 'x';

export interface LocalWorkspaceManagerOptions {
  /** Where steps' private workspace copies (git worktrees) go (default: the OS temp dir). */
  readonly forksDir?: string;
  /**
   * Keep write leases in this workflow database so every process sharing it respects them.
   * Without it, leases only coordinate the steps of this process.
   */
  readonly db?: WorkflowDatabase;
  /** Lease lifetime without renewal when stored in `db` (default 60 s). */
  readonly leaseTtlMs?: number;
}

/** How often a waiting acquirer re-checks leases held by other processes. */
const CROSS_PROCESS_POLL_MS = 250;

/**
 * Write leases on workspace paths, plus private git-worktree copies for steps that write
 * alongside other writers (`isolate`). Merging a copy back takes a lease on the whole
 * workspace, so merges never interleave with each other or with steps writing in place.
 */
export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly activeLeases = new Map<string, WorkspaceLease>();
  private readonly waitQueue: (() => void)[] = [];
  private seq = 0;
  private readonly forksDir: string;
  private readonly db?: WorkflowDatabase;
  private readonly leaseTtlMs: number;
  private readonly ownerId = `ws_${randomUUID()}`;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(options: LocalWorkspaceManagerOptions = {}) {
    this.forksDir = options.forksDir ?? join(tmpdir(), 'ua-workflow-forks');
    if (options.db) this.db = options.db;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
  }

  async isolate(input: {
    runId: string;
    attemptId: string;
    nodeId: string;
    workspace: RunWorkspaceBinding;
  }): Promise<IsolatedWorkspace | null> {
    return forkWorkspace({
      dir: input.workspace.path,
      forkPath: join(this.forksDir, safe(input.runId), safe(input.attemptId)),
      conflictBranch: `ua/${safe(shortRunId(input.runId))}/${safe(input.nodeId)}-${safe(input.attemptId.slice(-6))}`,
      withMergeLock: async (fn) => {
        const lease = await this.acquireLease({
          runId: input.runId,
          attemptId: `${input.attemptId}:merge`,
          writeScopes: ['*'],
          workspace: input.workspace.path,
        });
        try {
          return await fn();
        } finally {
          await this.releaseLease(lease.leaseId);
        }
      },
    });
  }

  async acquireLease(input: {
    runId: string;
    attemptId: string;
    writeScopes: readonly string[];
    workspace?: string;
  }): Promise<WorkspaceLease> {
    this.seq += 1;
    const lease: WorkspaceLease = {
      leaseId: `ws_lease_${this.ownerId}_${this.seq}`,
      runId: input.runId,
      attemptId: input.attemptId,
      writeScopes: [...input.writeScopes],
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    };
    if (input.writeScopes.length > 0) {
      while (this.hasLocalConflict(input.workspace, input.writeScopes) || !this.tryStore(lease)) {
        await new Promise<void>((resolve) => {
          const timer = this.db ? setTimeout(resolve, CROSS_PROCESS_POLL_MS) : null;
          this.waitQueue.push(() => {
            if (timer) clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    this.activeLeases.set(lease.leaseId, lease);
    this.startHeartbeat();
    return lease;
  }

  async releaseLease(leaseId: string): Promise<void> {
    const lease = this.activeLeases.get(leaseId);
    this.activeLeases.delete(leaseId);
    if (this.db && lease && lease.writeScopes.length > 0) {
      this.db.delete(workspaceLeases).where(eq(workspaceLeases.leaseId, leaseId)).run();
    }
    if (this.activeLeases.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const waiters = this.waitQueue.splice(0);
    for (const wake of waiters) {
      wake();
    }
  }

  /** Write scopes are paths inside a workspace, so only leases on the same workspace can clash. */
  private hasLocalConflict(workspace: string | undefined, requestedScopes: readonly string[]): boolean {
    for (const active of this.activeLeases.values()) {
      if (active.workspace !== workspace) continue;
      if (anyScopeOverlaps(requestedScopes, active.writeScopes)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Records `lease` in the database unless a live lease of another process clashes with it.
   * Always true without a database (local conflicts are checked separately).
   */
  private tryStore(lease: WorkspaceLease): boolean {
    if (!this.db) return true;
    const workspace = lease.workspace ?? '';
    const now = Date.now();
    return this.db.transaction(
      (tx) => {
        tx.delete(workspaceLeases).where(lt(workspaceLeases.expiresAtMs, now)).run();
        const held = tx.select().from(workspaceLeases).where(eq(workspaceLeases.workspace, workspace)).all();
        if (held.some((row) => row.ownerId !== this.ownerId && anyScopeOverlaps(lease.writeScopes, row.writeScopes as string[]))) {
          return false;
        }
        tx.insert(workspaceLeases)
          .values({
            leaseId: lease.leaseId,
            workspace,
            writeScopes: [...lease.writeScopes],
            ownerId: this.ownerId,
            expiresAtMs: now + this.leaseTtlMs,
          })
          .run();
        return true;
      },
      { behavior: 'immediate' }
    );
  }

  private startHeartbeat(): void {
    if (!this.db || this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.db!.update(workspaceLeases)
        .set({ expiresAtMs: Date.now() + this.leaseTtlMs })
        .where(eq(workspaceLeases.ownerId, this.ownerId))
        .run();
    }, Math.max(10, Math.floor(this.leaseTtlMs / 3)));
    this.heartbeat.unref();
  }
}
