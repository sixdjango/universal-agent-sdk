import {
  type CompiledWorkflowPlan,
  compileWorkflowDefinition,
  type AgentRuntimeBinding,
  type EdgeCondition,
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
  PARALLEL_ITEM_PORTS,
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
  /** Loop containers: the rule, limits and rounds so far. */
  readonly loop?: LoopSummary;
  /**
   * Inside a loop body: `decider` is the step whose result starts another round (the loop-back
   * edge leaves from it), `start` is where each round begins (the edge arrives there).
   */
  readonly loopRole?: 'decider' | 'start';
  /** With `loopRole: 'decider'`: what makes it go round again, e.g. `NEEDS_FIX`. */
  readonly loopRepeat?: string;
}

export type EdgeTone = 'idle' | 'flowing' | 'delivered' | 'failed' | 'skipped';

export interface FlowEdgeData extends Record<string, unknown> {
  readonly tone: EdgeTone;
  readonly label?: string;
  readonly control: boolean;
  readonly selected?: boolean;
  readonly issue?: string;
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
  readonly data: FlowEdgeData;
}

export interface CanvasModel {
  readonly nodes: CanvasNode[];
  readonly edges: CanvasEdge[];
  /** Inside a loop or parallel step: what the container does with these steps. */
  readonly banner?: { readonly kind: 'loop' | 'parallel'; readonly title: string; readonly text: string };
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
  for (const e of graph.controlEdges) order(e.fromNodeId, e.toNodeId);
  for (const e of graph.dataEdges) order(e.fromNodeId, e.toNodeId);

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
export function autoLayout(scope: ScopeShape): Record<string, { x: number; y: number }> {
  const columns: string[][] = [[INPUTS_NODE_ID], ...scope.topologicalLevels.map((l) => [...l]), [OUTPUTS_NODE_ID]];
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
  switch (condition.kind) {
    case 'verdict_is':
      return `if ${condition.verdict}`;
    case 'verdict_in':
      return `if ${condition.verdicts.join(' / ')}`;
    case 'port_equals':
      return `if ${condition.port} = ${String(condition.value)}`;
    case 'port_truthy':
      return `if ${condition.port}`;
  }
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

/** Latest scope instance of a container (highest loop round / all parallel items). */
function containerScopes(run: WorkflowRunState, prefix: string): GraphScopeState[] {
  const scopes = Object.values(run.scopes).filter(
    (s) => s.scopeKey.startsWith(`${prefix}:`) || s.scopeKey.startsWith(`${prefix}[`)
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
  readonly layout?: Readonly<Record<string, { x: number; y: number }>>;
  readonly agentNames?: Readonly<Record<string, string>>;
  /** Each agent's default runtime (client, model, effort), keyed by agent id. */
  readonly agentRuntimes?: Readonly<Record<string, AgentRuntimeBinding>>;
  readonly editable?: boolean;
  readonly issues?: readonly WorkflowValidationIssue[];
  readonly selectedEdgeId?: string | null;
  /** Nested graph to show: container ids from the root (`[]` = root graph). */
  readonly path?: ScopePath;
  /** Run scope instance shown for `path` (e.g. `$root/fix_loop:round_1`); defaults to `$root`. */
  readonly scopeKey?: string;
}): CanvasModel {
  const { definition } = input;
  const path = input.path ?? [];
  const run = input.run && input.run.definitionDigest ? input.run : null;
  // Runs always carry a valid definition; drafts being edited may not compile yet.
  let compiledRunScope = run ? compilePlan(run.definition).rootScope : null;
  for (const id of path) compiledRunScope = compiledRunScope?.childScopes[id] ?? null;
  const scope: ScopeShape = compiledRunScope ?? describeScope(definition, path);
  const container = containerAt(definition, path);
  const scopeKey = input.scopeKey ?? '$root';
  // Inside a loop body: its rule, to mark the deciding step and draw the way back round.
  const bodyLoop = container?.kind === 'loop' ? describeLoop(container, scope.topologicalOrder) : undefined;
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

  // Inputs (left) and outputs (right) are cards too: the workflow's at the root, the
  // container's own ports inside a loop body or parallel item.
  const inputPorts = container
    ? [...(container.kind === 'parallel' ? PARALLEL_ITEM_PORTS : []), ...container.inputs]
    : definition.inputs;
  const outputPorts = container ? container.outputs : definition.outputs;
  const fields = (n: number) => `${n} field${n === 1 ? '' : 's'}`;
  nodes.push({
    id: INPUTS_NODE_ID,
    type: 'card',
    position: positions[INPUTS_NODE_ID]!,
    data: {
      nodeId: INPUTS_NODE_ID,
      kind: 'inputs',
      title: !container ? 'Inputs' : container.kind === 'loop' ? 'Each round gets' : 'Each item gets',
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
    const node = scope.nodesById[nodeId]!;
    const nodeState = rootState?.nodes[nodeId];
    const status = statusOf(nodeId);
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
    } else {
      const childScope = scope.childScopes[nodeId]!;
      const instances = run ? containerScopes(run, `${scopeKey}/${nodeId}`) : [];
      rows.push({
        id: 'open',
        label: 'steps',
        value: `${childScope.topologicalOrder.length} inside`,
        kind: 'open',
        tone: 'default',
      });
      if (node.kind === 'loop') {
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
        const childStatus = run ? viewStatus(child, false) : 'idle';
        const shownStatus = childRunning && childStatus === 'pending' ? 'pending' : childStatus;
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

    for (const port of node.inputs) {
      rows.push({
        id: `in-${port.name}`,
        label: port.name,
        value: port.type,
        kind: 'input',
        handle: { type: 'target', id: `in:${port.name}` },
        tone: 'muted',
      });
    }
    for (const port of node.outputs) {
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

    rows.push(...addRows(nodeId, { in: '+ input', out: '+ output' }));

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
        kind: node.kind,
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
        ...(bodyLoop?.deciderId === nodeId ? { loopRole: 'decider' as const, loopRepeat: bodyLoop.repeatLabel } : {}),
        order: columnOf(nodeId),
        // Reruns restart from the top-level graph; inside a round/item they would need its scope.
        rerunnable: settled && path.length === 0 && (nodeState?.status === 'SUCCEEDED' || nodeState?.status === 'FAILED'),
        editable,
        ...(nodeIssues.has(nodeId) ? { issue: nodeIssues.get(nodeId)!.join('\n') } : {}),
      },
    });
  }

  nodes.push({
    id: OUTPUTS_NODE_ID,
    type: 'card',
    position: positions[OUTPUTS_NODE_ID]!,
    data: {
      nodeId: OUTPUTS_NODE_ID,
      kind: 'outputs',
      title: !container ? 'Outputs' : container.kind === 'loop' ? 'Loop result' : 'Item result',
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

  const edgeTone = (from: string, to: string): EdgeTone => {
    if (!run) return 'idle';
    const target = statusOf(to);
    const source = statusOf(from);
    if (target === 'skipped' || source === 'skipped' || target === 'unreached') return 'skipped';
    if (target === 'failed') return 'failed';
    if (target === 'running' || target === 'waiting') return 'flowing';
    if (source === 'succeeded' && (target === 'succeeded' || to === OUTPUTS_NODE_ID)) return 'delivered';
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
  const dataPairs = new Set<string>();
  for (const edge of graphAt(definition, path).dataEdges) {
    dataPairs.add(`${edge.fromNodeId}->${edge.toNodeId}`);
    edges.push({
      id: edge.id,
      type: 'flow',
      source: edge.fromNodeId,
      target: edge.toNodeId,
      sourceHandle: `out:${edge.fromPort}`,
      targetHandle: `in:${edge.toPort}`,
      data: {
        tone: edgeTone(edge.fromNodeId, edge.toNodeId),
        label: deliveredLabel(edge.fromNodeId, edge.fromPort, edge.toNodeId, edge.toPort),
        control: false,
        selected: input.selectedEdgeId === edge.id,
        ...(edgeIssues.has(edge.id) ? { issue: edgeIssues.get(edge.id)!.join('\n') } : {}),
      },
    });
  }
  for (const edge of graphAt(definition, path).controlEdges) {
    const condition = describeCondition(edge.when);
    // Plain ordering edges are implied by a data edge between the same nodes.
    if (!condition && dataPairs.has(`${edge.fromNodeId}->${edge.toNodeId}`)) continue;
    edges.push({
      id: edge.id,
      type: 'flow',
      source: edge.fromNodeId,
      target: edge.toNodeId,
      sourceHandle: 'ctrl-out',
      targetHandle: 'ctrl-in',
      data: {
        tone: edgeTone(edge.fromNodeId, edge.toNodeId),
        ...(condition ? { label: condition } : {}),
        control: true,
        selected: input.selectedEdgeId === edge.id,
        ...(edgeIssues.has(edge.id) ? { issue: edgeIssues.get(edge.id)!.join('\n') } : {}),
      },
    });
  }

  if (container && bodyLoop?.deciderId && scope.nodesById[bodyLoop.deciderId]) {
    // The way back round: from the deciding step to where the next round starts.
    const looped = run ? Object.keys(run.scopes).some((k) => k.startsWith(`${scopeKey.replace(/:round_\d+$/, '')}:round_1`)) : false;
    edges.push({
      id: '$loop-back',
      type: 'loop',
      source: bodyLoop.deciderId,
      target: INPUTS_NODE_ID,
      sourceHandle: 'loop-out',
      targetHandle: 'loop-in',
      data: {
        tone: looped ? 'delivered' : 'idle',
        label: `${bodyLoop.repeatLabel} → next round · up to ${bodyLoop.maxRounds}`,
        control: true,
      },
    });
  }

  return {
    nodes,
    edges,
    ...(container
      ? {
          banner: {
            kind: container.kind,
            title: container.kind === 'loop' ? `Loop · ${container.name}` : `For each item · ${container.name}`,
            text: describeContainerRule(container, scope.topologicalOrder),
          },
        }
      : {}),
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
    default:
      return { text: runningCount > 0 ? `Running · ${runningCount} active` : 'Running', tone: 'active' };
  }
}
