import {
  type AgentNode,
  type AgentProfile,
  type AgentProfileInput,
  AgentProfileSchema,
  type CompiledWorkflowPlan,
  computeAgentDigest,
  formatAgentRef,
  parseAgentRef,
} from '@universal-agent/workflow-contract';
import type { AgentRegistry, ChiefRunState, PinnedAgent, WorkflowRunState } from '../ports';
import { resolveContainerChain } from '../scheduler/graph-reducer';

export class AgentNotFoundError extends Error {
  readonly agentRef: string;

  constructor(agentRef: string, reason = 'is not registered') {
    super(`Agent "${agentRef}" ${reason}`);
    this.name = 'AgentNotFoundError';
    this.agentRef = agentRef;
  }
}

/**
 * Picks the agent for an AgentNode in `scopeKey`, most specific first:
 * a chief `swap_agent` override, the node's own `agentRef`, then the nearest
 * enclosing container's `defaultAgentRef`. Undefined means a legacy role-bound node.
 */
export function resolveEffectiveAgentRef(
  plan: CompiledWorkflowPlan,
  scopeKey: string,
  node: AgentNode,
  chief: ChiefRunState
): string | undefined {
  const override = [...chief.agentOverrides]
    .reverse()
    .find((o) => o.nodeId === node.id && (o.scopeKey === undefined || o.scopeKey === scopeKey));
  if (override) return override.agentRef;
  if (node.agentRef) return node.agentRef;
  const chain = resolveContainerChain(plan, scopeKey);
  for (let i = chain.length - 1; i >= 0; i--) {
    const fallback = chain[i]!.defaultAgentRef;
    if (fallback) return fallback;
  }
  return undefined;
}

/** Reuses the run's pinned profile for `ref`, resolving and pinning it on first use. */
export async function pinAgent(
  registry: AgentRegistry | undefined,
  state: Pick<WorkflowRunState, 'pinnedAgents'>,
  ref: string
): Promise<PinnedAgent> {
  const existing = state.pinnedAgents[ref];
  if (existing) return existing;
  if (!parseAgentRef(ref)) {
    throw new AgentNotFoundError(ref, 'is not a valid agent ref');
  }
  if (!registry) {
    throw new AgentNotFoundError(ref, 'cannot be resolved: runtime has no agentRegistry');
  }
  const profile = await registry.resolve(ref);
  if (!profile) {
    throw new AgentNotFoundError(ref);
  }
  return {
    ref,
    agentId: profile.id,
    version: profile.version,
    digest: computeAgentDigest(profile),
    profile,
  };
}

/** Process-local registry for tests and embedded hosts; versions are immutable once registered. */
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly versions = new Map<string, AgentProfile[]>();

  constructor(profiles: readonly AgentProfileInput[] = []) {
    for (const profile of profiles) this.register(profile);
  }

  register(input: AgentProfileInput): AgentProfile {
    const profile = AgentProfileSchema.parse(input);
    const list = this.versions.get(profile.id) ?? [];
    const existing = list.find((p) => p.version === profile.version);
    if (existing) {
      if (computeAgentDigest(existing) !== computeAgentDigest(profile)) {
        throw new Error(
          `Agent "${formatAgentRef(profile.id, profile.version)}" is already registered with different content; bump its version`
        );
      }
      return existing;
    }
    list.push(profile);
    this.versions.set(profile.id, list);
    return profile;
  }

  async resolve(ref: string): Promise<AgentProfile | null> {
    const parsed = parseAgentRef(ref);
    if (!parsed) return null;
    const list = this.versions.get(parsed.agentId) ?? [];
    if (parsed.version === undefined) return list[list.length - 1] ?? null;
    return list.find((p) => p.version === parsed.version) ?? null;
  }
}
