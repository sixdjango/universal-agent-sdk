import { createAgentWorkflowRuntime } from '@universal-agent/workflow-agents';
import {
  AgentRuntimeCatalog,
  resolveUniversalAgentHome,
  resolveWorkflowStoragePaths,
} from '@universal-agent/workflow-node';
import { webDistDir } from '@universal-agent/workflow-web';
import { createWorkflowServer, type WorkflowServer, type WorkflowServerOptions } from './server';

export * from './errors';
export * from './samples';
export * from './security';
export * from './server';

export interface DefaultWorkflowServerOptions
  extends Pick<WorkflowServerOptions, 'allowedHosts' | 'logger' | 'resumeInterruptedRuns'> {
  /** Directory agents and scripts work in (default: current directory). */
  readonly workdir?: string;
  /** Overrides `$UNIVERSAL_AGENT_HOME` / `~/.universal-agent`. */
  readonly homeDir?: string;
}

/**
 * The out-of-the-box server: agent-enabled runtime on the workflow-node database
 * (`<home>/workflow/workflow.db`) plus the prebuilt web canvas.
 */
export async function createDefaultWorkflowServer(
  options: DefaultWorkflowServerOptions = {}
): Promise<WorkflowServer> {
  const workdir = options.workdir ?? process.cwd();
  const { runtime, registry, db } = createAgentWorkflowRuntime({
    workdir,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  return createWorkflowServer({
    runtime,
    db,
    registry,
    runtimeCatalog: new AgentRuntimeCatalog({ workdir }),
    workdir,
    worktreesDir: resolveWorkflowStoragePaths(
      resolveUniversalAgentHome({ ...(options.homeDir ? { homeDir: options.homeDir } : {}) })
    ).worktreesDir,
    webDir: webDistDir,
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.resumeInterruptedRuns !== undefined
      ? { resumeInterruptedRuns: options.resumeInterruptedRuns }
      : {}),
  });
}
