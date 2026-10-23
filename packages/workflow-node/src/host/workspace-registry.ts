import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  listWorkspaceSlots,
  type RunWorkspaceBinding,
  type WorkflowDefinition,
  type WorkspaceIsolation,
} from '@universal-agent/workflow-contract';
import { type Clock, SystemClock } from '@universal-agent/workflow-runtime';
import { asc, eq } from 'drizzle-orm';
import type { WorkflowDatabase } from '../store/sqlite/database';
import { createRunWorktree, findGitRoot, removeRunWorktree } from '../workspace/git-worktree';
import { conflict, invalid, notFound } from './errors';
import { migrateHostTables } from './migrations';
import { workspaces } from './schema';

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly isolation: WorkspaceIsolation;
  /** Whether `path` is inside a git repository (required for `git-worktree`). */
  readonly git: boolean;
  /** False when the directory no longer exists. */
  readonly exists: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface WorkspaceInput {
  readonly name?: string;
  readonly path: string;
  readonly isolation?: WorkspaceIsolation;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directories workflows can work in. A run binds each of its workflow's workspace slots to
 * one of these; `git-worktree` workspaces get a fresh worktree per run so parallel runs
 * never touch each other's files.
 */
export class WorkspaceRegistry {
  private readonly db: WorkflowDatabase;
  private readonly clock: Clock;
  private readonly worktreesDir: string;

  constructor(options: { db: WorkflowDatabase; worktreesDir: string; clock?: Clock }) {
    this.db = options.db;
    this.clock = options.clock ?? new SystemClock();
    this.worktreesDir = options.worktreesDir;
    migrateHostTables(this.db);
  }

  private async toRecord(row: typeof workspaces.$inferSelect): Promise<WorkspaceRecord> {
    const exists = isDirectory(row.path);
    return {
      id: row.workspaceId,
      name: row.name,
      path: row.path,
      isolation: row.isolation,
      git: exists && (await findGitRoot(row.path)) !== null,
      exists,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
    };
  }

  async list(): Promise<WorkspaceRecord[]> {
    const rows = this.db.select().from(workspaces).orderBy(asc(workspaces.name)).all();
    return Promise.all(rows.map((row) => this.toRecord(row)));
  }

  async get(id: string): Promise<WorkspaceRecord> {
    const row = this.db.select().from(workspaces).where(eq(workspaces.workspaceId, id)).get();
    if (!row) throw notFound(`Workspace "${id}"`);
    return this.toRecord(row);
  }

  private async validate(path: string, isolation: WorkspaceIsolation): Promise<string> {
    if (!isAbsolute(path)) throw invalid(`Workspace path must be absolute (got "${path}")`);
    const normalized = resolve(path);
    if (!isDirectory(normalized)) throw invalid(`"${normalized}" is not an existing directory`);
    if (isolation === 'git-worktree' && !(await findGitRoot(normalized))) {
      throw invalid(`"${normalized}" is not in a git repository, so it cannot use git worktrees`);
    }
    return normalized;
  }

  async create(input: WorkspaceInput): Promise<WorkspaceRecord> {
    const isolation = input.isolation ?? 'in-place';
    const path = await this.validate(input.path, isolation);
    if (this.db.select().from(workspaces).where(eq(workspaces.path, path)).get()) {
      throw conflict(`"${path}" is already registered`);
    }
    const now = this.clock.nowMs();
    const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
    this.db
      .insert(workspaces)
      .values({ workspaceId, name: input.name?.trim() || basename(path), path, isolation, createdAtMs: now, updatedAtMs: now })
      .run();
    return this.get(workspaceId);
  }

  async update(id: string, patch: Partial<WorkspaceInput>): Promise<WorkspaceRecord> {
    const current = await this.get(id);
    const isolation = patch.isolation ?? current.isolation;
    const path = patch.path !== undefined || patch.isolation !== undefined
      ? await this.validate(patch.path ?? current.path, isolation)
      : current.path;
    const clash = this.db.select().from(workspaces).where(eq(workspaces.path, path)).get();
    if (clash && clash.workspaceId !== id) throw conflict(`"${path}" is already registered`);
    this.db
      .update(workspaces)
      .set({ name: patch.name?.trim() || current.name, path, isolation, updatedAtMs: this.clock.nowMs() })
      .where(eq(workspaces.workspaceId, id))
      .run();
    return this.get(id);
  }

  remove(id: string): void {
    const changed = this.db.delete(workspaces).where(eq(workspaces.workspaceId, id)).run();
    if (changed.changes === 0) throw notFound(`Workspace "${id}"`);
  }

  /** Registers `path` (the server's working directory) unless it already is; returns its record. */
  async ensure(path: string): Promise<WorkspaceRecord> {
    const normalized = resolve(path);
    const row = this.db.select().from(workspaces).where(eq(workspaces.path, normalized)).get();
    return row ? this.toRecord(row) : this.create({ path: normalized });
  }

  /**
   * Resolves the directory for every slot of `definition` for a new run: the run's choice,
   * else the workflow's saved default, else (implicit `main` slot only) `fallbackWorkspaceId`.
   * Creates worktrees for `git-worktree` workspaces. Throws `invalid` when a required slot is unbound.
   */
  async bindRun(input: {
    readonly runId: string;
    readonly definition: WorkflowDefinition;
    readonly chosen?: Readonly<Record<string, string>>;
    readonly defaults?: Readonly<Record<string, string>>;
    readonly fallbackWorkspaceId?: string;
  }): Promise<Record<string, RunWorkspaceBinding>> {
    const slots = listWorkspaceSlots(input.definition);
    for (const slot of Object.keys(input.chosen ?? {})) {
      if (!slots.some((s) => s.name === slot)) throw invalid(`Workflow has no workspace slot "${slot}"`);
    }
    const bound: Record<string, RunWorkspaceBinding> = {};
    try {
      await this.bindSlots(input, slots, bound);
    } catch (err) {
      // Don't leave worktrees behind for a run that never started.
      for (const binding of Object.values(bound)) {
        if (binding.sourcePath) await removeRunWorktree({ path: binding.path, sourcePath: binding.sourcePath }).catch(() => undefined);
      }
      throw err;
    }
    return bound;
  }

  private async bindSlots(
    input: Parameters<WorkspaceRegistry['bindRun']>[0],
    slots: ReturnType<typeof listWorkspaceSlots>,
    bound: Record<string, RunWorkspaceBinding>
  ): Promise<void> {
    const missing: string[] = [];
    for (const slot of slots) {
      const workspaceId =
        input.chosen?.[slot.name] ??
        input.defaults?.[slot.name] ??
        (input.definition.workspaces.length === 0 ? input.fallbackWorkspaceId : undefined);
      if (!workspaceId) {
        if (slot.required) missing.push(slot.name);
        continue;
      }
      const workspace = await this.get(workspaceId).catch(() => {
        throw invalid(`Slot "${slot.name}" is bound to unknown workspace "${workspaceId}"`);
      });
      if (!workspace.exists) {
        throw invalid(`Workspace "${workspace.name}" (${workspace.path}) no longer exists`);
      }
      const base = { slot: slot.name, workspaceId: workspace.id, name: workspace.name, isolation: workspace.isolation };
      if (workspace.isolation === 'git-worktree') {
        const worktree = await createRunWorktree({
          repoPath: workspace.path,
          worktreesDir: this.worktreesDir,
          runId: input.runId,
          slot: slot.name,
        }).catch((err: unknown) => {
          throw invalid(`Could not create a worktree for "${workspace.name}": ${err instanceof Error ? err.message : String(err)}`);
        });
        bound[slot.name] = { ...base, path: worktree.path, sourcePath: worktree.sourcePath, branch: worktree.branch };
      } else {
        bound[slot.name] = { ...base, path: workspace.path };
      }
    }
    if (missing.length > 0) {
      throw invalid(`Choose a workspace for ${missing.map((m) => `"${m}"`).join(', ')}`, { missingSlots: missing });
    }
  }
}
