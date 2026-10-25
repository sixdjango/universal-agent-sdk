import type {
  ChiefPolicy,
  ControlEdge,
  DataEdge,
  EdgeCondition,
  PortDefinition,
  PortValueType,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowNode,
} from '@universal-agent/workflow-contract';
import { ChiefPolicySchema, nodeParallel } from '@universal-agent/workflow-contract';
import {
  containerAt,
  graphAt,
  INPUTS_NODE_ID,
  mapGraphAt,
  OUTPUTS_NODE_ID,
  PARALLEL_ITEM_PORTS,
  type ScopePath,
} from './scope';

/**
 * Pure, immutable edits on a workflow definition. Every function works on the graph at
 * `path` (root by default), so loop bodies and parallel item graphs edit exactly like the
 * root. Each returns a new definition (or an error) so the editor keeps an undo history.
 * Validity is not enforced here; the contract compiler reports issues on the whole draft.
 */

export type NewNodeKind = 'agent' | 'script' | 'gate' | 'subflow' | 'loop' | 'parallel';
/** Canvas side of a port: `in` rows accept edges (left handle), `out` rows emit them (right). */
export type PortSide = 'in' | 'out';

export type EditResult<T = object> = ({ ok: true; definition: WorkflowDefinition } & T) | { ok: false; error: string };

export const NEW_PORT_HANDLE = '+';

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'item'
  );
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
  }
}

function allEdgeIds(graph: WorkflowGraph): string[] {
  return [...graph.controlEdges.map((e) => e.id), ...graph.dataEdges.map((e) => e.id)];
}

function patchGraph(definition: WorkflowDefinition, path: ScopePath, patch: Partial<WorkflowGraph>): WorkflowDefinition {
  return mapGraphAt(definition, path, (graph) => ({ ...graph, ...patch }));
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export function createBlankWorkflow(name: string, takenIds: Iterable<string>): WorkflowDefinition {
  return {
    id: uniqueName(slug(name).replace(/_/g, '-'), takenIds),
    version: '1.0.0',
    name,
    inputs: [{ name: 'request', type: 'string', required: true }],
    outputs: [],
    graph: { nodes: [], controlEdges: [], dataEdges: [] },
    workspaces: [],
    // Supervised by the default chief unless turned off.
    chief: ChiefPolicySchema.parse({}),
  };
}

export function updateWorkflowMeta(
  definition: WorkflowDefinition,
  patch: { name?: string; description?: string; chief?: ChiefPolicy | null }
): WorkflowDefinition {
  const next: WorkflowDefinition = { ...definition };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) {
    if (patch.description) next.description = patch.description;
    else delete next.description;
  }
  if (patch.chief !== undefined) {
    if (patch.chief) next.chief = patch.chief;
    else delete next.chief;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const BASE = { writeScopes: [] as string[], maxTechnicalRetries: 0 };

function agentTemplate(id: string, name: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    ...BASE,
    kind: 'agent',
    id,
    name,
    role: 'worker',
    goal: 'Describe what this agent should do',
    acceptanceCriteria: [],
    constraints: [],
    producesAssessment: false,
    readWorkspaces: [],
    inputs: [],
    outputs: [{ name: 'result', type: 'artifact', required: true }],
    ...extra,
  } as WorkflowNode;
}

/**
 * Starter loop: an author writes, an independent reviewer judges, and the loop repeats
 * while the review says NEEDS_FIX. The author's result becomes the loop's result.
 */
function loopTemplate(id: string): WorkflowNode {
  return {
    ...BASE,
    kind: 'loop',
    id,
    name: 'Fix until it passes',
    maxRounds: 3,
    onExhausted: 'fail',
    continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'review' },
    inputs: [],
    outputs: [{ name: 'result', type: 'artifact', required: true }],
    bodyGraph: {
      nodes: [
        agentTemplate('author', 'Write the change'),
        agentTemplate('review', 'Review the change', {
          producesAssessment: true,
          inputs: [{ name: 'result', type: 'artifact', required: true }],
          outputs: [],
        } as Partial<WorkflowNode>),
      ],
      controlEdges: [{ id: 'ctrl_author_to_review', fromNodeId: 'author', toNodeId: 'review' }],
      dataEdges: [
        { id: 'data_author.result_to_review.result', fromNodeId: 'author', fromPort: 'result', toNodeId: 'review', toPort: 'result', required: true, delivery: 'auto' },
        { id: 'data_author.result_to_$output.result', fromNodeId: 'author', fromPort: 'result', toNodeId: OUTPUTS_NODE_ID, toPort: 'result', required: true, delivery: 'auto' },
      ],
    },
  };
}

