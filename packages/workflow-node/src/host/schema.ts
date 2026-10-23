import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Host tables: the workflow library and registered workspaces. They live in the workflow
 * database next to the run tables but migrate with their own journal (`migrateHostTables`).
 */

export const workflows = sqliteTable('workflows', {
  workflowId: text('workflow_id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  latestDigest: text('latest_digest').notNull(),
  /** Canvas positions keyed by root-scope node id. */
  layout: text('layout_json', { mode: 'json' }).notNull(),
  /** Workspace each slot binds to unless a run picks another (slot -> workspace id). */
  workspaceBindings: text('workspace_bindings_json', { mode: 'json' }).notNull().default({}),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

/** Every saved definition, content-addressed by its digest. */
export const workflowVersions = sqliteTable('workflow_versions', {
  workflowId: text('workflow_id').notNull(),
  digest: text('digest').notNull(),
  definition: text('definition_json', { mode: 'json' }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [primaryKey({ columns: [t.workflowId, t.digest] })]);

/** Directories registered for workflows to work in; runs bind workspace slots to these. */
export const workspaces = sqliteTable('workspaces', {
  workspaceId: text('workspace_id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  isolation: text('isolation', { enum: ['in-place', 'git-worktree'] }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

/**
 * Which host process is driving a run. Holders renew `expiresAtMs` while they drive; another
 * process only takes a run over once its lease has expired (the holder crashed or hung).
 */
export const runLeases = sqliteTable('run_leases', {
  runId: text('run_id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
});
