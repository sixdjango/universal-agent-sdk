import { z } from 'zod';
import { canonicalizeJsonValue, sha256Hex } from './canonical';

/**
 * Which execution adapter runs an agent, plus adapter-specific engine selection.
 * `adapter: 'acp'` routes through `@universal-agent/client`; hosts may register others.
 */
export const AgentRuntimeBindingSchema = z.object({
  adapter: z.string().min(1).default('acp'),
  /** Engine for the adapter, e.g. 'claude', 'codex', 'gemini' for the ACP adapter. */
  agentType: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
  /**
   * Reasoning effort level (e.g. 'low' | 'medium' | 'high'). Engines name the setting
   * differently; executors apply it to the session's thought-level option.
   */
  effort: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type AgentRuntimeBinding = z.infer<typeof AgentRuntimeBindingSchema>;

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * A durable agent identity that workflow nodes delegate to. Profiles are immutable per
 * `version`; a run pins the exact profile digest it used so reruns stay reproducible.
 */
export const AgentProfileSchema = z.object({
  id: z.string().regex(AGENT_ID_PATTERN, 'Agent id must be alphanumeric with "_", ".", "-"'),
  version: z.string().min(1).regex(/^[^@\s]+$/).default('1'),
  name: z.string().min(1),
  /** What this agent is responsible for; rendered ahead of every task it receives. */
  charter: z.string().min(1),
  /** Standing working rules, kept verbatim in every prompt. */
  instructions: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  runtime: AgentRuntimeBindingSchema.default({ adapter: 'acp' }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type AgentProfileInput = z.input<typeof AgentProfileSchema>;

/** `"<agentId>"` (latest version) or `"<agentId>@<version>"`. */
export interface ParsedAgentRef {
  readonly agentId: string;
  readonly version?: string;
}

export function parseAgentRef(ref: string): ParsedAgentRef | null {
  const at = ref.indexOf('@');
  const agentId = at === -1 ? ref : ref.slice(0, at);
  const version = at === -1 ? undefined : ref.slice(at + 1);
  if (!AGENT_ID_PATTERN.test(agentId)) return null;
  if (version !== undefined && !/^[^@\s]+$/.test(version)) return null;
  return version === undefined ? { agentId } : { agentId, version };
}

export function formatAgentRef(agentId: string, version?: string): string {
  return version === undefined ? agentId : `${agentId}@${version}`;
}

/** Deterministic SHA-256 over the canonical JSON of a parsed profile. */
export function computeAgentDigest(profile: AgentProfile): string {
  return `sha256:${sha256Hex(canonicalizeJsonValue(profile))}`;
}
