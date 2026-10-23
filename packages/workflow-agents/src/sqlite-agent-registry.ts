import {
  type AgentProfile,
  type AgentProfileInput,
  AgentProfileSchema,
  computeAgentDigest,
  formatAgentRef,
  parseAgentRef,
} from '@universal-agent/workflow-contract';
import { resolveMigrationsFolder, type WorkflowDatabase } from '@universal-agent/workflow-node';
import { type AgentRegistry, type Clock, SystemClock } from '@universal-agent/workflow-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { agents, agentVersions } from './schema';

/** Separate from the run tables' journal so each package migrates on its own. */
const MIGRATIONS_TABLE = '__drizzle_migrations_agents';

export interface RegisteredAgent {
  readonly profile: AgentProfile;
  readonly digest: string;
  /** False when the exact same version was already registered. */
  readonly created: boolean;
}

/**
 * `AgentRegistry` stored in the workflow-node database (`openWorkflowDatabase`), next to
 * the run tables. Agent tables keep their own migration journal so the node package never
 * creates them for hosts that do not use agents.
 */
export class SqliteAgentRegistry implements AgentRegistry {
  private readonly db: WorkflowDatabase;
  private readonly clock: Clock;

  constructor(options: { db: WorkflowDatabase; clock?: Clock }) {
    this.db = options.db;
    this.clock = options.clock ?? new SystemClock();
    migrate(this.db, {
      migrationsFolder: resolveMigrationsFolder('@universal-agent/workflow-agents', import.meta.url),
      migrationsTable: MIGRATIONS_TABLE,
    });
  }

  /**
   * Registers a profile version and makes it the agent's latest. Re-registering identical
   * content is a no-op; changing content requires a new `version`.
   */
  register(input: AgentProfileInput): RegisteredAgent {
    const profile = AgentProfileSchema.parse(input);
    const digest = computeAgentDigest(profile);
    const now = this.clock.nowMs();

    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select({ digest: agentVersions.digest })
          .from(agentVersions)
          .where(and(eq(agentVersions.agentId, profile.id), eq(agentVersions.version, profile.version)))
          .get();
        if (existing) {
          if (existing.digest !== digest) {
            throw new Error(
              `Agent "${formatAgentRef(profile.id, profile.version)}" is already registered with different content; bump its version`
            );
          }
          return { profile, digest, created: false };
        }

        tx.insert(agentVersions)
          .values({ agentId: profile.id, version: profile.version, digest, profile, createdAtMs: now })
          .run();
        tx.insert(agents)
          .values({
            agentId: profile.id,
            name: profile.name,
            latestVersion: profile.version,
            createdAtMs: now,
            updatedAtMs: now,
          })
          .onConflictDoUpdate({
            target: agents.agentId,
            set: { name: profile.name, latestVersion: profile.version, updatedAtMs: now },
          })
          .run();
        return { profile, digest, created: true };
      },
      { behavior: 'immediate' }
    );
  }

  async resolve(ref: string): Promise<AgentProfile | null> {
    const parsed = parseAgentRef(ref);
    if (!parsed) return null;
    const version =
      parsed.version ??
      this.db
        .select({ latestVersion: agents.latestVersion })
        .from(agents)
        .where(eq(agents.agentId, parsed.agentId))
        .get()?.latestVersion;
    if (version === undefined) return null;
    const row = this.db
      .select({ profile: agentVersions.profile })
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, parsed.agentId), eq(agentVersions.version, version)))
      .get();
    return row ? (row.profile as AgentProfile) : null;
  }

  /** All versions of `agentId`, oldest first. */
  listVersions(agentId: string): { version: string; digest: string; createdAtMs: number }[] {
    return this.db
      .select({
        version: agentVersions.version,
        digest: agentVersions.digest,
        createdAtMs: agentVersions.createdAtMs,
      })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(asc(agentVersions.createdAtMs))
      .all();
  }

  listAgents(): { agentId: string; name: string; latestVersion: string }[] {
    return this.db
      .select({ agentId: agents.agentId, name: agents.name, latestVersion: agents.latestVersion })
      .from(agents)
      .orderBy(asc(agents.agentId))
      .all();
  }
}
