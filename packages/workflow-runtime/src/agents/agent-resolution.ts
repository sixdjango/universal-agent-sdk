import {
  type AgentNode,
  type AgentProfile,
  type AgentProfileInput,
  AgentProfileSchema,
  type AgentRuntimeBinding,
  type ChiefPolicy,
  type CompiledWorkflowPlan,
  computeAgentDigest,
  DEFAULT_CHIEF_AGENT_REF,
  defaultChiefProfile,
  formatAgentRef,
  parseAgentRef,
  type WorkflowGraph,
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

/**
 * The engine most of a workflow's agent steps run on (the first one on a tie). Undefined when
 * no step names one, e.g. a workflow of scripts or of agents bound by role only.
 */
export async function flowAgentRuntime(
  graph: WorkflowGraph,
  resolve: (ref: string) => Promise<PinnedAgent | undefined>
): Promise<AgentRuntimeBinding | undefined> {
  const tally = new Map<string, { runtime: AgentRuntimeBinding; count: number }>();
  const visit = async (scope: WorkflowGraph, inheritedRef: string | undefined): Promise<void> => {
    for (const node of scope.nodes) {
      if (node.kind === 'loop' || node.kind === 'parallel') {
        await visit(node.kind === 'loop' ? node.bodyGraph : node.itemGraph, node.defaultAgentRef ?? inheritedRef);
        continue;
      }
      if (node.kind !== 'agent') continue;
      const ref = node.agentRef ?? inheritedRef;
      const runtime: AgentRuntimeBinding | undefined = node.agentType
        ? { adapter: 'acp', agentType: node.agentType, ...(node.modelId ? { modelId: node.modelId } : {}) }
        : ref
          ? (await resolve(ref))?.profile.runtime
          : undefined;
      if (!runtime?.agentType) continue;
      const key = `${runtime.adapter}\0${runtime.agentType}\0${runtime.modelId ?? ''}`;
      const entry = tally.get(key) ?? { runtime, count: 0 };
      entry.count += 1;
      tally.set(key, entry);
    }
  };
  await visit(graph, undefined);
  let best: { runtime: AgentRuntimeBinding; count: number } | undefined;
  for (const entry of tally.values()) if (!best || entry.count > best.count) best = entry;
  return best?.runtime;
}

/**
 * The chief's agent for a run: the policy's, else the built-in default chief on the engine
 * the workflow's agents use. Once pinned it stays the same for the whole run. Undefined when
 * there is nothing to follow; the host's default agent then plays the chief.
 */
export async function resolveChiefAgent(
  registry: AgentRegistry | undefined,
  state: Pick<WorkflowRunState, 'pinnedAgents' | 'definition'>,
  policy: ChiefPolicy
): Promise<PinnedAgent | undefined> {
  if (policy.agentRef) return await pinAgent(registry, state, policy.agentRef);
  const pinned = state.pinnedAgents[DEFAULT_CHIEF_AGENT_REF];
  if (pinned) return pinned;
  const runtime = await flowAgentRuntime(state.definition.graph, (ref) => pinAgent(registry, state, ref).catch(() => undefined));
  if (!runtime) return undefined;
  const profile = defaultChiefProfile(runtime);
  return { ref: DEFAULT_CHIEF_AGENT_REF, agentId: profile.id, version: profile.version, digest: computeAgentDigest(profile), profile };
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
