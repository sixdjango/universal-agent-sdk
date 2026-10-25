import {
  type WorkflowDefinition,
  validateWorkflowDefinition,
} from '@universal-agent/workflow-contract';
import { type Clock, SystemClock } from '@universal-agent/workflow-runtime';
import { and, desc, eq } from 'drizzle-orm';
import type { WorkflowDatabase } from '../store/sqlite/database';
import { conflict, invalidDefinition, notFound } from './errors';
import { migrateHostTables } from './migrations';
import { workflows, workflowVersions } from './schema';

/** Editor positions keyed by node path; opaque to the library, kept for UIs that draw the graph. */
export type CanvasLayout = Record<string, { x: number; y: number }>;

export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly digest: string;
  readonly updatedAtMs: number;
}

/** Default workspace per slot (slot -> workspace id). */
export type WorkspaceBindings = Record<string, string>;

export interface WorkflowRecord extends WorkflowSummary {
  readonly definition: WorkflowDefinition;
  readonly layout: CanvasLayout;
  readonly workspaceBindings: WorkspaceBindings;
  readonly versions: readonly { digest: string; createdAtMs: number }[];
}

/**
 * Saved workflows. Each save compiles the definition (rejecting invalid graphs) and keeps
 * every distinct version by digest, so runs can always be traced to what they executed.
 */
export class WorkflowLibrary {
  private readonly db: WorkflowDatabase;
  private readonly clock: Clock;

  constructor(options: { db: WorkflowDatabase; clock?: Clock }) {
    this.db = options.db;
    this.clock = options.clock ?? new SystemClock();
    migrateHostTables(this.db);
  }

  list(): WorkflowSummary[] {
    return this.db
      .select()
      .from(workflows)
      .orderBy(desc(workflows.updatedAtMs))
      .all()
      .map((row) => ({
        id: row.workflowId,
        name: row.name,
        description: row.description,
        digest: row.latestDigest,
        updatedAtMs: row.updatedAtMs,
      }));
  }

  get(workflowId: string): WorkflowRecord | null {
    const row = this.db.select().from(workflows).where(eq(workflows.workflowId, workflowId)).get();
    if (!row) return null;
    const versions = this.db
      .select({ digest: workflowVersions.digest, createdAtMs: workflowVersions.createdAtMs, definition: workflowVersions.definition })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflowId))
      .orderBy(desc(workflowVersions.createdAtMs))
      .all();
    const latest = versions.find((v) => v.digest === row.latestDigest);
    if (!latest) throw notFound(`Version ${row.latestDigest} of workflow "${workflowId}"`);
    return {
      id: row.workflowId,
      name: row.name,
      description: row.description,
      digest: row.latestDigest,
      updatedAtMs: row.updatedAtMs,
      definition: latest.definition as WorkflowDefinition,
      layout: row.layout as CanvasLayout,
      workspaceBindings: row.workspaceBindings as WorkspaceBindings,
      versions: versions.map(({ digest, createdAtMs }) => ({ digest, createdAtMs })),
    };
  }

  /**
   * Validates and stores `input` as the workflow's latest version.
   * `mode: 'create'` refuses existing ids; `mode: 'update'` refuses unknown ones.
   */
  save(
    input: unknown,
    options: { mode: 'create' | 'update' | 'upsert'; layout?: CanvasLayout }
  ): WorkflowRecord {
    const result = validateWorkflowDefinition(input);
    if (!result.ok) throw invalidDefinition(result.issues);
    const { definition, definitionDigest } = result.plan;
    const now = this.clock.nowMs();

    this.db.transaction(
      (tx) => {
        const existing = tx
          .select({ layout: workflows.layout })
          .from(workflows)
          .where(eq(workflows.workflowId, definition.id))
          .get();
        if (existing && options.mode === 'create') {
          throw conflict(`Workflow "${definition.id}" already exists`);
        }
        if (!existing && options.mode === 'update') {
          throw notFound(`Workflow "${definition.id}"`);
        }

        const known = tx
          .select({ digest: workflowVersions.digest })
          .from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, definition.id), eq(workflowVersions.digest, definitionDigest)))
          .get();
        if (!known) {
          tx.insert(workflowVersions)
            .values({ workflowId: definition.id, digest: definitionDigest, definition, createdAtMs: now })
            .run();
        }

        const layout = options.layout ?? (existing?.layout as CanvasLayout | undefined) ?? {};
        const row = {
          workflowId: definition.id,
          name: definition.name,
          description: definition.description ?? null,
          latestDigest: definitionDigest,
          layout,
          updatedAtMs: now,
        };
        tx.insert(workflows)
          .values({ ...row, createdAtMs: now })
          .onConflictDoUpdate({ target: workflows.workflowId, set: row })
          .run();
      },
      { behavior: 'immediate' }
    );
    return this.get(definition.id)!;
  }

  setWorkspaceBindings(workflowId: string, bindings: WorkspaceBindings): void {
    const changed = this.db
      .update(workflows)
      .set({ workspaceBindings: bindings, updatedAtMs: this.clock.nowMs() })
      .where(eq(workflows.workflowId, workflowId))
      .run();
    if (changed.changes === 0) throw notFound(`Workflow "${workflowId}"`);
  }

  setLayout(workflowId: string, layout: CanvasLayout): void {
    const changed = this.db
      .update(workflows)
      .set({ layout, updatedAtMs: this.clock.nowMs() })
      .where(eq(workflows.workflowId, workflowId))
      .run();
    if (changed.changes === 0) throw notFound(`Workflow "${workflowId}"`);
  }
}
