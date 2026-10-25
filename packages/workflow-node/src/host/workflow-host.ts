import { resolveSubflows, SubflowResolutionError, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import type { Clock, WorkflowRunState, WorkflowRuntime } from '@universal-agent/workflow-runtime';
import {
  resolveUniversalAgentHome,
  resolveWorkflowStoragePaths,
  type WorkflowDatabase,
} from '../store/sqlite/database';
import { invalid, notFound } from './errors';
import { createNodeConversationService, type ConversationService, type ConversationServiceOptions } from './conversations';
import { RunService, type RunServiceLogger, type RunServiceOptions } from './run-service';
import { WorkflowLibrary } from './workflow-library';
import { type WorkspaceRecord, WorkspaceRegistry } from './workspace-registry';

export interface WorkflowHostOptions {
  readonly runtime: WorkflowRuntime;
  /** The workflow database `runtime` stores its runs in. */
  readonly db: WorkflowDatabase;
  /**
   * Directory registered as the default workspace; workflows without workspace slots run
   * here (default: current directory).
   */
  readonly workdir?: string;
  /** Where per-run git worktrees go (default: `<home>/workflow/worktrees`). */
  readonly worktreesDir?: string;
  readonly clock?: Clock;
  readonly logger?: RunServiceLogger;
  /** Driver lease settings and continuation policy; runtime/db/clock/logger remain shared by the host. */
  readonly runOptions?: Omit<RunServiceOptions, 'runtime' | 'db' | 'clock' | 'logger'>;
  /** Optional host credentials, Agent factory, permission policy and storage override for chats. */
  readonly conversationOptions?: ConversationServiceOptions;
}

export interface StartWorkflowInput {
  readonly workflowId: string;
  readonly inputs?: Record<string, unknown>;
  /** Workspace id per slot; remembered as the workflow's defaults for the next run. */
  readonly workspaces?: Readonly<Record<string, string>>;
}

/**
 * Everything a product needs to offer workflows as a service, without any transport: a
 * versioned workflow library, registered workspaces, and runs driven in the background.
 * HTTP servers, CLIs or chat bots wrap these calls; errors are `WorkflowHostError`s.
 */
export class WorkflowHost {
  readonly library: WorkflowLibrary;
  readonly workspaces: WorkspaceRegistry;
  readonly runs: RunService;
  readonly conversations: ConversationService;
  /** The `workdir` workspace, used by workflows that declare no slots. */
  readonly defaultWorkspace: WorkspaceRecord;

  private constructor(parts: {
    library: WorkflowLibrary;
    workspaces: WorkspaceRegistry;
    runs: RunService;
    conversations: ConversationService;
    defaultWorkspace: WorkspaceRecord;
  }) {
    this.library = parts.library;
    this.workspaces = parts.workspaces;
    this.runs = parts.runs;
    this.conversations = parts.conversations;
    this.defaultWorkspace = parts.defaultWorkspace;
  }

  static async open(options: WorkflowHostOptions): Promise<WorkflowHost> {
    const clock = options.clock ? { clock: options.clock } : {};
    const workspaces = new WorkspaceRegistry({
      db: options.db,
      worktreesDir: options.worktreesDir ?? resolveWorkflowStoragePaths(resolveUniversalAgentHome()).worktreesDir,
      ...clock,
    });
    return new WorkflowHost({
      library: new WorkflowLibrary({ db: options.db, ...clock }),
      workspaces,
      runs: new RunService({ ...options.runOptions, runtime: options.runtime, db: options.db, ...clock, ...(options.logger ? { logger: options.logger } : {}) }),
      conversations: createNodeConversationService({ db: options.db, ...options.conversationOptions }),
      defaultWorkspace: await workspaces.ensure(options.workdir ?? process.cwd()),
    });
  }

  /**
   * Starts a saved workflow: binds its workspace slots (the given choice, else the workflow's
   * remembered one, else the default workspace for slot-less workflows), creates worktrees,
   * and drives the run in the background. The choice is remembered for next time.
   */
  async startRun(input: StartWorkflowInput): Promise<WorkflowRunState> {
    const record = this.library.get(input.workflowId);
    if (!record) throw notFound(`Workflow "${input.workflowId}"`);
    const definition = await this.embedSubflows(record.definition);
    const chosen = input.workspaces ?? {};
    const runId = this.runs.nextRunId();
    const bound = await this.workspaces.bindRun({
      runId,
      definition,
      chosen,
      defaults: record.workspaceBindings,
      fallbackWorkspaceId: this.defaultWorkspace.id,
    });
    const state = await this.runs.start(definition, input.inputs ?? {}, { runId, workspaces: bound });
    if (Object.keys(chosen).length > 0) {
      this.library.setWorkspaceBindings(record.id, { ...record.workspaceBindings, ...chosen });
    }
    return state;
  }

  /** Embeds the saved workflows its sub-flow steps run, so the run keeps them as they are now. */
  private async embedSubflows(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    try {
      return await resolveSubflows(definition, async (id) => this.library.get(id)?.definition ?? null);
    } catch (error) {
      if (error instanceof SubflowResolutionError) throw invalid(error.message);
      throw error;
    }
  }

  /** Unregisters a workspace; the default workspace stays, since slot-less workflows run there. */
  removeWorkspace(workspaceId: string): void {
    if (workspaceId === this.defaultWorkspace.id) {
      throw invalid('The default workspace cannot be removed');
    }
    this.workspaces.remove(workspaceId);
  }

  /** Stops driving runs; they stay RUNNING in storage and `runs.resumeInterrupted()` picks them up later. */
  async close(): Promise<void> {
    const results = await Promise.allSettled([this.runs.close(), this.conversations.shutdown()]);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Host shutdown failed');
  }
}

export function createWorkflowHost(options: WorkflowHostOptions): Promise<WorkflowHost> {
  return WorkflowHost.open(options);
}
