import {
  CHIEF_COMMAND_LEVEL,
  CHIEF_LEVEL_RANK,
  type ChiefCommand,
  type ChiefDecision,
  type ChiefPolicy,
  type CompiledWorkflowPlan,
} from '@universal-agent/workflow-contract';
import type { AgentAdapter, PinnedAgent, WorkflowRunState } from '../ports';
import type { ChiefTrigger } from './triggers';

export interface ChiefReviewInput {
  readonly plan: CompiledWorkflowPlan;
  readonly state: WorkflowRunState;
  readonly policy: ChiefPolicy;
  readonly trigger: ChiefTrigger;
  /** The chief's own agent profile, when the policy names one. */
  readonly chiefAgent?: PinnedAgent;
  /** Adapter selected for `chiefAgent` (or the default executor). */
  readonly adapter: AgentAdapter;
  /** Command kinds permitted by `policy.maxLevel`. */
  readonly allowedCommands: readonly ChiefCommand['kind'][];
  readonly signal?: AbortSignal;
}

/**
 * Decides how to react to a trigger. Implementations may be deterministic rules (tests,
 * conservative hosts) or an LLM agent (`AgentChiefSupervisor` in
 * `@universal-agent/workflow-agents`). The runtime validates and applies the returned
 * commands against the policy; a supervisor never mutates run state itself.
 */
export interface ChiefSupervisor {
  review(input: ChiefReviewInput): Promise<ChiefDecision>;
}

export function allowedChiefCommands(policy: ChiefPolicy): ChiefCommand['kind'][] {
  return (Object.keys(CHIEF_COMMAND_LEVEL) as ChiefCommand['kind'][]).filter(
    (kind) => CHIEF_LEVEL_RANK[CHIEF_COMMAND_LEVEL[kind]] <= CHIEF_LEVEL_RANK[policy.maxLevel]
  );
}
