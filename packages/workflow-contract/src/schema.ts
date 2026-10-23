import { z } from 'zod';
import { ChiefPolicySchema } from './chief';

/**
 * Port data type classification for typed data edges and context bundling.
 */
export const PortValueTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'json',
  'artifact',
  'assessment',
  'array',
]);
export type PortValueType = z.infer<typeof PortValueTypeSchema>;

export const PortDefinitionSchema = z.object({
  name: z.string().min(1),
  type: PortValueTypeSchema.default('json'),
  required: z.boolean().default(true),
  description: z.string().optional(),
  defaultValue: z.unknown().optional(),
});
export type PortDefinition = z.infer<typeof PortDefinitionSchema>;

/**
 * Context budget configuration per node.
 */
export const ContextBudgetConfigSchema = z.object({
  /** Max bytes for initial inline context bundle (default 32 KiB). */
  initialBundleBytes: z.number().int().positive().default(32 * 1024),
  /** Max bytes per paginated artifact read (default 8 KiB). */
  pageReadBytes: z.number().int().positive().default(8 * 1024),
  /** Max cumulative bytes read via on-demand pagination in a single attempt (default 128 KiB). */
  stageReadQuotaBytes: z.number().int().positive().default(128 * 1024),
  /** Optional native session input token budget warning/limit. */
  sessionTokenBudget: z.number().int().positive().optional(),
});
export type ContextBudgetConfig = z.infer<typeof ContextBudgetConfigSchema>;

/**
 * Assessment verdict produced by verification scripts or independent reviewer agents.
 */
export const AssessmentVerdictSchema = z.enum(['PASS', 'NEEDS_FIX', 'FAIL', 'BLOCKED']);
export type AssessmentVerdict = z.infer<typeof AssessmentVerdictSchema>;

/**
 * Deterministic predicate on control edges or loop continuation conditions.
 */
export const EdgeConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('always'),
  }),
  z.object({
    kind: z.literal('verdict_is'),
    verdict: AssessmentVerdictSchema,
    sourceNodeId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('verdict_in'),
    verdicts: z.array(AssessmentVerdictSchema).min(1),
    sourceNodeId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('port_equals'),
    port: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    sourceNodeId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('port_truthy'),
    port: z.string().min(1),
    sourceNodeId: z.string().optional(),
  }),
]);
export type EdgeCondition = z.infer<typeof EdgeConditionSchema>;

/**
 * Control Edge: defines execution order and conditional branching.
 */
export const ControlEdgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  when: EdgeConditionSchema.optional(),
});
export type ControlEdge = z.infer<typeof ControlEdgeSchema>;

/**
 * Data Edge: explicitly binds an upstream node's output port (or workflow input)
 * to a downstream node's input port (or workflow output).
 * Use `fromNodeId: '$input'` for workflow-level inputs and `toNodeId: '$output'` for workflow-level outputs.
 */
export const DataDeliveryModeSchema = z.enum(['auto', 'inline', 'artifact_ref']);
export type DataDeliveryMode = z.infer<typeof DataDeliveryModeSchema>;

export const DataEdgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  fromPort: z.string().min(1),
  toNodeId: z.string().min(1),
  toPort: z.string().min(1),
  required: z.boolean().default(true),
  delivery: DataDeliveryModeSchema.default('auto'),
});
export type DataEdge = z.infer<typeof DataEdgeSchema>;

export const WorkspaceIsolationModeSchema = z.enum(['auto', 'shared', 'worktree']);
export type WorkspaceIsolationMode = z.infer<typeof WorkspaceIsolationModeSchema>;

/**
 * Base properties shared by all workflow nodes.
 */
