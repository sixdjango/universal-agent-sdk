import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

/** Overrides the `~/.universal-agent` root used for the workflow database and blobs. */
export const UNIVERSAL_AGENT_HOME_ENV = 'UNIVERSAL_AGENT_HOME';

export type WorkflowDatabase = NodeSQLiteDatabase & { $client: DatabaseSync };

/**
 * Resolves the Universal Agent home directory:
 * explicit `homeDir` > `$UNIVERSAL_AGENT_HOME` > `~/.universal-agent`.
 */
export function resolveUniversalAgentHome(
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  const fromEnv = (options.env ?? process.env)[UNIVERSAL_AGENT_HOME_ENV]?.trim();
  return options.homeDir ?? (fromEnv || join(homedir(), '.universal-agent'));
}

/** Layout of workflow storage under the home directory. */
export function resolveWorkflowStoragePaths(homeDir: string): {
  rootDir: string;
  databasePath: string;
  blobsDir: string;
  /** Per-run git worktrees for `git-worktree` workspaces. */
  worktreesDir: string;
} {
  const rootDir = join(homeDir, 'workflow');
  return {
    rootDir,
    databasePath: join(rootDir, 'workflow.db'),
    blobsDir: join(rootDir, 'blobs'),
    worktreesDir: join(rootDir, 'worktrees'),
  };
}

/**
 * Finds `<package root>/<folder>` by walking up from `fromUrl` (pass `import.meta.url`) to the
 * package.json named `packageName`; works both from `src/` (tests) and from a bundled `dist/`.
 */
export function resolveMigrationsFolder(packageName: string, fromUrl: string, folder = 'drizzle'): string {
  let dir = dirname(fileURLToPath(fromUrl));
  while (true) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === packageName) {
      return join(dir, folder);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot locate the ${packageName} package root to load its migrations`);
    }
    dir = parent;
  }
}

/**
 * Opens (creating if needed) the workflow SQLite database and applies pending migrations.
 * Pass `':memory:'` as `databasePath` for an ephemeral database.
 */
export function openWorkflowDatabase(databasePath: string): WorkflowDatabase {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA journal_mode = WAL');
  client.exec('PRAGMA synchronous = NORMAL');
  // Lets several processes share one database; writers queue instead of failing with SQLITE_BUSY.
  client.exec('PRAGMA busy_timeout = 5000');
  const db = drizzle({ client });
  migrate(db, { migrationsFolder: resolveMigrationsFolder('@universal-agent/workflow-node', import.meta.url) });
  return db;
}
