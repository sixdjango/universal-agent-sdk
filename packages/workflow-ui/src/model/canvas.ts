import {
  analyzeLoopBacks,
  type CompiledWorkflowPlan,
  compileWorkflowDefinition,
  nodeParallel,
  nodeBoundaryPorts,
  type AgentRuntimeBinding,
  type EdgeCondition,
  subflowWorkflowId,
  type LiveAttemptProgress,
  type WaitRequest,
  type WorkflowDefinition,
  type WorkflowValidationIssue,
  type WorkflowGraph,
  type WorkflowNode,
} from '@universal-agent/workflow-contract';
import {
  computeScopeReadyNodeIds,
  type GraphScopeState,
  type NodeAttemptRecord,
  type NodeRuntimeState,
  type WorkflowRunState,
} from '@universal-agent/workflow-runtime';
import { layeredLayout } from './layout';
import { cycleLoops, type CycleLoopView, drawsCycles, foldCycleRounds } from './cycle-view';
import { conditionText } from './conditions';
import { containerInstanceKeys, describeContainerRule, describeLoop, type LoopSummary } from './loop';
import { describeRuntime, effectiveRuntime, type RuntimeChoice } from './runtime';

export { containerInstanceKeys };
import { inheritedWorkspaceSlot, showsWorkspaces } from './workspaces';
import {
  compilerScopePath,
  containerAt,
  graphAt,
  INPUTS_NODE_ID,
  layoutKey,
  OUTPUTS_NODE_ID,
  containerScopeInputs,
  type ScopePath,
} from './scope';

/** Visual status of a card or row; `idle` means "no run selected". */
export type ViewStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'stale'
  /** The run finished before this node was ever scheduled. */
  | 'unreached';

export type Tone = 'default' | 'muted' | 'danger' | 'warn' | 'ok' | 'active';

export interface CardRow {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly kind: 'agent' | 'input' | 'output' | 'body' | 'decision' | 'command' | 'add' | 'open';
  /** Connection point on this row: inputs take edges on the left, outputs emit on the right. */
  readonly handle?: { readonly type: 'source' | 'target'; readonly id: string };
  readonly tone: Tone;
  readonly status?: ViewStatus;
  /** Artifact behind an output row, viewable on click. */
  readonly artifactId?: string;
}

export interface ActivityItem {
  readonly id: string;
  readonly tag: string;
  readonly text: string;
  readonly tone: Tone;
}

export interface CardData extends Record<string, unknown> {
  readonly nodeId: string;
  /** Container node id when this card represents a fanned-out parallel item. */
  readonly scopeNodeId?: string;
  /** Parallel item index (0-based) when this card represents a fanned-out parallel item. */
  readonly itemIndex?: number;
  readonly kind: WorkflowNode['kind'] | 'inputs' | 'outputs';
  readonly title: string;
  readonly subtitle: string;
  readonly status: ViewStatus;
  readonly verdict?: string;
  readonly rows: readonly CardRow[];
  readonly activityTitle?: string;
  readonly activity: readonly ActivityItem[];
  readonly pendingWait?: WaitRequest;
  readonly agentRef?: string;
  /** The step's own client / model / effort overrides (agent steps). */
  readonly runtimeChoice?: RuntimeChoice;
  /** Column index; cards fade in column by column. */
  readonly order: number;
  readonly rerunnable: boolean;
  /** Design view: ports accept new connections and the card opens the inspector. */
  readonly editable: boolean;
  /** Compiler issues pointing at this node, joined for display. */
  readonly issue?: string;
  /** Its details are open in the side panel. */
  readonly selected?: boolean;
  /** Loop containers: the rule, limits and rounds so far. */
  readonly loop?: LoopSummary;
  /** Sub-flow steps: the saved workflow they run. */
  readonly subflowOf?: string;
  /**
   * Inside a loop body: `decider` is the step whose result starts another round (the loop-back
   * edge leaves from it), `start` is where each round begins (the edge arrives there), `self`
   * is a step that is both (it repeats on its own result).
   */
  readonly loopRole?: 'decider' | 'start' | 'self';
  /** With `loopRole: 'decider'` or `'self'`: what makes it go round again, e.g. `NEEDS_FIX`. */
  readonly loopRepeat?: string;
  /** On a row that runs right to left (a snaking layout): edges come in on the right and leave on the left. */
  readonly reversed?: boolean;
}

export type EdgeTone = 'idle' | 'flowing' | 'delivered' | 'failed' | 'skipped';

export interface FlowEdgeData extends Record<string, unknown> {
  readonly tone: EdgeTone;
  readonly label?: string;
  readonly control: boolean;
  readonly selected?: boolean;
  readonly issue?: string;
  /** Keep the label on screen (branch conditions, values carried round a loop); others show on hover or focus. */
  readonly pinned?: boolean;
  /** Touches the selected card: label shown. */
  readonly focused?: boolean;
  /** A loop's way back: the loop it closes, with its limit and (in a run) its rounds. */
  readonly cycle?: CycleLoopView;
  readonly muted?: boolean;
}

export interface CanvasNode {
  readonly id: string;
  readonly type: 'card';
  readonly position: { x: number; y: number };
  readonly data: CardData;
}

export interface CanvasEdge {
  readonly id: string;
  /** `loop`: the loop-back edge from a loop body's deciding step to the round's start. */
  readonly type: 'flow' | 'loop';
  readonly source: string;
  readonly target: string;
  readonly sourceHandle: string;
  readonly targetHandle: string;
  /** Parameter bindings are only drawn for the selected card (or when they have a problem). */
  readonly hidden?: boolean;
  readonly data: FlowEdgeData;
}

export interface CanvasModel {
  readonly nodes: CanvasNode[];
  readonly edges: CanvasEdge[];
  /** Inside a loop or parallel step: what the container does with these steps. */
  readonly banner?: { readonly kind: 'loop' | 'parallel'; readonly title: string; readonly text: string };
  /** Loops drawn as cycles: the steps they repeat and (in a run) their rounds. */
  readonly loops?: readonly CycleLoopView[];
}

export { INPUTS_NODE_ID, OUTPUTS_NODE_ID };

const COLUMN_WIDTH = 400;
const ROW_HEIGHT = 230;

const planCache = new Map<WorkflowDefinition, CompiledWorkflowPlan>();
export function compilePlan(definition: WorkflowDefinition): CompiledWorkflowPlan {
  let plan = planCache.get(definition);
  if (!plan) {
    plan = compileWorkflowDefinition(definition);
    planCache.set(definition, plan);
  }
  return plan;
}

/** The parts of a compiled scope the canvas needs; also derivable from graphs that don't compile. */
export interface ScopeShape {
  readonly nodesById: Readonly<Record<string, WorkflowNode>>;
  readonly topologicalOrder: readonly string[];
  readonly topologicalLevels: readonly (readonly string[])[];
  readonly childScopes: Readonly<Record<string, ScopeShape>>;
}

/**
 * Level structure for a graph that may be invalid (cycles, dangling edges): Kahn's algorithm
 * over the known control edges, with anything left in a cycle appended as a final level.
 */
function tolerantScope(graph: WorkflowGraph): ScopeShape {
  const nodesById: Record<string, WorkflowNode> = {};
  for (const node of graph.nodes) nodesById[node.id] ??= node;
  const ids = Object.keys(nodesById);
  const inDegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const order = (from: string, to: string) => {
    if (!nodesById[from] || !nodesById[to] || from === to || next.get(from)!.has(to)) return;
    next.get(from)!.add(to);
    inDegree.set(to, inDegree.get(to)! + 1);
  };
  // Ways back and values carried to the next round point backwards; they do not order steps.
  const carried = drawsCycles(graph) ? analyzeLoopBacks(graph).carryEdgeIds : new Set<string>();
  for (const e of graph.controlEdges) if (!e.loop) order(e.fromNodeId, e.toNodeId);
  for (const e of graph.dataEdges) if (!carried.has(e.id)) order(e.fromNodeId, e.toNodeId);

  const levels: string[][] = [];
  let current = ids.filter((id) => inDegree.get(id) === 0);
  const placed = new Set<string>();
  while (current.length > 0) {
    levels.push(current);
    current.forEach((id) => placed.add(id));
    const upcoming: string[] = [];
    for (const id of current) {
      for (const to of next.get(id)!) {
        inDegree.set(to, inDegree.get(to)! - 1);
        if (inDegree.get(to) === 0) upcoming.push(to);
      }
    }
    current = upcoming;
  }
  const leftover = ids.filter((id) => !placed.has(id));
  if (leftover.length > 0) levels.push(leftover);

  const childScopes: Record<string, ScopeShape> = {};
  for (const node of Object.values(nodesById)) {
    if (node.kind === 'loop') childScopes[node.id] = tolerantScope(node.bodyGraph);
    if (node.kind === 'parallel') childScopes[node.id] = tolerantScope(node.itemGraph);
  }
  return { nodesById, topologicalOrder: levels.flat(), topologicalLevels: levels, childScopes };
}

