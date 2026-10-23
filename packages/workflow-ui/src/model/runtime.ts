import type { AgentRuntimeBinding } from '@universal-agent/workflow-contract';

/** Per-step choice of client, model and effort; unset fields fall back to the agent's. */
export interface RuntimeChoice {
  agentType?: string;
  modelId?: string;
  effort?: string;
}

/** Effective client/model/effort: the step's overrides over the agent's runtime. */
export function effectiveRuntime(choice: RuntimeChoice, agentRuntime: AgentRuntimeBinding | undefined): RuntimeChoice {
  const sameClient = !choice.agentType || choice.agentType === agentRuntime?.agentType;
  const agentType = choice.agentType ?? agentRuntime?.agentType;
  const modelId = choice.modelId ?? (sameClient ? agentRuntime?.modelId : undefined);
  const effort = choice.effort ?? agentRuntime?.effort;
  return { ...(agentType ? { agentType } : {}), ...(modelId ? { modelId } : {}), ...(effort ? { effort } : {}) };
}

/** `claude · sonnet · high`, or undefined when nothing is known. */
export function describeRuntime(runtime: RuntimeChoice): string | undefined {
  const parts = [runtime.agentType, runtime.modelId, runtime.effort].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