const BaseNodeFields = {
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.array(PortDefinitionSchema).default([]),
  outputs: z.array(PortDefinitionSchema).default([]),
  writeScopes: z.array(z.string()).default([]),
  maxTechnicalRetries: z.number().int().min(0).default(0),
  /**
   * Workspace slot this node works in (see `WorkflowDefinition.workspaces`). Absent: the
   * enclosing container's slot, then the workflow's default slot.
   */
  workspace: z.string().min(1).optional(),
  /**
   * Where a writing step works: `shared` in the workspace itself, `worktree` in its own copy
   * merged back afterwards, `auto` (default) a copy only when other writers may run at the
   * same time. Containers pass it on to their inner steps.
   */
  isolation: WorkspaceIsolationModeSchema.optional(),
  /** Fail the step when it changed files outside its `writeScopes` (default: only report them). */
  enforceWriteScopes: z.boolean().optional(),
};

/**
 * 1. Agent Node: executes a task via `@universal-agent/client`.
 */
export const AgentNodeSchema = z.object({
  ...BaseNodeFields,
  kind: z.literal('agent'),
  /**
   * Agent profile that performs this node (`"<agentId>"` or `"<agentId>@<version>"`).
   * Falls back to the nearest container's `defaultAgentRef`, then to `role`/`agentType`.
   */
  agentRef: z.string().min(1).optional(),
  /** Role alias (e.g. 'author', 'reviewer') or concrete agentType (e.g. 'claude', 'codex', 'gemini'). */
  role: z.string().min(1),
  /** Per-step overrides of the agent's runtime: client (engine), model and effort. */
  agentType: z.string().optional(),
  modelId: z.string().optional(),
  modeId: z.string().optional(),
  effort: z.string().min(1).optional(),
  /** Core task goal (100% preserved in ContextBundle). */
  goal: z.string().min(1),
  /** Explicit acceptance criteria (100% preserved in ContextBundle, never truncated). */
  acceptanceCriteria: z.array(z.string()).default([]),
  /** Immutable constraints that must not be violated. */
  constraints: z.array(z.string()).default([]),
  /** Prompt instructions or template. */
  promptTemplate: z.string().optional(),
  /** Whether this node acts as an independent reviewer producing an Assessment. */
  producesAssessment: z.boolean().default(false),
  contextBudget: ContextBudgetConfigSchema.optional(),
  /** Other workspace slots the agent may read (but not write) for reference. */
  readWorkspaces: z.array(z.string().min(1)).default([]),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

/**
 * 2. Script Node: deterministic shell/command execution (e.g. build, test, lint).
 */
export const ScriptNodeSchema = z.object({
  ...BaseNodeFields,
  kind: z.literal('script'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Working directory relative to the node's workspace root. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().default(60_000),
  /** If true, exitCode === 0 yields Assessment PASS, non-zero yields NEEDS_FIX. */
  producesAssessment: z.boolean().default(true),
});
export type ScriptNode = z.infer<typeof ScriptNodeSchema>;

/**
 * 3. Gate Node: suspends execution waiting for structured human decision or external approval.
 */
export const GateQuestionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type GateQuestionOption = z.infer<typeof GateQuestionOptionSchema>;

export const GateNodeSchema = z.object({
  ...BaseNodeFields,
  kind: z.literal('gate'),
  prompt: z.string().min(1),
  options: z.array(GateQuestionOptionSchema).default([]),
  requiredRole: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type GateNode = z.infer<typeof GateNodeSchema>;

export interface LoopNode {
  id: string;
  name: string;
  description?: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  writeScopes: string[];
  maxTechnicalRetries: number;
  /** Workspace slot inherited by children that do not set their own. */
  workspace?: string;
  /** Isolation mode inherited by children that do not set their own. */
  isolation?: WorkspaceIsolationMode;
  enforceWriteScopes?: boolean;
  kind: 'loop';
  /** Agent used by body AgentNodes that do not set their own `agentRef`. */
  defaultAgentRef?: string;
  maxRounds: number;
  continueWhen: EdgeCondition;
  onExhausted: 'fail' | 'gate' | 'pass_with_findings';
  bodyGraph: WorkflowGraph;
}

export interface ParallelNode {
  id: string;
  name: string;
  description?: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  writeScopes: string[];
  maxTechnicalRetries: number;
  /** Workspace slot inherited by children that do not set their own. */
  workspace?: string;
  /** Isolation mode inherited by children that do not set their own. */
  isolation?: WorkspaceIsolationMode;
  enforceWriteScopes?: boolean;
  kind: 'parallel';
  /** Agent used by item AgentNodes that do not set their own `agentRef`. */
  defaultAgentRef?: string;
  itemsPort: string;
  maxConcurrency: number;
  failurePolicy: 'fail_fast' | 'settle_all';
  itemGraph: WorkflowGraph;
}

export type WorkflowNode = AgentNode | ScriptNode | GateNode | LoopNode | ParallelNode;

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  controlEdges: ControlEdge[];
  dataEdges: DataEdge[];
}

export const WorkflowGraphSchema: z.ZodType<WorkflowGraph> = z.lazy(() =>
  z.object({
    nodes: z.array(WorkflowNodeSchema),
    controlEdges: z.array(ControlEdgeSchema).default([]),
    dataEdges: z.array(DataEdgeSchema).default([]),
  })
);

export const LoopNodeSchema: z.ZodType<LoopNode> = z.lazy(() =>
  z.object({
    ...BaseNodeFields,
    kind: z.literal('loop'),
    defaultAgentRef: z.string().min(1).optional(),
    maxRounds: z.number().int().min(1).max(50).default(3),
    continueWhen: EdgeConditionSchema,
    onExhausted: z.enum(['fail', 'gate', 'pass_with_findings']).default('fail'),
    bodyGraph: WorkflowGraphSchema,
  })
);

export const ParallelNodeSchema: z.ZodType<ParallelNode> = z.lazy(() =>
  z.object({
    ...BaseNodeFields,
    kind: z.literal('parallel'),
    defaultAgentRef: z.string().min(1).optional(),
    itemsPort: z.string().min(1).default('items'),
    maxConcurrency: z.number().int().min(1).default(4),
    failurePolicy: z.enum(['fail_fast', 'settle_all']).default('settle_all'),
    itemGraph: WorkflowGraphSchema,
  })
);

export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.union([
    AgentNodeSchema,
    ScriptNodeSchema,
    GateNodeSchema,
    LoopNodeSchema,
    ParallelNodeSchema,
  ])
);

/**
 * A named placeholder for a directory the workflow works in. Nodes refer to slots by name;
 * each run binds every slot to a concrete workspace, so one workflow can run on any project.
 */
export const WorkspaceSlotSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][\w-]*$/, 'Slot names use letters, digits, "_" and "-"'),
  description: z.string().optional(),
  required: z.boolean().default(true),
});
export type WorkspaceSlot = z.infer<typeof WorkspaceSlotSchema>;

