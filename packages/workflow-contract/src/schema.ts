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
  /** Optional max cumulative bytes read via pagination in one attempt. Omit for no limit. */
  stageReadQuotaBytes: z.number().int().positive().optional(),
  /** Optional native session input token budget warning/limit. */
  sessionTokenBudget: z.number().int().positive().optional(),
});
export type ContextBudgetConfig = z.infer<typeof ContextBudgetConfigSchema>;

/**
 * Assessment verdict produced by verification scripts or independent reviewer agents.
 */
export const AssessmentVerdictSchema = z.enum(['PASS', 'NEEDS_FIX', 'FAIL', 'BLOCKED']);
export type AssessmentVerdict = z.infer<typeof AssessmentVerdictSchema>;

type ConditionValue = string | number | boolean | null;

/** Deterministic predicate on control edges or loop continuation conditions. */
export type EdgeCondition =
  | { kind: 'always' }
  | { kind: 'verdict_is'; verdict: AssessmentVerdict; sourceNodeId?: string }
  | { kind: 'verdict_in'; verdicts: AssessmentVerdict[]; sourceNodeId?: string }
  | { kind: 'port_equals'; port: string; value: ConditionValue; sourceNodeId?: string }
  | { kind: 'port_truthy'; port: string; sourceNodeId?: string }
  | { kind: 'port_compare'; port: string; op: '==' | '!=' | '>' | '>=' | '<' | '<='; value: ConditionValue; measure?: 'value' | 'length'; sourceNodeId?: string }
  | { kind: 'all'; conditions: EdgeCondition[] }
  | { kind: 'any'; conditions: EdgeCondition[] }
  | { kind: 'otherwise' };

export const EdgeConditionSchema: z.ZodType<EdgeCondition> = z.lazy(() => z.discriminatedUnion('kind', [
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
  /**
   * Compares an output with a value: numbers (or, with `measure: 'length'`, the length of a list
   * or text) by size, anything with `==` / `!=`. Ordering a non-number is false.
   */
  z.object({
    kind: z.literal('port_compare'),
    port: z.string().min(1),
    op: z.enum(['==', '!=', '>', '>=', '<', '<=']),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    measure: z.enum(['value', 'length']).optional(),
    sourceNodeId: z.string().optional(),
  }),
  /** Every condition holds (each reads its own `sourceNodeId`, else the edge's step). */
  z.object({
    kind: z.literal('all'),
    conditions: z.array(EdgeConditionSchema).min(1),
  }),
  /** At least one condition holds. */
  z.object({
    kind: z.literal('any'),
    conditions: z.array(EdgeConditionSchema).min(1),
  }),
  /** Taken when none of the other conditional edges leaving the same node is (the "else" branch). */
  z.object({
    kind: z.literal('otherwise'),
  }),
]));
/** A condition that reads one step's verdict or output (everything but always/otherwise/all/any). */
export type LeafEdgeCondition = Exclude<EdgeCondition, { kind: 'always' | 'otherwise' | 'all' | 'any' }>;

/**
 * The step a condition reads, when it names one (`always` / `otherwise` read none; for `all` /
 * `any`, the first condition that names one).
 */
export function edgeConditionSource(condition: EdgeCondition | undefined): string | undefined {
  return edgeConditionSources(condition)[0];
}

/** Every step a condition names, compound conditions included, in order. */
export function edgeConditionSources(condition: EdgeCondition | undefined): string[] {
  if (!condition) return [];
  if (condition.kind === 'all' || condition.kind === 'any') return [...new Set(condition.conditions.flatMap(edgeConditionSources))];
  return 'sourceNodeId' in condition && condition.sourceNodeId ? [condition.sourceNodeId] : [];
}

/** The same condition with `sourceNodeId` filled in wherever it reads the step it belongs to. */
export function withConditionSource(condition: EdgeCondition, sourceNodeId: string): EdgeCondition {
  if (condition.kind === 'all' || condition.kind === 'any') {
    return { ...condition, conditions: condition.conditions.map((c) => withConditionSource(c, sourceNodeId)) };
  }
  if (condition.kind === 'always' || condition.kind === 'otherwise') return condition;
  return condition.sourceNodeId ? condition : { ...condition, sourceNodeId };
}

export const LoopExhaustedPolicySchema = z.enum(['fail', 'gate', 'pass_with_findings']);
export type LoopExhaustedPolicy = z.infer<typeof LoopExhaustedPolicySchema>;

/**
 * Makes a control edge a loop's way back: it leaves the step whose result decides and returns
 * to an earlier step, and every step on the way round repeats while its `when` holds.
 */
export const LoopBackSchema = z.object({
  /** Rounds at most, the first one included. */
  maxRounds: z.number().int().min(1).max(50).default(3),
  /** When the last round still asks for another: fail, ask a human, or carry on with the findings. */
  onExhausted: LoopExhaustedPolicySchema.default('fail'),
});
export type LoopBack = z.infer<typeof LoopBackSchema>;

/**
 * Control Edge: defines execution order and conditional branching.
 */
