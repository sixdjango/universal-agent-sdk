import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  type AgentAdapter,
  type AgentRegistry,
  type ChiefSupervisor,
  type ChiefRuntimeOptions,
  type Clock,
  createWorkflowRuntime,
  type IdGenerator,
  type WorkflowRuntime,
} from '@universal-agent/workflow-runtime';
import {
  type RoleBindingTarget,
  UniversalAgentExecutor,
  type UniversalAgentExecutorOptions,
} from './executors/universal-agent-executor';
import {
  openWorkflowDatabase,
  resolveUniversalAgentHome,
  resolveWorkflowStoragePaths,
  type WorkflowDatabase,
} from './store/sqlite/database';
import { SqliteArtifactStore } from './store/sqlite/sqlite-artifact-store';
import { SqliteNodeDataStore } from './store/sqlite/sqlite-node-data-store';
import { SqliteConversationStore } from './store/sqlite/sqlite-conversation-store';
import { SqliteRuntimeStore } from './store/sqlite/sqlite-runtime-store';
import { LocalWorkspaceManager } from './workspace/local-workspace-manager';

export * from './artifact-tools/host';
export * from './artifact-tools/tools';
export * from './executors/script-executor';
export * from './host/index';
export * from './executors/universal-agent-executor';
export * from './runtimes';
export * from './store/sqlite/database';
export * as workflowSchema from './store/sqlite/schema';
export * from './store/sqlite/sqlite-artifact-store';
export * from './store/sqlite/sqlite-node-data-store';
export * from './store/sqlite/sqlite-conversation-store';
export * from './store/sqlite/sqlite-runtime-store';
export * from './workspace/change-capture';
export * from './workspace/fork';
export * from './workspace/git-worktree';
export * from './workspace/local-workspace-manager';
export * from './workspace/replay';

export interface CreateNodeWorkflowRuntimeOptions {
  readonly workdir: string;
  /**
   * Root for `workflow/workflow.db` and `workflow/blobs/`.
   * Defaults to `$UNIVERSAL_AGENT_HOME`, then `~/.universal-agent`.
   */
  readonly homeDir?: string;
  /** Use an already-open database instead of `<homeDir>/workflow/workflow.db`. */
  readonly db?: WorkflowDatabase;
  readonly agentDataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly roleBindings?: Readonly<Record<string, RoleBindingTarget>>;
  readonly defaultTarget?: RoleBindingTarget;
  readonly onRequestPermission?: UniversalAgentExecutorOptions['onRequestPermission'];
  readonly chiefPermissions?: UniversalAgentExecutorOptions['chiefPermissions'];
  readonly conversationStore?: UniversalAgentExecutorOptions['conversationStore'];
  readonly artifactTools?: UniversalAgentExecutorOptions['artifactTools'];
  readonly captureChanges?: UniversalAgentExecutorOptions['captureChanges'];
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  /**
   * Optional agent layer (e.g. `SqliteAgentRegistry` / `AgentChiefSupervisor` from
   * `@universal-agent/workflow-agents`). Without them nodes run on their `role` bindings.
   */
  readonly agentRegistry?: AgentRegistry;
  /** Extra agent adapters by name; `'acp'` is served by the built-in client executor. */
  readonly adapters?: Readonly<Record<string, AgentAdapter>>;
  readonly chief?: ChiefSupervisor;
  readonly chiefOptions?: ChiefRuntimeOptions;
  readonly parallelOptions?: { readonly maxConcurrency?: number };
}

/** Run-level ids must stay unique across process restarts, so the Node host defaults to UUIDs. */
export class RandomIdGenerator implements IdGenerator {
  nextId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

export function createNodeWorkflowRuntime(
  options: CreateNodeWorkflowRuntimeOptions
): WorkflowRuntime {
  const paths = resolveWorkflowStoragePaths(
    resolveUniversalAgentHome({ homeDir: options.homeDir })
  );
  const db = options.db ?? openWorkflowDatabase(paths.databasePath);
  const store = new SqliteRuntimeStore({ db, clock: options.clock });
  const artifacts = new SqliteArtifactStore({
    db,
    blobsDir: paths.blobsDir,
    clock: options.clock,
  });
  const workspaces = new LocalWorkspaceManager({ db, forksDir: join(paths.worktreesDir, 'forks') });
  const executor = new UniversalAgentExecutor({
    workdir: options.workdir,
    dataDir: options.agentDataDir,
    env: options.env,
    roleBindings: options.roleBindings,
    defaultTarget: options.defaultTarget,
    onRequestPermission: options.onRequestPermission,
    chiefPermissions: options.chiefPermissions,
    artifactTools: options.artifactTools,
    captureChanges: options.captureChanges,
    conversationStore: options.conversationStore ?? new SqliteConversationStore({ db }),
  });

  return createWorkflowRuntime({
    store,
    artifacts,
    workspaces,
    nodeData: new SqliteNodeDataStore({ db, ...(options.clock ? { clock: options.clock } : {}) }),
    executor,
    clock: options.clock,
    idGenerator: options.idGenerator ?? new RandomIdGenerator(),
    ...(options.agentRegistry ? { agentRegistry: options.agentRegistry } : {}),
    ...(options.adapters ? { adapters: options.adapters } : {}),
    ...(options.chief ? { chief: options.chief } : {}),
    ...(options.chiefOptions ? { chiefOptions: options.chiefOptions } : {}),
    ...(options.parallelOptions ? { parallelOptions: options.parallelOptions } : {}),
  });
}
