import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { resolveMigrationsFolder, type WorkflowDatabase } from '../store/sqlite/database';

/**
 * Creates or upgrades the host tables (workflow library, workspaces) inside the workflow
 * database. They keep their own journal so hosts that only run workflows never create them.
 * The journal name predates these tables moving out of the server package; keeping it lets
 * existing databases see their migrations as already applied.
 */
export function migrateHostTables(db: WorkflowDatabase): void {
  migrate(db, {
    migrationsFolder: resolveMigrationsFolder('@universal-agent/workflow-node', import.meta.url, 'drizzle-host'),
    migrationsTable: '__drizzle_migrations_server',
  });
}