/** Compiled scope at `path` when the definition is valid, otherwise a best-effort shape for editing. */
export function describeScope(definition: WorkflowDefinition, path: ScopePath = []): ScopeShape {
  // Loops drawn as cycles are shown as drawn, not as the LoopNodes they compile into.
  try {
    if (drawsCycles(graphAt(definition, path))) return tolerantScope(graphAt(definition, path));
  } catch {
    // unknown path: fall through
  }
  try {
    let scope: ScopeShape = compilePlan(definition).rootScope;
    for (const id of path) scope = scope.childScopes[id]!;
    if (scope) return scope;
  } catch {
    // fall through to the tolerant shape
  }
  return tolerantScope(graphAt(definition, path));
}

/** Layered default positions: inputs, then one column per topological level, then outputs. */
/** Approximate card size before the browser has measured it (for the first layout). */
const CARD_WIDTH = 290;
/** Before anything is placed by hand, flows wider than this wrap onto further rows (about six steps a row). */
const FIRST_LAYOUT_ROW_WIDTH = 2400;
export function estimateCardHeight(data: CardData): number {
  return (
    64 +
    data.rows.length * 32 +
    (data.loop ? 140 : 0) +
    (data.activity.length > 0 ? 26 + Math.min(4, data.activity.length) * 28 : 0)
  );
}

export function autoLayout(scope: ScopeShape): Record<string, { x: number; y: number }> {
  const columns: string[][] = [[INPUTS_NODE_ID]];
  for (const level of scope.topologicalLevels) {
    columns.push([...level]);
    for (const nodeId of level) {
      const node = scope.nodesById[nodeId];
      const childScope = scope.childScopes[nodeId];
      if (node?.kind === 'loop' && !subflowWorkflowId(node) && childScope && childScope.topologicalLevels.length > 0) {
        for (const childLevel of childScope.topologicalLevels) {
          columns.push(childLevel.map((childId) => `${nodeId}/${childId}`));
        }
      }
    }
  }
  columns.push([OUTPUTS_NODE_ID]);
  const positions: Record<string, { x: number; y: number }> = {};
  columns.forEach((column, col) => {
    column.forEach((nodeId, row) => {
      positions[nodeId] = { x: col * COLUMN_WIDTH, y: (row - (column.length - 1) / 2) * ROW_HEIGHT };
    });
  });
  return positions;
}

function viewStatus(node: NodeRuntimeState | undefined, running: boolean): ViewStatus {
  if (!node) return 'idle';
  if (running) return 'running';
  switch (node.status) {
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'WAITING':
      return 'waiting';
    case 'SKIPPED':
      return 'skipped';
    case 'STALE':
      return 'stale';
    case 'RUNNING':
      return 'running';
    default:
      return 'pending';
  }
}

function statusTone(status: ViewStatus | undefined): Tone {
  switch (status) {
    case 'failed':
      return 'danger';
    case 'waiting':
      return 'warn';
    case 'running':
      return 'active';
    case 'skipped':
    case 'stale':
    case 'unreached':
      return 'muted';
    default:
      return 'default';
  }
}

