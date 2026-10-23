import type {
  ChiefPolicy,
  ChiefTriggerKind,
  CompiledWorkflowPlan,
} from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '../ports';
import { resolveCompiledScopeByKey } from '../scheduler/graph-reducer';

export interface ChiefTrigger {
  readonly kind: ChiefTriggerKind;
  readonly scopeKey?: string;
  readonly nodeId?: string;
  readonly requestId?: string;
  /** `user.message`: the `chief.user_message` being answered. */
  readonly messageId?: string;
  /** One-line, human/LLM readable description of what happened. */
  readonly detail: string;
}

export interface RunUsageTotals {
  readonly totalTokens: number;
  readonly costUsd: number;
}

export function computeRunUsage(state: Pick<WorkflowRunState, 'attempts'>): RunUsageTotals {
  let totalTokens = 0;
  let costUsd = 0;
  for (const attempt of Object.values(state.attempts)) {
    totalTokens += (attempt.receipt?.inputTokens ?? 0) + (attempt.receipt?.outputTokens ?? 0);
    costUsd += attempt.receipt?.totalCostUsd ?? 0;
  }
  return { totalTokens, costUsd };
}

/**
 * Scans events appended since `fromEventIndex` (plus budget totals and the optional stall
 * signal) and returns the triggers enabled by `policy`, in event order.
 */
export function detectChiefTriggers(
  plan: CompiledWorkflowPlan,
  state: WorkflowRunState,
  policy: ChiefPolicy,
  options: { readonly fromEventIndex: number; readonly stalled?: boolean }
): ChiefTrigger[] {
  const enabled = new Set(policy.triggers);
  const triggers: ChiefTrigger[] = [];

  for (const event of state.events.slice(options.fromEventIndex)) {
    if (event.type === 'node.completed' && event.status === 'FAILED') {
      const error = state.scopes[event.scopeKey]?.nodes[event.nodeId]?.error;
      triggers.push({
        kind: 'node.failed',
        scopeKey: event.scopeKey,
        nodeId: event.nodeId,
        detail: `Node "${event.nodeId}" in "${event.scopeKey}" failed${error ? `: ${error}` : ''}`,
      });
    } else if (event.type === 'node.waiting') {
      const nodeDef = resolveCompiledScopeByKey(plan, event.scopeKey).nodesById[event.nodeId];
      // GateNodes and exhausted-loop gates are reserved for humans.
      if (nodeDef?.kind === 'agent') {
        triggers.push({
          kind: 'wait.requested',
          scopeKey: event.scopeKey,
          nodeId: event.nodeId,
          requestId: event.requestId,
          detail: `Agent node "${event.nodeId}" asked: ${event.prompt}`,
        });
      }
    } else if (event.type === 'chief.escalation_resolved') {
      triggers.push({
        kind: 'escalation.resolved',
        requestId: event.requestId,
        detail: `Human ${event.responderId} answered escalation ${event.requestId}: ${
          typeof event.answer === 'string' ? event.answer : JSON.stringify(event.answer)
        }`,
      });
    } else if (event.type === 'loop.round.advanced' && event.roundIndex > 0) {
      triggers.push({
        kind: 'loop.round_needs_fix',
        ...(event.scopeKey ? { scopeKey: event.scopeKey } : {}),
        nodeId: event.loopNodeId,
        detail: `Loop "${event.loopNodeId}" did not pass in round ${event.roundIndex - 1} and is starting round ${event.roundIndex}`,
      });
    }
  }

  if (policy.budget && !state.chief.budgetTriggered) {
    const usage = computeRunUsage(state);
    const { maxTotalTokens, maxCostUsd } = policy.budget;
    if (
      (maxTotalTokens !== undefined && usage.totalTokens > maxTotalTokens) ||
      (maxCostUsd !== undefined && usage.costUsd > maxCostUsd)
    ) {
      triggers.push({
        kind: 'budget.exceeded',
        detail: `Run used ${usage.totalTokens} tokens / $${usage.costUsd.toFixed(4)} (limits: ${maxTotalTokens ?? '-'} tokens / $${maxCostUsd ?? '-'})`,
      });
    }
  }

  if (options.stalled) {
    triggers.push({
      kind: 'run.stalled',
      detail: 'The run is RUNNING but no node is runnable or making progress',
    });
  }

  return triggers.filter((t) => enabled.has(t.kind));
}