/** Starter parallel step: one worker per item, results collected into an array. */
function parallelTemplate(id: string): WorkflowNode {
  return {
    ...BASE,
    kind: 'parallel',
    id,
    name: 'For each item',
    itemsPort: 'items',
    maxConcurrency: 4,
    failurePolicy: 'settle_all',
    inputs: [{ name: 'items', type: 'array', required: true }],
    outputs: [{ name: 'results', type: 'array', required: true }],
    itemGraph: {
      nodes: [agentTemplate('worker', 'Handle one item', { inputs: [{ name: 'item', type: 'json', required: true }] } as Partial<WorkflowNode>)],
      controlEdges: [],
      dataEdges: [
        { id: 'data_$input.items_to_worker.item', fromNodeId: INPUTS_NODE_ID, fromPort: 'items', toNodeId: 'worker', toPort: 'item', required: true, delivery: 'auto' },
        { id: 'data_worker.result_to_$output.results', fromNodeId: 'worker', fromPort: 'result', toNodeId: OUTPUTS_NODE_ID, toPort: 'results', required: true, delivery: 'auto' },
      ],
    },
  };
}

export function addNode(
  definition: WorkflowDefinition,
  kind: NewNodeKind,
  options: { agentRef?: string } = {},
  path: ScopePath = []
): EditResult<{ nodeId: string }> {
  const taken = graphAt(definition, path).nodes.map((n) => n.id);
  let node: WorkflowNode;
  if (kind === 'agent') {
    node = agentTemplate(uniqueName('agent', taken), 'New agent task', options.agentRef ? { agentRef: options.agentRef } : {});
  } else if (kind === 'script') {
    node = {
      ...BASE,
      kind: 'script',
      id: uniqueName('script', taken),
      name: 'Run tests',
      command: 'npm',
      args: ['test'],
      timeoutMs: 60_000,
      producesAssessment: true,
      inputs: [],
      outputs: [{ name: 'report', type: 'json', required: true }],
    };
  } else if (kind === 'gate') {
    node = {
      ...BASE,
      kind: 'gate',
      id: uniqueName('gate', taken),
      name: 'Approve?',
      prompt: 'Approve and continue?',
      options: [
        { value: 'approve', label: 'Approve' },
        { value: 'reject', label: 'Reject' },
      ],
      inputs: [],
      outputs: [{ name: 'decision', type: 'string', required: true }],
    };
  } else if (kind === 'subflow') {
    node = { ...BASE, kind: 'subflow', id: uniqueName('subflow', taken), name: 'Sub-flow', inputs: [], outputs: [] };
  } else if (kind === 'loop') {
    node = loopTemplate(uniqueName('loop', taken));
  } else {
    node = parallelTemplate(uniqueName('parallel', taken));
  }
  return {
    ok: true,
    nodeId: node.id,
    definition: mapGraphAt(definition, path, (g) => ({ ...g, nodes: [...g.nodes, node] })),
  };
}

/**
 * Points sub-flow step `nodeId` at the saved workflow `child`: it takes the child's inputs
 * and outputs as its own (and its name, while it still has the default), and edges to
 * fields the child does not have are removed.
 */