export function describeCondition(condition: EdgeCondition | undefined): string | undefined {
  if (!condition || condition.kind === 'always') return undefined;
  if (condition.kind === 'otherwise') return 'otherwise';
  return `if ${conditionText(condition)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const firstLine = (text ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.length > 28 ? `${firstLine.slice(0, 27)}…` : firstLine;
}

function coerceParallelItems(rawItems: unknown): unknown[] {
  if (Array.isArray(rawItems)) return rawItems;
  if (typeof rawItems === 'string') {
    const trimmed = rawItems.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
    const parts = trimmed
      .split(/[\r\n,，;；]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : [trimmed];
  }
  if (rawItems && typeof rawItems === 'object') {
    const record = rawItems as Record<string, unknown>;
    for (const key of ['items', 'list', 'topics', 'values', 'data']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  if (rawItems !== undefined && rawItems !== null) {
    return [rawItems];
  }
  return [];
}

/** Latest scope instance of a container (highest loop round / all parallel items). */
function containerScopes(run: WorkflowRunState, prefix: string): GraphScopeState[] {
  // Only its own rounds / items, not the scopes nested inside them.
  const scopes = Object.values(run.scopes).filter(
    (s) =>
      (s.scopeKey.startsWith(`${prefix}:`) || s.scopeKey.startsWith(`${prefix}[`)) &&
      !s.scopeKey.slice(prefix.length + 1).includes('/')
  );
  const rounds = scopes.filter((s) => s.roundIndex !== undefined);
  if (rounds.length > 0) {
    return [rounds.reduce((a, b) => ((a.roundIndex ?? 0) >= (b.roundIndex ?? 0) ? a : b))];
  }
  return scopes;
}

function agentLabel(ref: string | undefined, agentNames: Readonly<Record<string, string>>): string | undefined {
  if (!ref) return undefined;
  const id = ref.split('@')[0]!;
  return agentNames[id] ?? ref;
}

/**
 * Builds the canvas for the root scope of `definition`, overlaying `run` when given.
 * Nodes the scheduler would pick next are shown as running: the runtime executes its
 * ready set immediately, so "ready" is "in progress" from the user's point of view.
 */
export function buildCanvasModel(input: {
  readonly definition: WorkflowDefinition;
  readonly run?: WorkflowRunState | null;
  readonly runActive?: boolean;
  readonly liveProgress?: readonly LiveAttemptProgress[];
  readonly layout?: Readonly<Record<string, { x: number; y: number }>>;
  readonly agentNames?: Readonly<Record<string, string>>;
  /** Each agent's default runtime (client, model, effort), keyed by agent id. */
  readonly agentRuntimes?: Readonly<Record<string, AgentRuntimeBinding>>;
  readonly editable?: boolean;
  readonly issues?: readonly WorkflowValidationIssue[];
  readonly selectedEdgeId?: string | null;
  /** Card whose details (inspector or execution panel) are open. */
  readonly selectedNodeId?: string | null;
  /** Nested graph to show: container ids from the root (`[]` = root graph). */
  readonly path?: ScopePath;
  /** Run scope instance shown for `path` (e.g. `$root/fix_loop:round_1`); defaults to `$root`. */
  readonly scopeKey?: string;
  /** Drawn loops: which round to show, by loop id (default: the latest). */
  readonly loopRounds?: Readonly<Record<string, number>>;
  /** Saved workflows' names by id, for sub-flow steps. */
  readonly workflowNames?: Readonly<Record<string, string>>;
}): CanvasModel {
  const { definition } = input;
  const path = input.path ?? [];
  const baseRun = input.run && input.run.definitionDigest ? input.run : null;
  // Loops drawn as cycles run in per-round scopes; fold the shown round onto the graph as drawn.
  const shownGraph = (() => {
    try {
      return graphAt(definition, path);
    } catch {
      return null;
    }
  })();
  const cycles = shownGraph && drawsCycles(shownGraph) ? shownGraph : null;
  const folded =
    baseRun && cycles ? foldCycleRounds(baseRun, definition, cycles, input.scopeKey ?? '$root', input.loopRounds) : null;
  const run = folded?.run ?? baseRun;
  const cycleViews = folded?.loops ?? (cycles ? cycleLoops(cycles) : []);
  const cycleDeciders = new Map(cycleViews.map((l) => [l.deciderId, l]));
  const cycleHeads = new Set(cycleViews.map((l) => l.headId));
  const backEdgeLabel = (edgeId: string) => {
    const edge = cycles?.controlEdges.find((e) => e.id === edgeId);
    const loop = cycleViews.find((l) => l.backEdgeId === edgeId);
    return `${describeCondition(edge?.when)?.replace(/^if /, '') ?? 'again'} → again · max ${loop?.maxRounds ?? edge?.loop?.maxRounds ?? 3}`;
  };
  // Runs always carry a valid definition; drafts being edited may not compile yet.
  let compiledRunScope = run && !cycles ? compilePlan(run.definition).rootScope : null;
  for (const id of path) compiledRunScope = compiledRunScope?.childScopes[id] ?? null;
  const scope: ScopeShape = compiledRunScope ?? describeScope(definition, path);
  const container = containerAt(definition, path);
  const scopeKey = input.scopeKey ?? '$root';
  // Inside a loop body: its rule, to mark the deciding step and draw the way back round.
  const containerSubflow = container ? subflowWorkflowId(container) : undefined;
  const workflowName = (id: string) => input.workflowNames?.[id] ?? id;
  const bodyLoop = container?.kind === 'loop' && !containerSubflow ? describeLoop(container, scope.topologicalOrder) : undefined;
  const rootState = run?.scopes[scopeKey];
  const agentNames = input.agentNames ?? {};
  const positions: Record<string, { x: number; y: number }> = autoLayout(scope);
  for (const id of Object.keys(positions)) {
    const saved = input.layout?.[layoutKey(path, id)];
    if (saved) positions[id] = saved;
  }
  for (const node of graphAt(definition, path).nodes) {
    const saved = input.layout?.[layoutKey(path, node.id)];
    positions[node.id] = saved ?? positions[node.id] ?? { x: 0, y: 0 };
  }
  const editable = !run && !!input.editable;
  const nodeIssues = new Map<string, string[]>();
  const edgeIssues = new Map<string, string[]>();
  for (const issue of input.issues ?? []) {
    if (issue.scopePath !== compilerScopePath(path)) continue;
    const target = issue.edgeId ? edgeIssues : issue.nodeId ? nodeIssues : null;
    const key = issue.edgeId ?? issue.nodeId;
    if (target && key) target.set(key, [...(target.get(key) ?? []), issue.message]);
  }
  const addRows = (nodeId: string, sides: { in?: string; out?: string }): CardRow[] =>
    editable
      ? [
          ...(sides.in
            ? [{ id: `${nodeId}-add-in`, label: sides.in, kind: 'add' as const, handle: { type: 'target' as const, id: 'in:+' }, tone: 'muted' as const }]
            : []),
          ...(sides.out
            ? [{ id: `${nodeId}-add-out`, label: sides.out, kind: 'add' as const, handle: { type: 'source' as const, id: 'out:+' }, tone: 'muted' as const }]
            : []),
        ]
      : [];

  const runningIds = new Set<string>(
    compiledRunScope && rootState?.status === 'RUNNING' && run?.status === 'RUNNING' && input.runActive !== false
      ? computeScopeReadyNodeIds(compiledRunScope as Parameters<typeof computeScopeReadyNodeIds>[0], rootState)
      : []
  );
  if (folded && run?.status === 'RUNNING' && input.runActive !== false) for (const id of folded.running) runningIds.add(id);
  const settled = !!run && run.status !== 'RUNNING' && !input.runActive;

  const statusOf = (nodeId: string): ViewStatus => {
    if (!run) return 'idle';
    const terminal = run.status === 'FAILED' || run.status === 'SUCCEEDED';
    // This round / item never started (or not yet).
    if (!rootState) return terminal ? 'unreached' : 'pending';
    if (nodeId === INPUTS_NODE_ID) return 'succeeded';
    if (nodeId === OUTPUTS_NODE_ID) return rootState.status === 'SUCCEEDED' ? 'succeeded' : 'pending';
    const nodeState = rootState.nodes[nodeId];
    const node = scope.nodesById[nodeId];
    // A container whose child scope is moving is running even though its own state is PENDING.
    const containerBusy =
      (node?.kind === 'loop' || node?.kind === 'parallel') &&
      nodeState?.status === 'PENDING' &&
      containerScopes(run, `${scopeKey}/${nodeId}`).some((s) => s.status === 'RUNNING');
    const status = viewStatus(nodeState, runningIds.has(nodeId) || containerBusy);
    return status === 'pending' && terminal ? 'unreached' : status;
  };

  const attemptsByNode = new Map<string, NodeAttemptRecord[]>();
  for (const attempt of Object.values(run?.attempts ?? {})) {
    if (attempt.scopeKey !== scopeKey) continue;
    const list = attemptsByNode.get(attempt.nodeId) ?? [];
    list.push(attempt);
    attemptsByNode.set(attempt.nodeId, list);
  }

  const chiefNotes = new Map<string, ActivityItem[]>();
  for (const event of run?.events ?? []) {
    if (event.type !== 'chief.intervened' || !event.nodeId) continue;
    const list = chiefNotes.get(event.nodeId) ?? [];
    for (const command of event.applied) {
      const text =
        command.kind === 'swap_agent'
          ? `swapped to ${agentLabel(command.agentRef, agentNames)}`
          : command.kind === 'inject_guidance'
            ? 'added guidance'
            : command.kind.replace(/_/g, ' ');
      list.push({ id: `chief-${event.timestampMs}-${list.length}`, tag: 'Chief', text, tone: 'warn' });
    }
    chiefNotes.set(event.nodeId, list);
  }

  const nodes: CanvasNode[] = [];
  const columnOf = (id: string) => Math.round((positions[id]?.x ?? 0) / COLUMN_WIDTH);
  const fannedOutParallel = new Map<string, readonly string[]>();
  const fannedOutStatus = new Map<string, ViewStatus>();
  const expandedLoopExit = new Map<string, string>();
  const extraLoopEdges: CanvasEdge[] = [];
  const bodyFirstStepId = bodyLoop ? scope.topologicalOrder[0] : undefined;

  // Inputs (left) and outputs (right) are cards too: the workflow's at the root, the
  // container's own ports inside a loop body or parallel item.
  const inputPorts = container ? containerScopeInputs(container) : definition.inputs;
  const outputPorts = container ? container.outputs : definition.outputs;
  const fields = (n: number) => `${n} field${n === 1 ? '' : 's'}`;
  nodes.push({
    id: INPUTS_NODE_ID,
    type: 'card',
    position: positions[INPUTS_NODE_ID]!,
    data: {
      nodeId: INPUTS_NODE_ID,
      kind: 'inputs',
      title: !container ? 'Inputs' : containerSubflow ? 'Sub-flow gets' : container.kind === 'loop' ? 'Each round gets' : 'Each item gets',
      subtitle: run && !container ? `Run ${run.runId.slice(-8)}` : fields(inputPorts.length),
      ...(bodyLoop?.deciderId ? { loopRole: 'start' as const } : {}),
      status: statusOf(INPUTS_NODE_ID),
      rows: inputPorts.map((port): CardRow => ({
        id: `in-${port.name}`,
        label: port.name,
        value: rootState && port.name in rootState.inputs ? preview(rootState.inputs[port.name]!.value) : port.type,
        kind: 'output',
        handle: { type: 'source', id: `out:${port.name}` },
        tone: 'default',
      })).concat(addRows(INPUTS_NODE_ID, { out: '+ input field' })),
      activity: [],
      order: 0,
      rerunnable: false,
      editable,
    },
  });

  for (const nodeId of scope.topologicalOrder) {
    const executionNode = scope.nodesById[nodeId]!;
    const node = executionNode.kind === 'parallel' && executionNode.origin
      ? (shownGraph?.nodes.find(n => n.id === nodeId) ?? executionNode.itemGraph.nodes[0]!) : executionNode;
    const parallel = nodeParallel(node);
    const nodeState = rootState?.nodes[nodeId];
    const status = statusOf(nodeId);

    // During a run, fan out a parallel container into concurrent item cards in its column.
    if (node.kind === 'parallel' && run) {
      const instanceKeys = containerInstanceKeys(run, `${scopeKey}/${nodeId}`);
      const itemsEdge = graphAt(definition, path).dataEdges.find(
        (e) => e.toNodeId === nodeId && e.toPort === node.itemsPort
      );
      const rawSourceVal = itemsEdge
        ? itemsEdge.fromNodeId === INPUTS_NODE_ID
          ? rootState?.inputs[itemsEdge.fromPort]?.value
          : rootState?.nodes[itemsEdge.fromNodeId]?.outputs[itemsEdge.fromPort]?.value
        : undefined;
      const previewItems = coerceParallelItems(rawSourceVal);
      const itemCount = instanceKeys.length > 0 ? instanceKeys.length : previewItems.length;

      if (itemCount > 0) {
        const childScope = scope.childScopes[nodeId]!;
        const compiledChildScope = compiledRunScope?.childScopes[nodeId];
        const basePos = positions[nodeId] ?? { x: 0, y: 0 };
        const cardIds: string[] = [];
        let activeSlotsUsed = 0;
        const terminal = run.status === 'FAILED' || run.status === 'SUCCEEDED';

        for (let idx = 0; idx < itemCount; idx++) {
          const cardId = `${nodeId}[${idx}]`;
          cardIds.push(cardId);
          const itemKey = instanceKeys[idx] ?? `${scopeKey}/${nodeId}[${idx}]`;
          const itemScope = run.scopes[itemKey];
          const itemVal =
            itemScope && node.itemsPort in itemScope.inputs ? itemScope.inputs[node.itemsPort]?.value : previewItems[idx];
          const itemAttempts = Object.values(run.attempts)
            .filter((a) => a.scopeKey === itemKey)
            .sort((a, b) => b.startedAtMs - a.startedAtMs);
          const latestItemAttempt = itemAttempts[0];
          const itemLive = input.liveProgress?.find((p) => p.scopeKey === itemKey);

          let itemStatus: ViewStatus;
          if (!itemScope) {
            if (status === 'running' && activeSlotsUsed < node.maxConcurrency) {
              activeSlotsUsed += 1;
              itemStatus = 'running';
            } else {
              itemStatus = status === 'running' ? 'pending' : status;
            }
          } else if (itemScope.status === 'SUCCEEDED') {
            itemStatus = 'succeeded';
          } else if (itemScope.status === 'FAILED') {
            itemStatus = 'failed';
          } else if (itemScope.status === 'WAITING') {
            itemStatus = 'waiting';
          } else if (itemScope.status === 'RUNNING') {
            if (terminal) {
              itemStatus = 'unreached';
            } else if (itemLive || itemAttempts.some((a) => a.status === 'RUNNING')) {
              activeSlotsUsed += 1;
              itemStatus = 'running';
            } else if (
              (status === 'running' || run.status === 'RUNNING') &&
              input.runActive !== false &&
              activeSlotsUsed < node.maxConcurrency
            ) {
              activeSlotsUsed += 1;
              itemStatus = 'running';
            } else {
              itemStatus = 'pending';
            }
          } else {
            itemStatus = terminal ? 'unreached' : 'pending';
          }
          fannedOutStatus.set(cardId, itemStatus);

          const itemRows: CardRow[] = [
            {
              id: 'open',
              label: 'steps',
              value: `${childScope.topologicalOrder.length} inside`,
              kind: 'open',
              tone: 'default',
            },
          ];

          for (const childId of childScope.topologicalOrder) {
            const childNode = childScope.nodesById[childId]!;
            const childState = itemScope?.nodes[childId];
            const childReady =
              compiledChildScope && itemScope?.status === 'RUNNING' && itemStatus === 'running'
                ? computeScopeReadyNodeIds(
                    compiledChildScope as Parameters<typeof computeScopeReadyNodeIds>[0],
                    itemScope
                  ).includes(childId)
                : itemStatus === 'running' && !itemScope && childId === childScope.topologicalOrder[0];
            const childHasLive = Boolean(
              input.liveProgress?.some((p) => p.scopeKey === itemKey && p.nodeId === childId)
            );
            const childStatus = viewStatus(childState, childReady || childHasLive);
            itemRows.push({
              id: `body-${childId}`,
              label: childNode.name,
              value: childState?.latestVerdict ?? childStatus,
              kind: 'body',
              tone: statusTone(childStatus),
              status: childStatus,
            });
          }

          if (showsWorkspaces(definition)) {
            const slot = node.workspace ?? inheritedWorkspaceSlot(definition, path);
            const bound = run.workspaces[slot];
            itemRows.push({
              id: 'workspace',
              label: 'workspace',
              value: bound ? `${slot} · ${bound.name ?? bound.path}` : slot,
              kind: 'command',
              tone: 'muted',
            });
          }

          for (const port of node.inputs) {
            const shownVal =
              port.name === node.itemsPort && itemVal !== undefined
                ? preview(itemVal)
                : itemScope?.inputs[port.name]
                  ? preview(itemScope.inputs[port.name]!.value)
                  : port.type;
            itemRows.push({
              id: `in-${port.name}`,
              label: port.name === node.itemsPort ? 'item' : port.name,
              value: shownVal,
              kind: 'input',
              handle: { type: 'target', id: `in:${port.name}` },
              tone: itemVal !== undefined ? 'default' : 'muted',
            });
          }

          for (const port of node.outputs) {
            const produced =
              itemScope?.outputs[port.name] ?? Object.values(itemScope?.outputs ?? {})[0];
            itemRows.push({
              id: `out-${port.name}`,
              label: port.name,
              value: produced?.artifactId
                ? 'artifact'
                : produced
                  ? preview(
                      port.type === 'assessment'
                        ? (produced.value as { verdict?: string })?.verdict
                        : produced.value
                    )
                  : port.type,
              kind: 'output',
              handle: { type: 'source', id: `out:${port.name}` },
              tone: produced ? 'default' : 'muted',
              ...(produced?.artifactId ? { artifactId: produced.artifactId } : {}),
            });
          }

          const leafNode =
            (latestItemAttempt ? childScope.nodesById[latestItemAttempt.nodeId] : undefined) ??
            (itemLive ? childScope.nodesById[itemLive.nodeId] : undefined) ??
            childScope.nodesById[childScope.topologicalOrder[0]!] ??
            node;
          const itemActivity: ActivityItem[] = itemAttempts.slice(0, 4).map((a) => {
            const verdict = a.assessmentId ? run.assessments[a.assessmentId]?.verdict : undefined;
            const failed = a.status === 'FAILED' || verdict === 'FAIL' || verdict === 'BLOCKED';
            return {
              id: a.attemptId,
              tag: a.agent ? `${a.agent.agentId}@${a.agent.version}` : leafNode.kind,
              text: `${verdict ?? a.status.toLowerCase()} · ${formatTime(a.completedAtMs ?? a.startedAtMs)}`,
              tone: (failed ? 'danger' : verdict === 'NEEDS_FIX' ? 'warn' : 'muted') as Tone,
            };
          });

          const savedCardPos = input.layout?.[layoutKey(path, cardId)];
          const cardPos = savedCardPos ?? {
            x: basePos.x,
            y: Math.round(basePos.y + (idx - (itemCount - 1) / 2) * ROW_HEIGHT),
          };

          nodes.push({
            id: cardId,
            type: 'card',
            position: cardPos,
            data: {
              nodeId: cardId,
              scopeNodeId: nodeId,
              itemIndex: idx,
              kind: 'parallel',
              title: `${node.name} #${idx + 1}`,
              subtitle: itemVal !== undefined ? preview(itemVal) : `Item ${idx + 1} of ${itemCount}`,
              status: itemStatus,
              rows: itemRows,
              ...(itemAttempts.length > 0
                ? {
                    activityTitle: `${itemAttempts.length} attempt${itemAttempts.length === 1 ? '' : 's'}${latestItemAttempt?.error ? ` · ${latestItemAttempt.error}` : ''}`,
                  }
                : {}),
              activity: itemActivity,
              order: columnOf(nodeId),
              rerunnable:
                settled &&
                path.length === 0 &&
                idx === 0 &&
                (nodeState?.status === 'SUCCEEDED' || nodeState?.status === 'FAILED'),
              editable: false,
            },
          });
        }

        fannedOutParallel.set(nodeId, cardIds);
        continue;
      }
    }
    const pendingWait =
      nodeState?.activeWaitRequestId && run?.waitRequests[nodeState.activeWaitRequestId]?.status === 'PENDING'
        ? run.waitRequests[nodeState.activeWaitRequestId]
        : undefined;
    const rows: CardRow[] = [];
    let subtitle = '';
    let agentRef: string | undefined;
    let runtimeChoice: RuntimeChoice | undefined;
    let loopSummary: LoopSummary | undefined;

    if (node.kind === 'agent') {
      const latestAttempt = nodeState?.latestAttemptId ? run?.attempts[nodeState.latestAttemptId] : undefined;
      agentRef = node.agentRef;
      runtimeChoice = {
        ...(node.agentType ? { agentType: node.agentType } : {}),
        ...(node.modelId ? { modelId: node.modelId } : {}),
        ...(node.effort ? { effort: node.effort } : {}),
      };
      const performedBy = latestAttempt?.agent?.ref ?? node.agentRef;
      subtitle = node.producesAssessment ? 'Independent review' : node.role;
      rows.push({
        id: 'agent',
        label: 'agent',
        value: agentLabel(performedBy, agentNames) ?? `role: ${node.role}`,
        kind: 'agent',
        tone: 'default',
      });
      // What it runs on: the attempt's actual settings in a run, otherwise the step's
      // overrides over its agent's defaults.
      const receipt = latestAttempt?.receipt;
      const runsOn = describeRuntime(
        receipt?.agentType
          ? {
              agentType: receipt.agentType,
              ...(receipt.modelId ? { modelId: receipt.modelId } : {}),
              ...(receipt.effort ? { effort: receipt.effort } : {}),
            }
          : effectiveRuntime(runtimeChoice, performedBy ? input.agentRuntimes?.[performedBy.split('@')[0]!] : undefined)
      );
      if (runsOn) rows.push({ id: 'runtime', label: 'runs on', value: runsOn, kind: 'command', tone: 'muted' });
    } else if (node.kind === 'script') {
      subtitle = 'Script';
      rows.push({ id: 'command', label: 'run', value: [node.command, ...node.args].join(' '), kind: 'command', tone: 'muted' });
    } else if (node.kind === 'gate') {
      subtitle = pendingWait ? 'Waiting for your decision' : 'Human decision';
      const decided = nodeState?.outputs[node.outputs[0]?.name ?? 'decision']?.value;
      rows.push({
        id: 'decision',
        label: 'decision',
        value: decided !== undefined ? String(decided) : pendingWait ? 'Choose' : '—',
        kind: 'decision',
        tone: pendingWait ? 'warn' : 'default',
      });
    } else if (node.kind === 'subflow') {
      // Not embedded yet (design view): it names the workflow it will run.
      subtitle = 'Sub-flow';
      rows.push({
        id: 'workflow',
        label: 'runs',
        value: node.workflowId ? workflowName(node.workflowId) : 'choose a workflow',
        kind: node.workflowId ? 'open' : 'command',
        tone: node.workflowId ? 'default' : 'warn',
      });
    } else {
      const childScope = scope.childScopes[nodeId]!;
      const instances = run ? containerScopes(run, `${scopeKey}/${nodeId}`) : [];
      const runsWorkflow = subflowWorkflowId(node);
      rows.push({
        id: 'open',
        label: 'steps',
        value: `${childScope.topologicalOrder.length} inside`,
        kind: 'open',
        tone: 'default',
      });
      if (runsWorkflow) {
        subtitle = workflowName(runsWorkflow);
      } else if (node.kind === 'loop') {
        loopSummary = describeLoop(node, childScope.topologicalOrder, { run, scopeKey });
        const limit = loopSummary.maxRounds + loopSummary.extraRounds;
        subtitle =
          loopSummary.rounds.length > 0
            ? `Round ${loopSummary.rounds.length} of ${limit}`
            : `Up to ${node.maxRounds} round${node.maxRounds === 1 ? '' : 's'}`;
      } else {
        subtitle = instances.length > 0 ? `${instances.length} items` : `Up to ${node.maxConcurrency} at a time`;
      }
      for (const childId of childScope.topologicalOrder) {
        const childStates = instances.map((s) => s.nodes[childId]).filter((n): n is NodeRuntimeState => !!n);
        const child = childStates[childStates.length - 1];
        const childRunning = !!child && child.status === 'PENDING' && instances.some((s) => s.status === 'RUNNING') && status === 'running';
        const shownStatus = run ? viewStatus(child, childRunning) : 'idle';
        rows.push({
          id: `body-${childId}`,
          label: childScope.nodesById[childId]!.name,
          value: child?.latestVerdict ?? (run ? shownStatus : childScope.nodesById[childId]!.kind),
          kind: 'body',
          tone: statusTone(shownStatus),
          status: shownStatus,
        });
      }
    }

    // Which project it works in, once the workflow has more than one to choose from.
    if (node.kind !== 'gate' && showsWorkspaces(definition)) {
      const slot = node.workspace ?? inheritedWorkspaceSlot(definition, path);
      const bound = run?.workspaces[slot];
      rows.push({
        id: 'workspace',
        label: 'workspace',
        value: bound ? `${slot} · ${bound.name ?? bound.path}` : slot,
        kind: 'command',
        tone: 'muted',
      });
    }

    if (parallel) {
      const region = cycleViews.filter(l => l.memberIds.includes(nodeId)).sort((a, b) => a.memberIds.length - b.memberIds.length)[0];
      const executionScopeKey = region?.shownRound !== undefined ? region.rounds[region.shownRound]?.scopeKey ?? scopeKey : scopeKey;
      const items = run ? containerInstanceKeys(run, `${executionScopeKey}/${nodeId}`).map(k => run.scopes[k]!) : [];
      const done = items.filter(i => i.status === 'SUCCEEDED').length;
      const failed = items.filter(i => i.status === 'FAILED' || i.status === 'CANCELLED').length;
      subtitle += ` · Parallel ×${parallel.maxConcurrency}`;
      rows.push({ id: 'parallel-items', label: 'items', value: items.length ? `${done}/${items.length} done${failed ? ` · ${failed} failed` : ''}` : `from ${parallel.itemsPort}`, kind: 'command', tone: failed ? 'danger' : 'muted' });
    }
    for (const port of nodeBoundaryPorts(node, 'in')) {
      rows.push({
        id: `in-${port.name}`,
        label: port.name,
        value: port.type,
        kind: 'input',
        handle: { type: 'target', id: `in:${port.name}` },
        tone: 'muted',
      });
    }
    for (const port of nodeBoundaryPorts(node, 'out')) {
      const produced = nodeState?.outputs[port.name];
      rows.push({
        id: `out-${port.name}`,
        label: port.name,
        value:
          produced?.artifactId
            ? 'artifact'
            : produced
              ? preview(port.type === 'assessment' ? (produced.value as { verdict?: string })?.verdict : produced.value)
              : port.type,
        kind: 'output',
        handle: { type: 'source', id: `out:${port.name}` },
        tone: produced ? 'default' : 'muted',
        ...(produced?.artifactId ? { artifactId: produced.artifactId } : {}),
      });
    }

    // A sub-flow step's fields are its workflow's.
    if (node.kind !== 'subflow') rows.push(...addRows(nodeId, { in: '+ input', out: '+ output' }));

    const attempts = (attemptsByNode.get(nodeId) ?? []).sort((a, b) => b.startedAtMs - a.startedAtMs);
    const activity: ActivityItem[] = [
      ...(chiefNotes.get(nodeId) ?? []),
      ...attempts.slice(0, 4).map((a) => {
        const verdict = a.assessmentId ? run?.assessments[a.assessmentId]?.verdict : undefined;
        const failed = a.status === 'FAILED' || verdict === 'FAIL' || verdict === 'BLOCKED';
        return {
          id: a.attemptId,
          tag: a.agent ? `${a.agent.agentId}@${a.agent.version}` : node.kind,
          text: `${verdict ?? a.status.toLowerCase()} · ${formatTime(a.completedAtMs ?? a.startedAtMs)}`,
          tone: (failed ? 'danger' : verdict === 'NEEDS_FIX' ? 'warn' : 'muted') as Tone,
        };
      }),
    ];

    nodes.push({
      id: nodeId,
      type: 'card',
      position: positions[nodeId] ?? { x: 0, y: 0 },
      data: {
        nodeId,
        kind: subflowWorkflowId(node) ? 'subflow' : node.kind,
        ...(subflowWorkflowId(node) ? { subflowOf: subflowWorkflowId(node) } : {}),
        title: node.name,
        subtitle,
        status,
        ...(nodeState?.latestVerdict ? { verdict: nodeState.latestVerdict } : {}),
        rows,
        ...(attempts.length > 0
          ? { activityTitle: `${attempts.length} attempt${attempts.length === 1 ? '' : 's'}${nodeState?.error ? ` · ${nodeState.error}` : ''}` }
          : {}),
        activity,
        ...(pendingWait ? { pendingWait } : {}),
        ...(agentRef ? { agentRef } : {}),
        ...(runtimeChoice ? { runtimeChoice } : {}),
        ...(loopSummary ? { loop: loopSummary } : {}),
        ...(node.kind === 'loop' &&
        scope.childScopes[nodeId]?.topologicalOrder.length === 1 &&
        loopSummary?.deciderId === scope.childScopes[nodeId]?.topologicalOrder[0]
          ? { loopRole: 'start' as const }
          : {}),
        ...(bodyLoop?.deciderId === nodeId
          ? { loopRole: 'decider' as const, loopRepeat: bodyLoop.repeatLabel }
          : bodyFirstStepId === nodeId && bodyLoop?.deciderId
            ? { loopRole: 'start' as const }
            : cycleDeciders.has(nodeId)
              ? {
                  loopRole: cycleHeads.has(nodeId) && cycleDeciders.get(nodeId)!.headId === nodeId ? ('self' as const) : ('decider' as const),
                  loopRepeat: backEdgeLabel(cycleDeciders.get(nodeId)!.backEdgeId).split(' →')[0]!,
                }
              : cycleHeads.has(nodeId)
                ? { loopRole: 'start' as const }
                : {}),
        order: columnOf(nodeId),
        // Reruns restart from the top-level graph; inside a round/item they would need its scope.
        rerunnable: settled && path.length === 0 && (nodeState?.status === 'SUCCEEDED' || nodeState?.status === 'FAILED'),
        editable,
        ...(nodeIssues.has(nodeId) ? { issue: nodeIssues.get(nodeId)!.join('\n') } : {}),
      },
    });

    // Expand loop body steps inline alongside the loop card so the cycle is directly visible on the flow graph.
    if (node.kind === 'loop' && loopSummary) {
      const childScope = scope.childScopes[nodeId]!;
      const childOrder = childScope.topologicalOrder;
      if (childOrder.length > 0) {
        const instances = run ? containerScopes(run, `${scopeKey}/${nodeId}`) : [];
        const latestRoundScope = instances[instances.length - 1];
        const latestRoundKey = latestRoundScope?.scopeKey;
        const compiledChildScope = compiledRunScope?.childScopes[nodeId];
        const childReadyIds = new Set<string>(
          compiledChildScope &&
            latestRoundScope?.status === 'RUNNING' &&
            run?.status === 'RUNNING' &&
            input.runActive !== false
            ? computeScopeReadyNodeIds(
                compiledChildScope as Parameters<typeof computeScopeReadyNodeIds>[0],
                latestRoundScope
              )
            : []
        );
        const firstChildId = childOrder[0]!;
        const lastChildId = childOrder[childOrder.length - 1]!;
        const deciderChildId = loopSummary.deciderId ?? lastChildId;

        for (const childId of childOrder) {
          const expandedId = `${nodeId}/${childId}`;
          const childNode = childScope.nodesById[childId]!;
          const childState = latestRoundScope?.nodes[childId];
          const childLive = latestRoundKey
            ? input.liveProgress?.find((p) => p.scopeKey === latestRoundKey && p.nodeId === childId)
            : undefined;
          const terminal = run?.status === 'FAILED' || run?.status === 'SUCCEEDED';
          const childStatus: ViewStatus = !run
            ? 'idle'
            : !latestRoundScope
              ? terminal
                ? 'unreached'
                : status === 'running' && childId === firstChildId
                  ? 'running'
                  : 'pending'
              : viewStatus(childState, childReadyIds.has(childId) || Boolean(childLive));
          fannedOutStatus.set(expandedId, childStatus);

          const childRows: CardRow[] = [];
          let childSubtitle = '';
          let childAgentRef: string | undefined;
          let childRuntimeChoice: RuntimeChoice | undefined;

          const childAttempts = run
            ? Object.values(run.attempts)
                .filter(
                  (a) =>
                    a.nodeId === childId &&
                    (a.scopeKey === latestRoundKey || a.scopeKey.startsWith(`${scopeKey}/${nodeId}:`))
                )
                .sort((a, b) => b.startedAtMs - a.startedAtMs)
            : [];
          const latestChildAttempt = childAttempts[0];

          if (childNode.kind === 'agent') {
            childAgentRef = childNode.agentRef;
            childRuntimeChoice = {
              ...(childNode.agentType ? { agentType: childNode.agentType } : {}),
              ...(childNode.modelId ? { modelId: childNode.modelId } : {}),
              ...(childNode.effort ? { effort: childNode.effort } : {}),
            };
            const performedBy = latestChildAttempt?.agent?.ref ?? childNode.agentRef;
            childSubtitle = childNode.producesAssessment ? 'Independent review' : childNode.role;
            childRows.push({
              id: 'agent',
              label: 'agent',
              value: agentLabel(performedBy, agentNames) ?? `role: ${childNode.role}`,
              kind: 'agent',
              tone: 'default',
            });
            const receipt = latestChildAttempt?.receipt;
            const runsOn = describeRuntime(
              receipt?.agentType
                ? {
                    agentType: receipt.agentType,
                    ...(receipt.modelId ? { modelId: receipt.modelId } : {}),
                    ...(receipt.effort ? { effort: receipt.effort } : {}),
                  }
                : effectiveRuntime(
                    childRuntimeChoice,
                    performedBy ? input.agentRuntimes?.[performedBy.split('@')[0]!] : undefined
                  )
            );
            if (runsOn) {
              childRows.push({ id: 'runtime', label: 'runs on', value: runsOn, kind: 'command', tone: 'muted' });
            }
          } else if (childNode.kind === 'script') {
            childSubtitle = 'Script';
            childRows.push({
              id: 'command',
              label: 'run',
              value: [childNode.command, ...childNode.args].join(' '),
              kind: 'command',
              tone: 'muted',
            });
          } else if (childNode.kind === 'gate') {
            childSubtitle = 'Human decision';
          }

          for (const port of childNode.inputs) {
            childRows.push({
              id: `in-${port.name}`,
              label: port.name,
              value: port.type,
              kind: 'input',
              handle: { type: 'target', id: `in:${port.name}` },
              tone: 'muted',
            });
          }
          const existingOutNames = new Set<string>();
          for (const port of childNode.outputs) {
            existingOutNames.add(port.name);
            const produced = childState?.outputs[port.name];
            childRows.push({
              id: `out-${port.name}`,
              label: port.name,
              value: produced?.artifactId
                ? 'artifact'
                : produced
                  ? preview(
                      port.type === 'assessment'
                        ? (produced.value as { verdict?: string })?.verdict
                        : produced.value
                    )
                  : port.type,
              kind: 'output',
              handle: { type: 'source', id: `out:${port.name}` },
              tone: produced ? 'default' : 'muted',
              ...(produced?.artifactId ? { artifactId: produced.artifactId } : {}),
            });
          }
          if (childId === lastChildId) {
            for (const port of node.outputs) {
              if (existingOutNames.has(port.name)) continue;
              const produced = nodeState?.outputs[port.name] ?? latestRoundScope?.outputs[port.name];
              childRows.push({
                id: `out-${port.name}`,
                label: port.name,
                value: produced?.artifactId
                  ? 'artifact'
                  : produced
                    ? preview(produced.value)
                    : `pass → ${port.type}`,
                kind: 'output',
                handle: { type: 'source', id: `out:${port.name}` },
                tone: produced ? 'default' : 'muted',
                ...(produced?.artifactId ? { artifactId: produced.artifactId } : {}),
              });
            }
          }

          const childActivity: ActivityItem[] = childAttempts.slice(0, 4).map((a) => {
            const verdict = a.assessmentId && run ? run.assessments[a.assessmentId]?.verdict : undefined;
            const failed = a.status === 'FAILED' || verdict === 'FAIL' || verdict === 'BLOCKED';
            return {
              id: a.attemptId,
              tag: a.agent ? `${a.agent.agentId}@${a.agent.version}` : childNode.kind,
              text: `${verdict ?? a.status.toLowerCase()} · ${formatTime(a.completedAtMs ?? a.startedAtMs)}`,
              tone: (failed ? 'danger' : verdict === 'NEEDS_FIX' ? 'warn' : 'muted') as Tone,
            };
          });

          const savedChildPos = input.layout?.[layoutKey([...path, nodeId], childId)];
          const childPos = savedChildPos ?? positions[expandedId] ?? { x: 0, y: 0 };

          nodes.push({
            id: expandedId,
            type: 'card',
            position: childPos,
            data: {
              nodeId: expandedId,
              scopeNodeId: nodeId,
              kind: childNode.kind,
              title: childNode.name,
              subtitle: childSubtitle,
              status: childStatus,
              ...(childState?.latestVerdict ? { verdict: childState.latestVerdict } : {}),
              rows: childRows,
              ...(childAttempts.length > 0
                ? {
                    activityTitle: `${childAttempts.length} attempt${childAttempts.length === 1 ? '' : 's'}${childState?.error ? ` · ${childState.error}` : ''}`,
                  }
                : {}),
              activity: childActivity,
              ...(childAgentRef ? { agentRef: childAgentRef } : {}),
              ...(childRuntimeChoice ? { runtimeChoice: childRuntimeChoice } : {}),
              ...(childId === deciderChildId
                ? { loopRole: 'decider' as const, loopRepeat: loopSummary.repeatLabel }
                : childId === firstChildId
                  ? { loopRole: 'start' as const }
                  : {}),
              order: columnOf(expandedId),
              rerunnable: false,
              editable: false,
            },
          });
        }

        expandedLoopExit.set(nodeId, `${nodeId}/${lastChildId}`);

        // 1. Entry edge from the Loop controller card to the first body step
        const firstTargetId = `${nodeId}/${firstChildId}`;
        extraLoopEdges.push({
          id: `loop_entry_${nodeId}_to_${firstChildId}`,
          type: 'flow',
          source: nodeId,
          target: firstTargetId,
          sourceHandle: 'ctrl-out',
          targetHandle: 'ctrl-in',
          data: {
            tone: !run
              ? 'idle'
              : fannedOutStatus.get(firstTargetId) === 'running'
                ? 'flowing'
                : fannedOutStatus.get(firstTargetId) === 'succeeded'
                  ? 'delivered'
                  : 'idle',
            label: 'Start round',
            control: true,
          },
        });

        // 2. Inner data & control edges between body steps
        const innerTone = (src: string, tgt: string): EdgeTone =>
          !run
            ? 'idle'
            : fannedOutStatus.get(tgt) === 'running'
              ? 'flowing'
              : fannedOutStatus.get(src) === 'succeeded' && fannedOutStatus.get(tgt) === 'succeeded'
                ? 'delivered'
                : 'idle';
        for (const ie of node.bodyGraph.dataEdges) {
          if (ie.fromNodeId === INPUTS_NODE_ID || ie.toNodeId === OUTPUTS_NODE_ID) continue;
          const src = `${nodeId}/${ie.fromNodeId}`;
          const tgt = `${nodeId}/${ie.toNodeId}`;
          extraLoopEdges.push({
            id: `${nodeId}/${ie.id}`,
            type: 'flow',
            source: src,
            target: tgt,
            sourceHandle: `out:${ie.fromPort}`,
            targetHandle: `in:${ie.toPort}`,
            data: {
              tone: !run
                ? 'idle'
                : fannedOutStatus.get(tgt) === 'running'
                  ? 'flowing'
                  : fannedOutStatus.get(src) === 'succeeded' && fannedOutStatus.get(tgt) === 'succeeded'
                    ? 'delivered'
                    : fannedOutStatus.get(tgt) === 'failed'
                      ? 'failed'
                      : 'idle',
              label: ie.fromPort === ie.toPort ? ie.toPort : `${ie.fromPort} → ${ie.toPort}`,
              control: false,
            },
          });
        }
        for (const ie of node.bodyGraph.controlEdges) {
          if (ie.fromNodeId === INPUTS_NODE_ID || ie.toNodeId === OUTPUTS_NODE_ID) continue;
          const cond = describeCondition(ie.when);
          const src = `${nodeId}/${ie.fromNodeId}`;
          const tgt = `${nodeId}/${ie.toNodeId}`;
          extraLoopEdges.push({
            id: `${nodeId}/${ie.id}`,
            type: 'flow',
            source: src,
            target: tgt,
            sourceHandle: 'ctrl-out',
            targetHandle: 'ctrl-in',
            data: {
              tone: innerTone(src, tgt),
              label: cond ?? 'After success',
              control: true,
              pinned: !!cond,
            },
          });
        }
        const innerGraph = {
          controlEdges: node.bodyGraph.controlEdges,
          dataEdges: node.bodyGraph.dataEdges.filter((e) => e.fromNodeId !== INPUTS_NODE_ID && e.toNodeId !== OUTPUTS_NODE_ID),
        };
        for (const [from, to] of impliedFlowPairs(innerGraph)) {
          const src = `${nodeId}/${from}`;
          const tgt = `${nodeId}/${to}`;
          extraLoopEdges.push(impliedFlowEdge(src, tgt, innerTone(src, tgt)));
        }

        // 3. Cycle (loop-back) edge from the deciding step back to the start of the round
        const loopBackSource = `${nodeId}/${deciderChildId}`;
        const loopBackTarget =
          firstChildId !== deciderChildId ? `${nodeId}/${firstChildId}` : nodeId;
        const hadRepeat = loopSummary.rounds.some((r) => r.state === 'again');
        extraLoopEdges.push({
          id: `$loop-back:${nodeId}`,
          type: 'loop',
          source: loopBackSource,
          target: loopBackTarget,
          sourceHandle: 'loop-out',
          targetHandle: 'loop-in',
          data: {
            tone: hadRepeat ? 'delivered' : 'idle',
            label: `if ${loopSummary.repeatLabel}`,
            control: true,
          },
        });
      }
    }
  }

  nodes.push({
    id: OUTPUTS_NODE_ID,
    type: 'card',
    position: positions[OUTPUTS_NODE_ID]!,
    data: {
      nodeId: OUTPUTS_NODE_ID,
      kind: 'outputs',
      title: !container ? 'Outputs' : containerSubflow ? 'Sub-flow result' : container.kind === 'loop' ? 'Loop result' : 'Item result',
      subtitle: rootState?.status === 'SUCCEEDED' ? 'Delivered' : fields(outputPorts.length),
      status: statusOf(OUTPUTS_NODE_ID),
      rows: outputPorts.map((port): CardRow => {
        const value = rootState?.outputs[port.name];
        return {
          id: `out-${port.name}`,
          label: port.name,
          value: value?.artifactId ? 'artifact' : value ? preview(value.value) : port.type,
          kind: 'input' as const,
          handle: { type: 'target' as const, id: `in:${port.name}` },
          tone: value ? ('default' as const) : ('muted' as const),
          ...(value?.artifactId ? { artifactId: value.artifactId } : {}),
        };
      }).concat(addRows(OUTPUTS_NODE_ID, { in: '+ output field' })),
      activity: [],
      order: columnOf(OUTPUTS_NODE_ID),
      rerunnable: false,
      editable,
    },
  });

  // ---------------------------------------------------------------------------
  // Edges
  // ---------------------------------------------------------------------------

  const statusOfCard = (id: string): ViewStatus => fannedOutStatus.get(id) ?? statusOf(id);

  const edgeTone = (from: string, to: string): EdgeTone => {
    if (!run) return 'idle';
    const target = statusOfCard(to);
    const source = statusOfCard(from);
    if (target === 'skipped' || source === 'skipped' || target === 'unreached') return 'skipped';
    if (target === 'failed' || source === 'failed') return 'failed';
    if (target === 'running' || target === 'waiting') return 'flowing';
    if (source === 'succeeded' && (target === 'succeeded' || to === OUTPUTS_NODE_ID || fannedOutStatus.has(from))) return 'delivered';
    return 'idle';
  };

  const deliveredLabel = (from: string, fromPort: string, to: string, toPort: string): string => {
    const manifestEntry = run
      ? Object.values(run.manifests)
          .filter((m) => m.nodeId === to && m.scopeKey === scopeKey)
          .sort((a, b) => b.createdAtMs - a.createdAtMs)[0]
          ?.entries.find((e) => e.portName === toPort && e.sourceNodeId === from)
      : undefined;
    if (manifestEntry) return `${toPort} · ${formatBytes(manifestEntry.byteSize)}`;
    return fromPort === toPort ? toPort : `${fromPort} → ${toPort}`;
  };

  const edges: CanvasEdge[] = [];
  const carriedEdges = cycles ? analyzeLoopBacks(cycles).carryEdgeIds : new Set<string>();
  for (const edge of graphAt(definition, path).dataEdges) {
    const sourceBase = expandedLoopExit.get(edge.fromNodeId) ?? edge.fromNodeId;
    const sources = fannedOutParallel.get(sourceBase) ?? [sourceBase];
    const targets = fannedOutParallel.get(edge.toNodeId) ?? [edge.toNodeId];
    const single = sources.length === 1 && targets.length === 1;
    for (const src of sources) {
      for (const tgt of targets) {
        edges.push({
          id: single ? edge.id : `${edge.id}:${src}->${tgt}`,
          type: 'flow',
          source: src,
          target: tgt,
          sourceHandle: `out:${edge.fromPort}`,
          targetHandle: `in:${edge.toPort}`,
          data: {
            tone: edgeTone(src, tgt),
            label: carriedEdges.has(edge.id)
              ? `↻ ${edge.fromPort} from the previous round`
              : deliveredLabel(edge.fromNodeId, edge.fromPort, edge.toNodeId, edge.toPort),
            control: false,
            pinned: carriedEdges.has(edge.id),
            selected: input.selectedEdgeId === edge.id,
            ...(edgeIssues.has(edge.id) ? { issue: edgeIssues.get(edge.id)!.join('\n') } : {}),
          },
        });
      }
    }
  }
  for (const edge of graphAt(definition, path).controlEdges) {
    if (edge.loop && cycles) {
      const loop = cycleViews.find((l) => l.backEdgeId === edge.id);
      edges.push({
        id: edge.id,
        type: 'loop',
        source: edge.fromNodeId,
        target: edge.toNodeId,
        sourceHandle: 'loop-out',
        targetHandle: 'loop-in',
        data: {
          // Going round now (a later round is running), or has gone round before.
          tone: loop && loop.rounds.length > 1 ? (loop.rounds[loop.rounds.length - 1]!.status === 'RUNNING' ? 'flowing' : 'delivered') : 'idle',
          label: backEdgeLabel(edge.id),
          control: true,
          ...(loop ? { cycle: loop } : {}),
          selected: input.selectedEdgeId === edge.id,
          ...(edgeIssues.has(edge.id) ? { issue: edgeIssues.get(edge.id)!.join('\n') } : {}),
        },
      });
      continue;
    }
    const condition = describeCondition(edge.when);
    const sourceBase = expandedLoopExit.get(edge.fromNodeId) ?? edge.fromNodeId;
    const sources = fannedOutParallel.get(sourceBase) ?? [sourceBase];
    const targets = fannedOutParallel.get(edge.toNodeId) ?? [edge.toNodeId];
    const single = sources.length === 1 && targets.length === 1;
    for (const src of sources) {
      for (const tgt of targets) {
        edges.push({
          id: single ? edge.id : `${edge.id}:${src}->${tgt}`,
          type: 'flow',
          source: src,
          target: tgt,
          sourceHandle: 'ctrl-out',
          targetHandle: 'ctrl-in',
          data: {
            tone: edgeTone(src, tgt),
            label: condition ?? 'After success',
            control: true,
            pinned: !!condition,
            selected: input.selectedEdgeId === edge.id,
            ...(edgeIssues.has(edge.id) ? { issue: edgeIssues.get(edge.id)!.join('\n') } : {}),
          },
        });
      }
    }
  }
  // Steps linked only by parameters get a flow line too, since parameter lines are hidden by default.
  const levelGraph = graphAt(definition, path);
  const flowGraph = { controlEdges: levelGraph.controlEdges, dataEdges: levelGraph.dataEdges.filter((e) => !carriedEdges.has(e.id)) };
  const flowPairs = impliedFlowPairs(flowGraph);
  // The flow starts at the inputs card and ends at the outputs card, even for steps that take or give nothing.
  const steps = levelGraph.nodes.map((n) => n.id);
  const linked = [...flowGraph.controlEdges.filter((e) => !e.loop), ...flowGraph.dataEdges];
  if (nodes.some((n) => n.id === INPUTS_NODE_ID)) {
    for (const id of steps) if (!linked.some((e) => e.toNodeId === id)) flowPairs.push([INPUTS_NODE_ID, id]);
  }
  if (nodes.some((n) => n.id === OUTPUTS_NODE_ID)) {
    for (const id of steps) if (!linked.some((e) => e.fromNodeId === id)) flowPairs.push([id, OUTPUTS_NODE_ID]);
  }
  for (const [from, to] of flowPairs) {
    const sourceBase = expandedLoopExit.get(from) ?? from;
    for (const src of fannedOutParallel.get(sourceBase) ?? [sourceBase]) {
      for (const tgt of fannedOutParallel.get(to) ?? [to]) edges.push(impliedFlowEdge(src, tgt, edgeTone(src, tgt)));
    }
  }
  edges.push(...extraLoopEdges);

  if (bodyLoop?.deciderId) {
    const targetId =
      bodyFirstStepId && bodyFirstStepId !== bodyLoop.deciderId ? bodyFirstStepId : INPUTS_NODE_ID;
    const deciderVerdict = rootState?.nodes[bodyLoop.deciderId]?.latestVerdict;
    const repeated =
      deciderVerdict === 'NEEDS_FIX' ||
      (container?.kind === 'loop' &&
        container.continueWhen.kind === 'always' &&
        rootState?.status === 'SUCCEEDED');
    edges.push({
      id: '$loop-back',
      type: 'loop',
      source: bodyLoop.deciderId,
      target: targetId,
      sourceHandle: 'loop-out',
      targetHandle: 'loop-in',
      data: {
        tone: repeated ? 'delivered' : statusOf(bodyLoop.deciderId) === 'running' ? 'flowing' : 'idle',
        label: `if ${bodyLoop.repeatLabel}`,
        control: true,
      },
    });
  }

  // Nothing placed by hand yet: lay the graph out from estimated card sizes.
  const hasSavedLayout = nodes.some((n) => input.layout?.[layoutKey(path, n.id)] !== undefined);
  const placed = hasSavedLayout
    ? nodes
    : (() => {
        const tidy = layeredLayout({
          nodes: nodes.map((n) => ({ id: n.id, width: CARD_WIDTH, height: estimateCardHeight(n.data) })),
          edges: edges.filter((e) => e.type !== 'loop'),
          first: INPUTS_NODE_ID,
          last: OUTPUTS_NODE_ID,
          maxRowWidth: FIRST_LAYOUT_ROW_WIDTH,
        });
        return nodes.map((n) => (tidy[n.id] ? { ...n, position: tidy[n.id]! } : n));
      })();

  const selectedId = input.selectedNodeId;
  const reversed = runningLeft(placed, edges);
  return {
    nodes: placed.map((n) =>
      n.id === selectedId || reversed.has(n.id)
        ? { ...n, data: { ...n.data, ...(n.id === selectedId ? { selected: true } : {}), ...(reversed.has(n.id) ? { reversed: true } : {}) } }
        : n
    ),
    edges: edges.map((edge) => {
      const touches = !!selectedId && (edge.source === selectedId || edge.target === selectedId);
      const parameter = edge.type === 'flow' && !edge.data.control;
      return {
        ...edge,
        ...(parameter && !touches && !edge.data.selected && !edge.data.issue ? { hidden: true } : {}),
        data: { ...edge.data, focused: touches, muted: !!selectedId && !touches && !edge.data.selected },
      };
    }),
    ...(cycleViews.length > 0 ? { loops: cycleViews } : {}),
    ...(container
      ? {
          banner: {
            kind: container.kind,
            title: containerSubflow
              ? `Sub-flow · ${container.name}`
              : container.kind === 'loop'
                ? `Loop · ${container.name}`
                : `For each item · ${container.name}`,
            text: containerSubflow
              ? `Runs the saved workflow "${workflowName(containerSubflow)}" once, as it was when the run started.`
              : describeContainerRule(container, scope.topologicalOrder),
          },
        }
      : {}),
  };
}

