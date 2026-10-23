import type { AgentProfileInput } from '@universal-agent/workflow-contract';
import {
  type CreateNodeWorkflowRuntimeOptions,
  createNodeWorkflowRuntime,
  openWorkflowDatabase,
  resolveUniversalAgentHome,
  resolveWorkflowStoragePaths,
  type WorkflowDatabase,
} from '@universal-agent/workflow-node';
import type { ChiefSupervisor, WorkflowRuntime } from '@universal-agent/workflow-runtime';
import { AgentChiefSupervisor } from './llm-chief';
import { SqliteAgentRegistry } from './sqlite-agent-registry';

export interface CreateAgentWorkflowRuntimeOptions
  extends Omit<CreateNodeWorkflowRuntimeOptions, 'agentRegistry' | 'chief'> {
  /** Profiles to register (idempotent per version) before the runtime starts. */
  readonly agents?: readonly AgentProfileInput[];
  /**
   * Supervisor for definitions that declare a `chief` policy. Defaults to the LLM
   * `AgentChiefSupervisor`; pass `false` to ignore chief policies.
   */
  readonly chief?: ChiefSupervisor | false;
}

export interface AgentWorkflowRuntime {
  readonly runtime: WorkflowRuntime;
  readonly registry: SqliteAgentRegistry;
  /** The workflow-node database shared by runs, artifacts and agents. */
  readonly db: WorkflowDatabase;
}

/**
 * `createNodeWorkflowRuntime` plus the agent layer: one workflow-node database
 * (`$UNIVERSAL_AGENT_HOME/workflow/workflow.db`, default `~/.universal-agent`) holds runs,
 * artifacts and agent profiles.
 */
export function createAgentWorkflowRuntime(
  options: CreateAgentWorkflowRuntimeOptions
): AgentWorkflowRuntime {
  const { agents, chief, ...nodeOptions } = options;
  const db =
    nodeOptions.db ??
    openWorkflowDatabase(
      resolveWorkflowStoragePaths(resolveUniversalAgentHome({ homeDir: nodeOptions.homeDir }))
        .databasePath
    );
  const registry = new SqliteAgentRegistry({ db, clock: nodeOptions.clock });
  for (const profile of agents ?? []) {
    registry.register(profile);
  }

  const runtime = createNodeWorkflowRuntime({
    ...nodeOptions,
    db,
    agentRegistry: registry,
    ...(chief === false ? {} : { chief: chief ?? new AgentChiefSupervisor() }),
  });
  return { runtime, registry, db };
}