export const ControlEdgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  when: EdgeConditionSchema.optional(),
  /** Set on the edge that closes a loop (from the deciding step back to an earlier step). */
  loop: LoopBackSchema.optional(),
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
/** Per-item execution. Port declarations describe ONE invocation; the selected input
 * and every output become arrays at the graph boundary. Omit to execute once. */
export const NodeParallelSchema = z.object({
  itemsPort: z.string().min(1),
  maxConcurrency: z.number().int().positive().default(4),
  failurePolicy: z.enum(['fail_fast', 'settle_all']).default('settle_all'),
});
export type NodeParallel = z.infer<typeof NodeParallelSchema>;

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
  parallel: NodeParallelSchema.optional(),
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
  parallel: NodeParallelSchema.optional(),
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
  onExhausted: LoopExhaustedPolicy;
  bodyGraph: WorkflowGraph;
  /**
   * Values a round hands to the next: before round 2+, the round's `$input.toPort` is set to
   * the previous round's `fromNodeId.fromPort` (absent in round 1).
   */
  carry?: LoopCarry[];
  /**
   * Set when the compiler made this loop: from a way back (`lowerCycles`),
   * or from a sub-flow step, which runs its workflow once (`embedSubflows`).
   */
  origin?: { deciderId: string; backEdgeId: string } | { subflowOf: string; digest: string };
}

/** The workflow a sub-flow step runs, frozen when the run starts (see `resolveSubflows`). */
export interface SubflowSnapshot {
  workflowId: string;
  digest: string;
  name: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  graph: WorkflowGraph;
}

/**
 * 4. Sub-flow Node: runs another saved workflow as one step. Its inputs and outputs are that
 * workflow's; hosts embed the workflow (`snapshot`) when a run starts, so the run keeps
 * exactly what it executed even if the workflow changes later.
 */
export interface SubflowNode {
  id: string;
  name: string;
  description?: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  writeScopes: string[];
  maxTechnicalRetries: number;
  workspace?: string;
  isolation?: WorkspaceIsolationMode;
  enforceWriteScopes?: boolean;
  kind: 'subflow';
  parallel?: NodeParallel;
  /** Saved workflow to run; unset while the step is being drawn. */
  workflowId?: string;
  snapshot?: SubflowSnapshot;
}

export interface LoopCarry {
  fromNodeId: string;
  fromPort: string;
  toPort: string;
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
  /** Compiler-generated per-item execution of an ordinary node. */
  origin?: { nodeKind: 'agent' | 'script' | 'subflow' };
}

export type WorkflowNode = AgentNode | ScriptNode | GateNode | LoopNode | ParallelNode | SubflowNode;

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
    onExhausted: LoopExhaustedPolicySchema.default('fail'),
    bodyGraph: WorkflowGraphSchema,
    carry: z.array(z.object({ fromNodeId: z.string().min(1), fromPort: z.string().min(1), toPort: z.string().min(1) })).optional(),
    origin: z
      .union([
        z.object({ deciderId: z.string().min(1), backEdgeId: z.string().min(1) }),
        z.object({ subflowOf: z.string().min(1), digest: z.string().min(1) }),
      ])
      .optional(),
  })
);

export const SubflowNodeSchema: z.ZodType<SubflowNode> = z.lazy(() =>
  z.object({
    ...BaseNodeFields,
    kind: z.literal('subflow'),
    parallel: NodeParallelSchema.optional(),
    workflowId: z.string().min(1).optional(),
    snapshot: z
      .object({
        workflowId: z.string().min(1),
        digest: z.string().min(1),
        name: z.string(),
        inputs: z.array(PortDefinitionSchema),
        outputs: z.array(PortDefinitionSchema),
        graph: WorkflowGraphSchema,
      })
      .optional(),
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
    origin: z.object({ nodeKind: z.enum(['agent', 'script', 'subflow']) }).optional(),
  })
);

export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.union([
    AgentNodeSchema,
    ScriptNodeSchema,
    GateNodeSchema,
    LoopNodeSchema,
    ParallelNodeSchema,
    SubflowNodeSchema,
  ])
);

/**
 * A named placeholder for a directory the workflow works in. Nodes refer to slots by name;
 * each run binds every slot to a concrete workspace, so one workflow can run on any project.
 */
/**
 * A command that checks merged code, such as `pnpm typecheck`. Edits that merge cleanly line
 * by line can still break each other (one step renames what another starts calling).
 */
export const WorkspaceMergeCheckSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(300_000),
});
export type WorkspaceMergeCheck = z.infer<typeof WorkspaceMergeCheckSchema>;

export const WorkspaceSlotSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][\w-]*$/, 'Slot names use letters, digits, "_" and "-"'),
  description: z.string().optional(),
  required: z.boolean().default(true),
  /**
   * Runs, in the step's copy, when a step's changes were merged with changes other steps made
   * meanwhile; they land only if it passes, and a failure counts as a merge conflict.
   */
  mergeCheck: WorkspaceMergeCheckSchema.optional(),
});
export type WorkspaceSlot = z.infer<typeof WorkspaceSlotSchema>;
export type WorkspaceSlotInput = z.input<typeof WorkspaceSlotSchema>;

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