/** How far apart two cards must be, side to side, to count as one before the other. */
const SIDEWAYS = 40;

/**
 * Cards whose flow runs right to left where they are placed (the back rows of a snaking
 * layout): where the next steps sit to their left, or, at the end of a row, where the
 * steps before them sit to their right.
 */
function runningLeft(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): Set<string> {
  const x = new Map(nodes.map((n) => [n.id, n.position.x]));
  const flow = edges.filter((e) => e.type === 'flow' && e.data.control);
  const sideways = (own: number, others: string[]) =>
    others.map((id) => x.get(id)).filter((o): o is number => o !== undefined && Math.abs(o - own) > SIDEWAYS);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const out = new Set<string>();
  for (const node of nodes) {
    const own = node.position.x;
    const next = sideways(own, flow.filter((e) => e.source === node.id).map((e) => e.target));
    const before = sideways(own, flow.filter((e) => e.target === node.id).map((e) => e.source));
    if (next.length > 0 ? mean(next) < own : before.length > 0 && mean(before) > own) out.add(node.id);
  }
  return out;
}

/**
 * Steps linked only by parameters still run in order, so the flow lines must show it: a
 * data link gets a plain flow line unless execution links (or other data links) already
 * lead from its source to its target. Loop-back links are left out.
 */
export function impliedFlowPairs(graph: Pick<WorkflowGraph, 'controlEdges' | 'dataEdges'>): [string, string][] {
  const next = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (from !== to) next.set(from, (next.get(from) ?? new Set()).add(to));
  };
  const controlled = new Set<string>();
  for (const e of graph.controlEdges) {
    if (e.loop) continue;
    link(e.fromNodeId, e.toNodeId);
    controlled.add(`${e.fromNodeId}->${e.toNodeId}`);
  }
  for (const e of graph.dataEdges) link(e.fromNodeId, e.toNodeId);
  /** Whether `to` is reachable from `from` without taking the direct step between them. */
  const reachableAround = (from: string, to: string) => {
    const seen = new Set<string>([from]);
    const stack = [...(next.get(from) ?? [])].filter((n) => n !== to);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    return false;
  };
  const pairs: [string, string][] = [];
  const done = new Set<string>();
  for (const e of graph.dataEdges) {
    const key = `${e.fromNodeId}->${e.toNodeId}`;
    if (e.fromNodeId === e.toNodeId || controlled.has(key) || done.has(key)) continue;
    done.add(key);
    if (!reachableAround(e.fromNodeId, e.toNodeId)) pairs.push([e.fromNodeId, e.toNodeId]);
  }
  return pairs;
}

