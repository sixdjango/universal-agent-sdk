import { type CompiledGraphScope, type CompiledWorkflowPlan, compileWorkflowDefinition, computeDownstreamSubgraph } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from './ports';
import { resolveCompiledScopeByKey } from './scheduler/graph-reducer';

/** A workspace change an inherited step made in the source run, to replay in the fork. */
export interface InheritedWorkspaceChange {
  /** Workspace slot the step wrote in. */
  readonly slot: string;
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly attemptId: string;
  /** Artifact holding the step's unified diff (paths relative to the workspace). */
  readonly artifactId: string;
  readonly files: readonly string[];
  /** Git trees before and after the change, when the source run recorded them. */
  readonly trees?: { readonly before: string; readonly after: string };
  readonly completedAtMs: number;
}

/** What forking a run from a step does, before anything is written. */
export interface RunForkPlan {
  /** The root-level step the fork runs again from (the container holding the chosen step, if it is nested). */
  readonly fromNodeId: string;
  /** Root-level steps whose results are taken over from the source run. */
  readonly inherited: readonly string[];
  /** Root-level steps that run again: the fork point and everything downstream of it, plus steps the source run never finished. */
  readonly rerun: readonly string[];
  /** Workspace changes of the inherited steps, oldest first. */
  readonly changes: readonly InheritedWorkspaceChange[];
}

export class RunForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunForkError';
  }
}

/** The root-level step a step belongs to: itself, or the loop / parallel container holding it. */
function rootStepOf(plan: CompiledWorkflowPlan, nodeId: string): string | undefined {
  if (plan.rootScope.nodesById[nodeId]) return nodeId;
  const contains = (scope: CompiledGraphScope): boolean =>
    Boolean(scope.nodesById[nodeId]) || Object.values(scope.childScopes).some(contains);
  return Object.entries(plan.rootScope.childScopes).find(([, scope]) => contains(scope))?.[0];
}

/** Steps that lead to `nodeId` along control and data edges. */
function ancestorsOf(scope: CompiledGraphScope, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of [...(scope.incomingControlEdges[current] ?? []), ...(scope.incomingDataEdges[current] ?? [])]) {
      const from = edge.fromNodeId;
      if (from === '$input' || seen.has(from) || !scope.nodesById[from]) continue;
      seen.add(from);
      queue.push(from);
    }
  }
  return seen;
}

/** Scopes, attempts and records belonging to a root-level step: its own, and those of its loop rounds or items. */
export function belongsToRootStep(scopeKey: string, nodeId: string, rootNodeId: string): boolean {
  if (scopeKey === '$root') return nodeId === rootNodeId;
  const prefix = `$root/${rootNodeId}`;
  return scopeKey === prefix || [':', '[', '/'].some((next) => scopeKey.startsWith(prefix + next));
}

/**
 * Plans forking `source` from `nodeId` onto `plan` (the definition the fork runs, matched to
 * the source run by step id). The fork point and everything downstream of it run again; every
 * other root-level step the source run finished is taken over. Every step the fork point
 * depends on must have succeeded in the source run.
 */
export function planRunFork(source: WorkflowRunState, plan: CompiledWorkflowPlan, nodeId: string): RunForkPlan {
  const fromNodeId = rootStepOf(plan, nodeId);
  if (!fromNodeId) throw new RunForkError(`Step "${nodeId}" is not in the workflow`);
  const scope = plan.rootScope;
  const sourceRoot = source.scopes.$root;
  if (!sourceRoot) throw new RunForkError(`Run "${source.runId}" has no state to fork from`);

  const downstream = new Set(computeDownstreamSubgraph(scope, [fromNodeId], { includeStart: true }));
  const missing = [...ancestorsOf(scope, fromNodeId)].filter((id) => sourceRoot.nodes[id]?.status !== 'SUCCEEDED' && sourceRoot.nodes[id]?.status !== 'SKIPPED');
  if (missing.length > 0) {
    throw new RunForkError(
      `Cannot fork from "${fromNodeId}": ${missing.map((id) => `"${id}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} upstream of it but did not finish in run "${source.runId}"${missing.some((id) => !sourceRoot.nodes[id]) ? ' (or is not in it)' : ''}`
    );
  }

  const inherited: string[] = [];
  const rerun: string[] = [];
  for (const id of scope.topologicalOrder) {
    const status = sourceRoot.nodes[id]?.status;
    if (!downstream.has(id) && (status === 'SUCCEEDED' || status === 'SKIPPED')) inherited.push(id);
    else rerun.push(id);
  }

  // Slots come from the definition the source run executed.
  const sourcePlan = compileWorkflowDefinition(source.definition);
  const sourcePlanScope = (scopeKey: string) => {
    try {
      return resolveCompiledScopeByKey(sourcePlan, scopeKey);
    } catch {
      return undefined;
    }
  };
  const changes: InheritedWorkspaceChange[] = [];
  for (const attempt of Object.values(source.attempts)) {
    if (attempt.status !== 'SUCCEEDED' || !attempt.changes?.artifactId || attempt.changes.files.length === 0) continue;
    if (!inherited.some((id) => belongsToRootStep(attempt.scopeKey, attempt.nodeId, id))) continue;
    const slot = sourcePlanScope(attempt.scopeKey)?.workspaceSlots[attempt.nodeId] ?? Object.keys(source.workspaces)[0] ?? 'main';
    changes.push({
      slot,
      scopeKey: attempt.scopeKey,
      nodeId: attempt.nodeId,
      attemptId: attempt.attemptId,
      artifactId: attempt.changes.artifactId,
      files: attempt.changes.files.map((f) => f.path),
      ...(attempt.changes.trees ? { trees: attempt.changes.trees } : {}),
      completedAtMs: attempt.completedAtMs ?? attempt.startedAtMs,
    });
  }
  changes.sort((a, b) => a.completedAtMs - b.completedAtMs);
  return { fromNodeId, inherited, rerun, changes };
}