export function setSubflowWorkflow(
  definition: WorkflowDefinition,
  nodeId: string,
  child: Pick<WorkflowDefinition, 'id' | 'name' | 'inputs' | 'outputs'>,
  path: ScopePath = []
): WorkflowDefinition {
  const ins = new Set(child.inputs.map((p) => p.name));
  const outs = new Set(child.outputs.map((p) => p.name));
  return mapGraphAt(definition, path, (graph) => ({
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId && n.kind === 'subflow'
        ? {
            ...n,
            workflowId: child.id,
            name: n.name === 'Sub-flow' ? child.name : n.name,
            inputs: child.inputs.map((p) => ({ ...p })),
            outputs: child.outputs.map((p) => ({ ...p })),
          }
        : n
    ),
    dataEdges: graph.dataEdges.filter(
      (e) => !(e.toNodeId === nodeId && !ins.has(e.toPort)) && !(e.fromNodeId === nodeId && !outs.has(e.fromPort))
    ),
  }));
}

/** Shallow-merges `patch` into a node at `path`; `id` and `kind` cannot change. */
export function updateNode(
  definition: WorkflowDefinition,
  nodeId: string,
  patch: Record<string, unknown>,
  path: ScopePath = []
): WorkflowDefinition {
  const { id: _id, kind: _kind, ...rest } = patch;
  return mapGraphAt(definition, path, (graph) => ({
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const next = { ...n, ...rest } as Record<string, unknown>;
      // Optional fields set to undefined/'' are removed rather than stored as empty.
      for (const [key, value] of Object.entries(rest)) {
        if (value === undefined || value === '') delete next[key];
      }
      return next as unknown as WorkflowNode;
    }),
  }));
}