function impliedFlowEdge(source: string, target: string, tone: EdgeTone): CanvasEdge {
  return {
    id: `$flow:${source}->${target}`,
    type: 'flow',
    source,
    target,
    sourceHandle: 'ctrl-out',
    targetHandle: 'ctrl-in',
    data: { tone, label: 'After success · uses its outputs', control: true },
  };
}

/** Summary pill for the top-right corner. */
export function describeRun(
  run: WorkflowRunState | null,
  runningCount: number
): { text: string; tone: Tone } {
  if (!run) return { text: 'Not run yet', tone: 'muted' };
  const pendingWaits = Object.values(run.waitRequests).filter((w) => w.status === 'PENDING').length;
  switch (run.status) {
    case 'SUCCEEDED':
      return { text: 'Succeeded', tone: 'ok' };
    case 'FAILED': {
      const failed = Object.values(run.scopes.$root?.nodes ?? {}).filter((n) => n.status === 'FAILED').length;
      return { text: `Failed · ${failed} node${failed === 1 ? '' : 's'}`, tone: 'danger' };
    }
    case 'WAITING':
      return { text: `${pendingWaits || 1} waiting for you`, tone: 'warn' };
    case 'CANCELLED':
      return { text: 'Stopped', tone: 'muted' };
    default:
      return { text: runningCount > 0 ? `Running · ${runningCount} active` : 'Running', tone: 'active' };
  }
}