/** Slot used by workflows that declare none; it binds to the host's working directory. */
export const IMPLICIT_WORKSPACE_SLOT = 'main';

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).default('1.0.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.array(PortDefinitionSchema).default([]),
  outputs: z.array(PortDefinitionSchema).default([]),
  graph: WorkflowGraphSchema,
  /** Workspace slots nodes can work in; empty means the single implicit `main` slot. */
  workspaces: z.array(WorkspaceSlotSchema).default([]),
  /** Slot used by nodes that name none; defaults to the first declared slot. */
  defaultWorkspace: z.string().min(1).optional(),
  /** Optional chief agent supervising the run; absent means no supervision. */
  chief: ChiefPolicySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** Slots a definition can bind: its declared slots, or the implicit `main` slot. */
export function listWorkspaceSlots(definition: Pick<WorkflowDefinition, 'workspaces'>): WorkspaceSlot[] {
  return definition.workspaces.length > 0
    ? definition.workspaces
    : [{ name: IMPLICIT_WORKSPACE_SLOT, required: false }];
}

/** Slot used by nodes (and containers) that do not name one. */
export function defaultWorkspaceSlot(
  definition: Pick<WorkflowDefinition, 'workspaces' | 'defaultWorkspace'>
): string {
  return definition.defaultWorkspace ?? definition.workspaces[0]?.name ?? IMPLICIT_WORKSPACE_SLOT;
}