export function removeNode(definition: WorkflowDefinition, nodeId: string, path: ScopePath = []): WorkflowDefinition {
  return mapGraphAt(definition, path, (graph) => ({
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    controlEdges: graph.controlEdges.filter((e) => e.fromNodeId !== nodeId && e.toNodeId !== nodeId),
    dataEdges: graph.dataEdges.filter((e) => e.fromNodeId !== nodeId && e.toNodeId !== nodeId),
  }));
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * A container's ports show up twice: on its card in the parent graph and as the Inputs /
 * Outputs cards inside its body. This maps one view to the other.
 */
function mirrorOf(
  definition: WorkflowDefinition,
  nodeId: string,
  side: PortSide,
  path: ScopePath
): { nodeId: string; side: PortSide; path: ScopePath } | null {
  if ((nodeId === INPUTS_NODE_ID || nodeId === OUTPUTS_NODE_ID) && path.length > 0) {
    return { nodeId: path[path.length - 1]!, side: nodeId === INPUTS_NODE_ID ? 'in' : 'out', path: path.slice(0, -1) };
  }
  const node = graphAt(definition, path).nodes.find((n) => n.id === nodeId);
  if (node?.kind === 'loop' || node?.kind === 'parallel') {
    return side === 'in'
      ? { nodeId: INPUTS_NODE_ID, side: 'out', path: [...path, nodeId] }
      : { nodeId: OUTPUTS_NODE_ID, side: 'in', path: [...path, nodeId] };
  }
  return null;
}

/** Built-in fields of the scope at `path` (a parallel item's `itemIndex`). */
export function implicitPorts(definition: WorkflowDefinition, nodeId: string, side: PortSide, path: ScopePath): readonly PortDefinition[] {
  if (nodeId !== INPUTS_NODE_ID || side !== 'out' || path.length === 0) return [];
  return containerAt(definition, path)?.kind === 'parallel' ? PARALLEL_ITEM_PORTS : [];
}

/** Declared ports shown on the given side of a card (without built-in ones). */
function declaredPorts(definition: WorkflowDefinition, nodeId: string, side: PortSide, path: ScopePath): readonly PortDefinition[] {
  if (nodeId === INPUTS_NODE_ID || nodeId === OUTPUTS_NODE_ID) {
    const isInputs = nodeId === INPUTS_NODE_ID;
    if (side !== (isInputs ? 'out' : 'in')) return [];
    const container = containerAt(definition, path);
    if (!container) return isInputs ? definition.inputs : definition.outputs;
    return isInputs ? container.inputs : container.outputs;
  }
  const node = graphAt(definition, path).nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return side === 'in' ? node.inputs : node.outputs;
}

/** Every port on the given side of a card, built-in fields first. */
export function portsOf(definition: WorkflowDefinition, nodeId: string, side: PortSide, path: ScopePath = []): readonly PortDefinition[] {
  return [...implicitPorts(definition, nodeId, side, path), ...declaredPorts(definition, nodeId, side, path)];
}

function setPorts(definition: WorkflowDefinition, nodeId: string, side: PortSide, ports: PortDefinition[], path: ScopePath): WorkflowDefinition {
  if (nodeId === INPUTS_NODE_ID || nodeId === OUTPUTS_NODE_ID) {
    const isInputs = nodeId === INPUTS_NODE_ID;
    if (path.length === 0) return isInputs ? { ...definition, inputs: ports } : { ...definition, outputs: ports };
    return updateNode(definition, path[path.length - 1]!, isInputs ? { inputs: ports } : { outputs: ports }, path.slice(0, -1));
  }
  return updateNode(definition, nodeId, side === 'in' ? { inputs: ports } : { outputs: ports }, path);
}

/** Applies `fn` to the edges attached to one port, in its graph and in its mirror graph. */
function mapPortEdges(
  definition: WorkflowDefinition,
  nodeId: string,
  side: PortSide,
  name: string,
  path: ScopePath,
  fn: (edge: DataEdge, end: 'from' | 'to') => DataEdge | null
): WorkflowDefinition {
  const views = [{ nodeId, side, path }, ...[mirrorOf(definition, nodeId, side, path)].filter((v) => v !== null)];
  let next = definition;
  for (const view of views) {
    next = mapGraphAt(next, view.path, (graph) => ({
      ...graph,
      dataEdges: graph.dataEdges.flatMap((e) => {
        const attached =
          view.side === 'out'
            ? e.fromNodeId === view.nodeId && e.fromPort === name && 'from'
            : e.toNodeId === view.nodeId && e.toPort === name && 'to';
        if (!attached) return [e];
        const mapped = fn(e, attached);
        return mapped ? [mapped] : [];
      }),
    }));
  }
  return next;
}

export function addPort(
  definition: WorkflowDefinition,
  nodeId: string,
  side: PortSide,
  port: { name: string; type?: PortValueType; required?: boolean },
  path: ScopePath = []
): EditResult<{ portName: string }> {
  if ((nodeId === INPUTS_NODE_ID && side === 'in') || (nodeId === OUTPUTS_NODE_ID && side === 'out')) {
    return { ok: false, error: 'Inputs only send data and outputs only receive it' };
  }
  const existing = portsOf(definition, nodeId, side, path);
  const name = uniqueName(slug(port.name), existing.map((p) => p.name));
  const next: PortDefinition = { name, type: port.type ?? 'json', required: port.required ?? true };
  return {
    ok: true,
    portName: name,
    definition: setPorts(definition, nodeId, side, [...declaredPorts(definition, nodeId, side, path), next], path),
  };
}

/** Renames or retypes a port, keeping every edge attached to it (on both sides of a container). */
export function updatePort(
  definition: WorkflowDefinition,
  nodeId: string,
  side: PortSide,
  name: string,
  patch: { name?: string; type?: PortValueType; required?: boolean },
  path: ScopePath = []
): EditResult {
  if (implicitPorts(definition, nodeId, side, path).some((p) => p.name === name)) {
    return { ok: false, error: `"${name}" is built in and cannot be changed` };
  }
  const existing = portsOf(definition, nodeId, side, path);
  const newName = patch.name !== undefined ? slug(patch.name) : name;
  if (newName !== name && existing.some((p) => p.name === newName)) {
    return { ok: false, error: `Port "${newName}" already exists` };
  }
  let next = setPorts(
    definition,
    nodeId,
    side,
    declaredPorts(definition, nodeId, side, path).map((p) => (p.name === name ? { ...p, ...patch, name: newName } : p)),
    path
  );
  if (newName !== name) {
    next = mapPortEdges(next, nodeId, side, name, path, (e, end) => (end === 'from' ? { ...e, fromPort: newName } : { ...e, toPort: newName }));
    // A parallel step's list input is referenced by name.
    const container = side === 'in' ? graphAt(next, path).nodes.find((n) => n.id === nodeId) : undefined;
    const parallel = container && nodeParallel(container);
    if (parallel?.itemsPort === name) next = updateNode(next, nodeId, { parallel: { ...parallel, itemsPort: newName } }, path);
    const mirror = mirrorOf(definition, nodeId, side, path);
    const owner = container?.kind === 'parallel' ? { id: nodeId, path } : nodeId === INPUTS_NODE_ID && mirror ? { id: mirror.nodeId, path: mirror.path } : null;
    if (owner) {
      const node = graphAt(next, owner.path).nodes.find((n) => n.id === owner.id);
      if (node?.kind === 'parallel' && node.itemsPort === name) next = updateNode(next, owner.id, { itemsPort: newName }, owner.path);
    }
  }
  return { ok: true, definition: next };
}

export function removePort(definition: WorkflowDefinition, nodeId: string, side: PortSide, name: string, path: ScopePath = []): WorkflowDefinition {
  if (implicitPorts(definition, nodeId, side, path).some((p) => p.name === name)) return definition;
  const next = setPorts(
    definition,
    nodeId,
    side,
    declaredPorts(definition, nodeId, side, path).filter((p) => p.name !== name),
    path
  );
  return mapPortEdges(next, nodeId, side, name, path, () => null);
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** One existing forward execution path, excluding loop-back edges. */
export function findExecutionPath(graph: WorkflowGraph, from: string, to: string): ControlEdge[] | undefined {
  const seen = new Set<string>([from]);
  const queue: { nodeId: string; path: ControlEdge[] }[] = [{ nodeId: from, path: [] }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.nodeId === to) return current.path;
    for (const edge of graph.controlEdges) {
      // A loop's way back does not order steps.
      if (edge.fromNodeId === current.nodeId && !edge.loop && !seen.has(edge.toNodeId)) {
        seen.add(edge.toNodeId);
        queue.push({ nodeId: edge.toNodeId, path: [...current.path, edge] });
      }
    }
  }
  return undefined;
}

const controlReachable = (graph: WorkflowGraph, from: string, to: string) => !!findExecutionPath(graph, from, to);

export interface CanvasConnection {
  readonly source: string;
  readonly sourceHandle: string | null;
  readonly target: string;
  readonly targetHandle: string | null;
}

/** Quick check for React Flow's `isValidConnection` (the full rules live in `connect`). */
export function isPlausibleConnection(connection: CanvasConnection): boolean {
  const control = connection.sourceHandle === 'ctrl-out' && connection.targetHandle === 'ctrl-in';
  const parameters = !!connection.sourceHandle?.startsWith('out:') && !!connection.targetHandle?.startsWith('in:');
  return (
    // Execution from a step back to itself repeats it (a loop of one step).
    (connection.source !== connection.target || control) &&
    connection.target !== INPUTS_NODE_ID &&
    connection.source !== OUTPUTS_NODE_ID &&
    (parameters || (control && connection.source !== INPUTS_NODE_ID && connection.target !== OUTPUTS_NODE_ID))
  );
}

/**
 * Turns a drag on the canvas into graph edges in the graph at `path`:
 * - header connector to header connector: a control (ordering) edge;
 * - port to port: a data edge, plus an execution dependency when the target
 *   is not already ordered after the source;
 * - dropping on a "+" parameter row creates the missing port, named after the
 *   port on the other end.
 */
export function connect(
  definition: WorkflowDefinition,
  connection: CanvasConnection,
  path: ScopePath = []
): EditResult<{ edgeIds: string[]; message: string; addedControlEdgeId?: string }> {
  if (!isPlausibleConnection(connection)) return { ok: false, error: 'Connect execution to execution, or an output parameter to an input parameter. These points cannot be mixed.' };
  const { source, target } = connection;
  const sourceHandle = connection.sourceHandle!;
  const targetHandle = connection.targetHandle!;
  const endpoint = (id: string) => id === INPUTS_NODE_ID || id === OUTPUTS_NODE_ID;

  if (sourceHandle === 'ctrl-out') {
    if (endpoint(source) || endpoint(target)) {
      return { ok: false, error: 'Inputs and outputs connect through their fields' };
    }
    const graph = graphAt(definition, path);
    if (graph.controlEdges.some((e) => e.fromNodeId === source && e.toNodeId === target)) {
      return { ok: false, error: 'These steps are already ordered' };
    }
    const fromNode = graph.nodes.find((n) => n.id === source);
    if (source === target || controlReachable(graph, target, source)) {
      // Back to a step that leads here (or to itself): the way back of a loop, decided by this step's result.
      if (graph.controlEdges.some((e) => e.fromNodeId === source && e.loop)) {
        return { ok: false, error: `"${fromNode?.name ?? source}" already loops back; a step closes one loop` };
      }
      const id = uniqueName(`loop_${source}_to_${target}`, allEdgeIds(graph));
      const edge: ControlEdge = {
        id,
        fromNodeId: source,
        toNodeId: target,
        when: { kind: 'verdict_is', verdict: 'NEEDS_FIX' },
        loop: { maxRounds: 3, onExhausted: 'fail' },
      };
      return { ok: true, edgeIds: [id], message: 'Loop-back execution connected. Parameters are unchanged.', definition: patchGraph(definition, path, { controlEdges: [...graph.controlEdges, edge] }) };
    }
    const id = uniqueName(`ctrl_${source}_to_${target}`, allEdgeIds(graph));
    const edge: ControlEdge = { id, fromNodeId: source, toNodeId: target };
    return { ok: true, edgeIds: [id], message: 'Execution dependency added. This connection does not pass parameters.', definition: patchGraph(definition, path, { controlEdges: [...graph.controlEdges, edge] }) };
  }

  let next = definition;
  let fromPort = sourceHandle.startsWith('out:') ? sourceHandle.slice(4) : '';
  let toPort = targetHandle.startsWith('in:') ? targetHandle.slice(3) : NEW_PORT_HANDLE;
  if (!fromPort) return { ok: false, error: 'Start the connection from an output field' };
  if (fromPort === NEW_PORT_HANDLE && toPort === NEW_PORT_HANDLE) {
    return { ok: false, error: 'Connect at least one existing field' };
  }

  if (fromPort === NEW_PORT_HANDLE) {
    const counterpart = portsOf(next, target, 'in', path).find((p) => p.name === toPort);
    const added = addPort(next, source, 'out', { name: toPort, ...(counterpart ? { type: counterpart.type } : {}) }, path);
    if (!added.ok) return added;
    next = added.definition;
    fromPort = added.portName;
  }
  if (toPort === NEW_PORT_HANDLE) {
    const counterpart = portsOf(next, source, 'out', path).find((p) => p.name === fromPort);
    const added = addPort(next, target, 'in', { name: fromPort, ...(counterpart ? { type: counterpart.type } : {}) }, path);
    if (!added.ok) return added;
    next = added.definition;
    toPort = added.portName;
  }

  const graph = graphAt(next, path);
  if (graph.dataEdges.some((e) => e.toNodeId === target && e.toPort === toPort)) {
    return { ok: false, error: `"${toPort}" already receives data; remove that connection first` };
  }

  const ids = allEdgeIds(graph);
  const dataId = uniqueName(`data_${source}.${fromPort}_to_${target}.${toPort}`, ids);
  // Wired back to an earlier step (inside a loop): the value of the previous round, absent
  // in the first one, so it never orders the steps and is not required.
  const backwards = !endpoint(source) && !endpoint(target) && controlReachable(graph, target, source);
  const dataEdge: DataEdge = {
    id: dataId,
    fromNodeId: source,
    fromPort,
    toNodeId: target,
    toPort,
    required: !backwards,
    delivery: 'auto',
  };
  const edgeIds = [dataId];
  let controlEdges = graph.controlEdges;
  let addedControlEdgeId: string | undefined;
  if (backwards) {
    next = updatePortRequired(next, target, toPort, path);
  } else if (!endpoint(source) && !endpoint(target) && !controlReachable(graph, source, target)) {
    const controlId = uniqueName(`ctrl_${source}_to_${target}`, [...ids, dataId]);
    controlEdges = [...controlEdges, { id: controlId, fromNodeId: source, toNodeId: target }];
    edgeIds.push(controlId);
    addedControlEdgeId = controlId;
  }
  const name = (id: string) => graph.nodes.find(node => node.id === id)?.name ?? id;
  return {
    ok: true,
    edgeIds,
    ...(addedControlEdgeId ? { addedControlEdgeId } : {}),
    message: addedControlEdgeId
      ? `Parameter connected. Also added execution dependency: ${name(source)} → ${name(target)} (after success). Both lines are shown.`
      : backwards ? 'Previous-round parameter connected. No forward execution dependency was added.'
        : endpoint(source) || endpoint(target) ? 'Parameter connected to the workflow boundary. No execution dependency was added.'
          : 'Parameter connected. The existing execution path and its branch conditions are unchanged.',
    definition: patchGraph(next, path, { dataEdges: [...graph.dataEdges, dataEdge], controlEdges }),
  };
}

/** Marks an input port optional (values carried from a previous round are absent in the first). */
function updatePortRequired(definition: WorkflowDefinition, nodeId: string, port: string, path: ScopePath): WorkflowDefinition {
  return mapGraphAt(definition, path, (graph) => ({
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId ? ({ ...n, inputs: n.inputs.map((p) => (p.name === port ? { ...p, required: false } : p)) } as WorkflowNode) : n
    ),
  }));
}

