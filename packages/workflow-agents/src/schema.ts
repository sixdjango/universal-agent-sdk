import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Agent tables, created inside the `@universal-agent/workflow-node` database
 * (`<home>/workflow/workflow.db`) and migrated with their own journal.
 */

export const agents = sqliteTable('agents', {
  agentId: text('agent_id').primaryKey(),
  name: text('name').notNull(),
  latestVersion: text('latest_version').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

/** Immutable profile versions; a version's content never changes once registered. */
export const agentVersions = sqliteTable('agent_versions', {
  agentId: text('agent_id').notNull(),
  version: text('version').notNull(),
  digest: text('digest').notNull(),
  profile: text('profile_json', { mode: 'json' }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, (t) => [primaryKey({ columns: [t.agentId, t.version] })]);
