import { z } from 'zod';
import { type AgentProfile, AgentProfileSchema, type AgentRuntimeBinding } from './agent';

/**
 * Ordered intervention levels for the chief agent, least to most invasive. A policy's
 * `maxLevel` caps which commands the runtime will apply; everything above it is rejected
 * and logged. Escalating (pausing to ask a human) ranks below operating on the run.
 */
export const ChiefLevelSchema = z.enum(['observe', 'advise', 'escalate', 'operate']);
export type ChiefLevel = z.infer<typeof ChiefLevelSchema>;

export const CHIEF_LEVEL_RANK: Readonly<Record<ChiefLevel, number>> = {
  observe: 0,
  advise: 1,
  escalate: 2,
  operate: 3,
};

export const ChiefTriggerKindSchema = z.enum([
  /** A node ended FAILED after exhausting technical retries. */
  'node.failed',
  /** A loop round finished and the loop is about to start another round. */
  'loop.round_needs_fix',
  /** An agent (not a GateNode) asked a question mid-task. */
  'wait.requested',
  /** The run is RUNNING but no node can make progress. */
  'run.stalled',
  /** Token or cost totals crossed the policy budget. */
  'budget.exceeded',
  /** A human answered the chief's `escalate` question. */
  'escalation.resolved',
  /** A human wrote to the chief (always answered, whatever `triggers` lists). */
  'user.message',
]);
export type ChiefTriggerKind = z.infer<typeof ChiefTriggerKindSchema>;

export const ChiefPolicySchema = z.object({
  /** Agent that plays the chief; hosts resolve it through their agent registry. */
  agentRef: z.string().min(1).optional(),
  maxLevel: ChiefLevelSchema.default('operate'),
  triggers: z.array(ChiefTriggerKindSchema).default([...ChiefTriggerKindSchema.options]),
  maxInterventionsPerRun: z.number().int().min(0).default(20),
  /** Upper bound on extra rounds the chief may grant a single loop. */
  maxLoopRoundExtension: z.number().int().min(0).max(10).default(2),
  budget: z
    .object({
      maxTotalTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
    })
    .optional(),
});
export type ChiefPolicy = z.infer<typeof ChiefPolicySchema>;
export type ChiefPolicyInput = z.input<typeof ChiefPolicySchema>;

/** Ref the built-in chief is pinned under in runs whose policy names no agent. */
export const DEFAULT_CHIEF_AGENT_REF = 'default-chief@builtin';

/**
 * The chief of runs whose policy names no agent: a read-only supervisor on `runtime`, the
 * engine the workflow's own agents run on (so it needs no setup of its own).
 */
export function defaultChiefProfile(runtime: AgentRuntimeBinding): AgentProfile {
  const [id, version] = DEFAULT_CHIEF_AGENT_REF.split('@') as [string, string];
  return AgentProfileSchema.parse({
    id,
    version,
    name: 'Default chief',
    charter:
      'Supervises workflow runs: works out why a step failed or stalled from what the run produced, and keeps the run moving with the smallest intervention that fits.',
    instructions: [
      'Never edit files or run anything that changes the workspace; read what steps produced with the ua-workflow tools.',
      'Prefer guidance and a retry of the failing step before rerunning earlier steps or swapping agents.',
      'Give the exact scopeKey in every command that takes one.',
      'Never change what counts as done: acceptance criteria and verdicts stay as they are.',
      'Escalate to a human when the fix needs a decision only they can make.',
    ],
    runtime: {
      adapter: runtime.adapter,
      ...(runtime.agentType ? { agentType: runtime.agentType } : {}),
      ...(runtime.modelId ? { modelId: runtime.modelId } : {}),
      ...(runtime.effort ? { effort: runtime.effort } : {}),
    },
  });
}

/**
 * Everything the chief may do. By design there is no command to edit acceptance criteria,
 * override verdicts, answer GateNodes, or change write scopes: the chief controls *how*
 * work proceeds, never *what counts as done*.
 */
export const ChiefCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('report'), summary: z.string().min(1) }),
  z.object({
    kind: z.literal('inject_guidance'),
    nodeId: z.string().min(1),
    /** Limit to one scope instance; omit to apply wherever `nodeId` runs (e.g. every loop round). */
    scopeKey: z.string().min(1).optional(),
    text: z.string().min(1),
  }),
  z.object({ kind: z.literal('retry_node'), scopeKey: z.string().min(1), nodeId: z.string().min(1) }),
  z.object({
    kind: z.literal('rerun_from_node'),
    scopeKey: z.string().min(1),
    nodeId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('swap_agent'),
    nodeId: z.string().min(1),
    scopeKey: z.string().min(1).optional(),
    agentRef: z.string().min(1),
  }),
  z.object({
    kind: z.literal('answer_wait'),
    requestId: z.string().min(1),
    answer: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
  z.object({
    kind: z.literal('extend_loop'),
    scopeKey: z.string().min(1),
    nodeId: z.string().min(1),
    extraRounds: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('escalate'),
    prompt: z.string().min(1),
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
      .optional(),
  }),
]);
export type ChiefCommand = z.infer<typeof ChiefCommandSchema>;

export const CHIEF_COMMAND_LEVEL: Readonly<Record<ChiefCommand['kind'], ChiefLevel>> = {
  report: 'observe',
  inject_guidance: 'advise',
  retry_node: 'operate',
  rerun_from_node: 'operate',
  swap_agent: 'operate',
  answer_wait: 'operate',
  extend_loop: 'operate',
  escalate: 'escalate',
};

export const ChiefDecisionSchema = z.object({
  rationale: z.string().default(''),
  /** What the chief tells the human, in plain language (always set when answering a message). */
  reply: z.string().optional(),
  commands: z.array(ChiefCommandSchema).default([]),
});
export type ChiefDecision = z.infer<typeof ChiefDecisionSchema>;