export function removeEdge(definition: WorkflowDefinition, edgeId: string, path: ScopePath = []): WorkflowDefinition {
  return mapGraphAt(definition, path, (graph) => ({
    ...graph,
    controlEdges: graph.controlEdges.filter((e) => e.id !== edgeId),
    dataEdges: graph.dataEdges.filter((e) => e.id !== edgeId),
  }));
}

export function setEdgeCondition(
  definition: WorkflowDefinition,
  edgeId: string,
  when: EdgeCondition | undefined,
  path: ScopePath = []
): WorkflowDefinition {
  return mapGraphAt(definition, path, (graph) => ({
    ...graph,
    controlEdges: graph.controlEdges.map((e) => {
      if (e.id !== edgeId) return e;
      const { when: _old, ...rest } = e;
      return when && when.kind !== 'always' ? { ...rest, when } : rest;
    }),
  }));
}

/** The control edge drawn for a pair, or the hidden one paired with a data edge. */
/** Changes a control edge's loop settings (way back): round limit and what happens after it. */
export function updateLoopBack(
  definition: WorkflowDefinition,
  edgeId: string,
  patch: Partial<NonNullable<ControlEdge['loop']>>,
  path: ScopePath = []
): WorkflowDefinition {
  return mapGraphAt(definition, path, (graph) => ({
    ...graph,
    controlEdges: graph.controlEdges.map((e) =>
      e.id === edgeId && e.loop ? { ...e, loop: { ...e.loop, ...patch } } : e
    ),
  }));
}

export function findControlEdge(definition: WorkflowDefinition, edgeId: string, path: ScopePath = []): ControlEdge | undefined {
  const graph = graphAt(definition, path);
  const direct = graph.controlEdges.find((e) => e.id === edgeId);
  if (direct) return direct;
  const data = graph.dataEdges.find((e) => e.id === edgeId);
  return data ? graph.controlEdges.find((e) => e.fromNodeId === data.fromNodeId && e.toNodeId === data.toNodeId) : undefined;
}
