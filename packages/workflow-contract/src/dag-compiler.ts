import { parseAgentRef } from './agent';
import { computeDefinitionDigest } from './canonical';
import {
  type ControlEdge,
  type DataEdge,
  defaultWorkspaceSlot,
  listWorkspaceSlots,
  type PortDefinition,
  type WorkflowDefinition,
  type WorkspaceIsolationMode,
  WorkflowDefinitionSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from './schema';

export type WorkflowValidationErrorCode =
  | 'INVALID_SCHEMA'
  | 'EMPTY_GRAPH'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'UNKNOWN_NODE_REF'
  | 'SELF_LOOP_EDGE'
  | 'CYCLE_DETECTED'
  | 'UNKNOWN_PORT_REF'
  | 'MISSING_REQUIRED_INPUT_BINDING'
  | 'DATA_EDGE_ORDER_VIOLATION'
  | 'INVALID_AGENT_REF'
  | 'UNKNOWN_WORKSPACE_SLOT';

export interface WorkflowValidationIssue {
  code: WorkflowValidationErrorCode;
  message: string;
  scopePath: string;
  nodeId?: string;
  edgeId?: string;
}

export class WorkflowCompilationError extends Error {
  readonly issues: readonly WorkflowValidationIssue[];

  constructor(issues: readonly WorkflowValidationIssue[]) {
    super(
      `Workflow compilation failed with ${issues.length} issue(s): ${issues
        .map((i) => `[${i.code}@${i.scopePath}] ${i.message}`)
        .join('; ')}`
    );
    this.name = 'WorkflowCompilationError';
    this.issues = issues;
  }
}

export interface CompiledGraphScope {
  readonly scopePath: string;
  readonly nodesById: Readonly<Record<string, WorkflowNode>>;
  readonly topologicalOrder: readonly string[];
  readonly topologicalLevels: readonly (readonly string[])[];
  readonly incomingControlEdges: Readonly<Record<string, readonly ControlEdge[]>>;
  readonly outgoingControlEdges: Readonly<Record<string, readonly ControlEdge[]>>;
  readonly incomingDataEdges: Readonly<Record<string, readonly DataEdge[]>>;
  readonly outgoingDataEdges: Readonly<Record<string, readonly DataEdge[]>>;
  /** Workspace slot each node works in, after inheriting from containers and the workflow default. */
  readonly workspaceSlots: Readonly<Record<string, string>>;
  /**
   * How each agent/script node may write: `isolated` when it should work in its own copy of
   * the workspace (it may run alongside other writers in the same slot), and whether writes
   * outside its `writeScopes` fail it.
   */
  readonly writePolicies: Readonly<Record<string, WritePolicy>>;
  /** Map from nodeId to the sibling nodeIds in the same workspace slot with overlapping writeScopes. */
  readonly writeScopeConflicts: Readonly<Record<string, readonly string[]>>;
  /** Nested compiled scopes for loop or parallel container nodes, keyed by nodeId. */
  readonly childScopes: Readonly<Record<string, CompiledGraphScope>>;
}

export interface CompiledWorkflowPlan {
  readonly definition: WorkflowDefinition;
  readonly definitionDigest: string;
  readonly rootScope: CompiledGraphScope;
}

function writeScopesOverlap(scopeA: string, scopeB: string): boolean {
  const normA = scopeA.replace(/\\/g, '/').replace(/\/+$/, '');
  const normB = scopeB.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normA || !normB) return false;
  if (normA === '*' || normB === '*' || normA === '.' || normB === '.') return true;
  if (normA === normB) return true;
  return normA.startsWith(`${normB}/`) || normB.startsWith(`${normA}/`);
}

function hasAnyWriteScopeOverlap(
  scopesA: readonly string[],
  scopesB: readonly string[]
): boolean {
  for (const a of scopesA) {
    for (const b of scopesB) {
      if (writeScopesOverlap(a, b)) return true;
    }
  }
  return false;
}

export interface WritePolicy {
  readonly isolated: boolean;
  readonly enforceWriteScopes: boolean;
}

interface WorkspaceSlotContext {
  readonly declared: ReadonlySet<string>;
  /** Slot inherited by nodes of this scope that do not name one. */
  readonly inherited: string;
  /** Isolation mode inherited by nodes that do not set one. */
  readonly isolation: WorkspaceIsolationMode;
  readonly enforceWriteScopes: boolean;
  /** The whole scope may run alongside other writers (parallel items, concurrent containers). */
  readonly concurrent: boolean;
}

/** Whether a node (or anything inside a container) can change files. */
function nodeWrites(node: WorkflowNode): boolean {
  if (node.kind === 'agent' || node.kind === 'script') return node.writeScopes.length > 0;
  if (node.kind === 'loop') return node.bodyGraph.nodes.some(nodeWrites);
  if (node.kind === 'parallel') return node.itemGraph.nodes.some(nodeWrites);
  return false;
}

/** For each node, the nodes reachable from it along control and data edges. */
function reachability(nodeIds: readonly string[], graph: WorkflowGraph): Map<string, Set<string>> {
  const next = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of [...graph.controlEdges, ...graph.dataEdges]) {
    next.get(edge.fromNodeId)?.push(edge.toNodeId);
  }
  const reach = new Map<string, Set<string>>();
  for (const start of nodeIds) {
    const seen = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id) || !next.has(id)) continue;
      seen.add(id);
      stack.push(...next.get(id)!);
    }
    reach.set(start, seen);
  }
  return reach;
}

function compileGraphScope(
  graph: WorkflowGraph,
  scopePath: string,
  parentInputs: readonly PortDefinition[],
  parentOutputs: readonly PortDefinition[],
  issues: WorkflowValidationIssue[],
  slots: WorkspaceSlotContext
): CompiledGraphScope {
  if (graph.nodes.length === 0) {
    issues.push({
      code: 'EMPTY_GRAPH',
      message: `Graph at scope "${scopePath}" must contain at least one node`,
      scopePath,
    });
  }

  const nodesById: Record<string, WorkflowNode> = {};
  for (const node of graph.nodes) {
    if (node.id === '$input' || node.id === '$output') {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Node ID "${node.id}" is reserved`,
        scopePath,
        nodeId: node.id,
      });
      continue;
    }
    if (nodesById[node.id]) {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node ID "${node.id}" in scope "${scopePath}"`,
        scopePath,
        nodeId: node.id,
      });
      continue;
    }
    nodesById[node.id] = node;

    const slotRefs = [node.workspace, ...(node.kind === 'agent' ? node.readWorkspaces : [])];
    for (const slot of slotRefs) {
      if (slot !== undefined && !slots.declared.has(slot)) {
        issues.push({
          code: 'UNKNOWN_WORKSPACE_SLOT',
          message: `Node "${node.id}" refers to workspace slot "${slot}", which the workflow does not declare`,
          scopePath,
          nodeId: node.id,
        });
      }
    }

    const agentRef =
      node.kind === 'agent'
        ? node.agentRef
        : node.kind === 'loop' || node.kind === 'parallel'
          ? node.defaultAgentRef
          : undefined;
    if (agentRef !== undefined && !parseAgentRef(agentRef)) {
      issues.push({
        code: 'INVALID_AGENT_REF',
        message: `Node "${node.id}" has malformed agent ref "${agentRef}" (expected "<agentId>" or "<agentId>@<version>")`,
        scopePath,
        nodeId: node.id,
      });
    }
  }

  const incomingControlEdges: Record<string, ControlEdge[]> = {};
  const outgoingControlEdges: Record<string, ControlEdge[]> = {};
  const incomingDataEdges: Record<string, DataEdge[]> = {};
  const outgoingDataEdges: Record<string, DataEdge[]> = {};

  for (const nodeId of Object.keys(nodesById)) {
    incomingControlEdges[nodeId] = [];
    outgoingControlEdges[nodeId] = [];
    incomingDataEdges[nodeId] = [];
    outgoingDataEdges[nodeId] = [];
  }
  outgoingDataEdges.$input = [];
  incomingDataEdges.$output = [];

  // Adjacency for topological sort (combines controlEdges + node-to-node dataEdges for causal ordering)
  const adj = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const nodeId of Object.keys(nodesById)) {
    adj.set(nodeId, new Set());
    inDegree.set(nodeId, 0);
  }

  const seenEdgeIds = new Set<string>();

  for (const edge of graph.controlEdges) {
    if (seenEdgeIds.has(edge.id)) {
      issues.push({
        code: 'DUPLICATE_EDGE_ID',
        message: `Duplicate control edge ID "${edge.id}"`,
        scopePath,
        edgeId: edge.id,
      });
    }
    seenEdgeIds.add(edge.id);

    if (!nodesById[edge.fromNodeId]) {
      issues.push({
        code: 'UNKNOWN_NODE_REF',
        message: `Control edge "${edge.id}" references unknown source node "${edge.fromNodeId}"`,
        scopePath,
        edgeId: edge.id,
      });
      continue;
    }
    if (!nodesById[edge.toNodeId]) {
      issues.push({
        code: 'UNKNOWN_NODE_REF',
        message: `Control edge "${edge.id}" references unknown target node "${edge.toNodeId}"`,
        scopePath,
        edgeId: edge.id,
      });
      continue;
    }
    if (edge.fromNodeId === edge.toNodeId) {
      issues.push({
        code: 'SELF_LOOP_EDGE',
        message: `Control edge "${edge.id}" cannot connect node "${edge.fromNodeId}" to itself`,
        scopePath,
        nodeId: edge.fromNodeId,
        edgeId: edge.id,
      });
      continue;
    }

    outgoingControlEdges[edge.fromNodeId]!.push(edge);
    incomingControlEdges[edge.toNodeId]!.push(edge);

    const neighbors = adj.get(edge.fromNodeId)!;
    if (!neighbors.has(edge.toNodeId)) {
      neighbors.add(edge.toNodeId);
      inDegree.set(edge.toNodeId, (inDegree.get(edge.toNodeId) ?? 0) + 1);
    }
  }

  // Compute topological order on Control Graph first via Kahn's algorithm
  const topologicalOrder: string[] = [];
  const topologicalLevels: string[][] = [];
  let currentLevel = Object.keys(nodesById)
    .filter((id) => (inDegree.get(id) ?? 0) === 0)
    .sort();

  while (currentLevel.length > 0) {
    topologicalLevels.push(currentLevel);
    const nextLevel: string[] = [];
    for (const u of currentLevel) {
      topologicalOrder.push(u);
      for (const v of adj.get(u) ?? []) {
        const nextDeg = (inDegree.get(v) ?? 1) - 1;
        inDegree.set(v, nextDeg);
        if (nextDeg === 0) {
          nextLevel.push(v);
        }
      }
    }
    currentLevel = nextLevel.sort();
  }

  if (topologicalOrder.length < Object.keys(nodesById).length) {
    const cycleNodes = Object.keys(nodesById).filter((id) => !topologicalOrder.includes(id));
    issues.push({
      code: 'CYCLE_DETECTED',
      message: `Cycle detected in scope "${scopePath}" involving nodes: ${cycleNodes.join(', ')}. Use a LoopNode container instead of back-edges.`,
      scopePath,
      nodeId: cycleNodes[0],
    });
  }

  // Control reachability check: can `fromNodeId` reach `toNodeId` via control edges, or is there no reverse path?
  const topoRank = new Map<string, number>();
  topologicalOrder.forEach((id, idx) => topoRank.set(id, idx));

  const controlReachableFrom = (startId: string): Set<string> => {
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const next of adj.get(curr) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return visited;
  };

  const parentInputMap = new Map(parentInputs.map((p) => [p.name, p]));
  const parentOutputMap = new Map(parentOutputs.map((p) => [p.name, p]));

  for (const dataEdge of graph.dataEdges) {
    if (seenEdgeIds.has(dataEdge.id)) {
      issues.push({
        code: 'DUPLICATE_EDGE_ID',
        message: `Duplicate data edge ID "${dataEdge.id}"`,
        scopePath,
        edgeId: dataEdge.id,
      });
    }
    seenEdgeIds.add(dataEdge.id);

    // Validate source node & port
    if (dataEdge.fromNodeId === '$input') {
      if (parentInputMap.size > 0 && !parentInputMap.has(dataEdge.fromPort)) {
        issues.push({
          code: 'UNKNOWN_PORT_REF',
          message: `Data edge "${dataEdge.id}" references undeclared workflow/scope input port "${dataEdge.fromPort}"`,
          scopePath,
          edgeId: dataEdge.id,
        });
      }
      outgoingDataEdges.$input!.push(dataEdge);
    } else {
      const fromNode = nodesById[dataEdge.fromNodeId];
      if (!fromNode) {
        issues.push({
          code: 'UNKNOWN_NODE_REF',
          message: `Data edge "${dataEdge.id}" references unknown source node "${dataEdge.fromNodeId}"`,
          scopePath,
          edgeId: dataEdge.id,
        });
        continue;
      }
      if (
        fromNode.outputs.length > 0 &&
        !fromNode.outputs.some((p) => p.name === dataEdge.fromPort)
      ) {
        issues.push({
          code: 'UNKNOWN_PORT_REF',
          message: `Data edge "${dataEdge.id}" references unknown output port "${dataEdge.fromPort}" on node "${fromNode.id}"`,
          scopePath,
          nodeId: fromNode.id,
          edgeId: dataEdge.id,
        });
      }
      outgoingDataEdges[fromNode.id]!.push(dataEdge);
    }

    // Validate target node & port
    if (dataEdge.toNodeId === '$output') {
      if (parentOutputMap.size > 0 && !parentOutputMap.has(dataEdge.toPort)) {
        issues.push({
          code: 'UNKNOWN_PORT_REF',
          message: `Data edge "${dataEdge.id}" references undeclared workflow/scope output port "${dataEdge.toPort}"`,
          scopePath,
          edgeId: dataEdge.id,
        });
      }
      incomingDataEdges.$output!.push(dataEdge);
    } else {
      const toNode = nodesById[dataEdge.toNodeId];
      if (!toNode) {
        issues.push({
          code: 'UNKNOWN_NODE_REF',
          message: `Data edge "${dataEdge.id}" references unknown target node "${dataEdge.toNodeId}"`,
          scopePath,
          edgeId: dataEdge.id,
        });
        continue;
      }
      if (toNode.inputs.length > 0 && !toNode.inputs.some((p) => p.name === dataEdge.toPort)) {
        issues.push({
          code: 'UNKNOWN_PORT_REF',
          message: `Data edge "${dataEdge.id}" references unknown input port "${dataEdge.toPort}" on node "${toNode.id}"`,
          scopePath,
          nodeId: toNode.id,
          edgeId: dataEdge.id,
        });
      }
      incomingDataEdges[toNode.id]!.push(dataEdge);
    }

    // Validate causal topological consistency between two regular nodes
    if (
      dataEdge.fromNodeId !== '$input' &&
      dataEdge.toNodeId !== '$output' &&
      nodesById[dataEdge.fromNodeId] &&
      nodesById[dataEdge.toNodeId]
    ) {
      if (dataEdge.fromNodeId === dataEdge.toNodeId) {
        issues.push({
          code: 'SELF_LOOP_EDGE',
          message: `Data edge "${dataEdge.id}" cannot connect node "${dataEdge.fromNodeId}" to itself`,
          scopePath,
          nodeId: dataEdge.fromNodeId,
          edgeId: dataEdge.id,
        });
      } else {
        const reachableFromSource = controlReachableFrom(dataEdge.fromNodeId);
        if (!reachableFromSource.has(dataEdge.toNodeId)) {
          const fromRank = topoRank.get(dataEdge.fromNodeId) ?? 0;
          const toRank = topoRank.get(dataEdge.toNodeId) ?? 0;
          const reverseReachable = controlReachableFrom(dataEdge.toNodeId).has(
            dataEdge.fromNodeId
          );
          if (reverseReachable || fromRank > toRank) {
            issues.push({
              code: 'DATA_EDGE_ORDER_VIOLATION',
              message: `Data edge "${dataEdge.id}" from "${dataEdge.fromNodeId}" to "${dataEdge.toNodeId}" violates control flow order (target executes before or without waiting for source)`,
              scopePath,
              edgeId: dataEdge.id,
            });
          } else {
            issues.push({
              code: 'DATA_EDGE_ORDER_VIOLATION',
              message: `Data edge "${dataEdge.id}" from "${dataEdge.fromNodeId}" to "${dataEdge.toNodeId}" requires a control path from "${dataEdge.fromNodeId}" to "${dataEdge.toNodeId}" so source completes before target reads its output`,
              scopePath,
              edgeId: dataEdge.id,
            });
          }
        }
      }
    }
  }

  // Check required input ports on all nodes
  for (const node of Object.values(nodesById)) {
    const boundPorts = new Set((incomingDataEdges[node.id] ?? []).map((e) => e.toPort));
    for (const inputPort of node.inputs) {
      if (
        inputPort.required &&
        inputPort.defaultValue === undefined &&
        !boundPorts.has(inputPort.name)
      ) {
        issues.push({
          code: 'MISSING_REQUIRED_INPUT_BINDING',
          message: `Node "${node.id}" is missing a data edge binding for required input port "${inputPort.name}"`,
          scopePath,
          nodeId: node.id,
        });
      }
    }
  }

  const nodeList = Object.values(nodesById);
  const workspaceSlots: Record<string, string> = {};
  for (const node of nodeList) {
    workspaceSlots[node.id] = node.workspace ?? slots.inherited;
  }

  // A writer may run alongside another writer in the same slot when neither waits for the
  // other and the scheduler does not serialize them (it does for overlapping write scopes).
  const reach = reachability(Object.keys(nodesById), graph);
  const writers = nodeList.filter(nodeWrites);
  const mayRunConcurrently = (node: WorkflowNode): boolean =>
    slots.concurrent ||
    writers.some(
      (other) =>
        other.id !== node.id &&
        workspaceSlots[other.id] === workspaceSlots[node.id] &&
        !reach.get(node.id)!.has(other.id) &&
        !reach.get(other.id)!.has(node.id) &&
        !hasAnyWriteScopeOverlap(node.writeScopes, other.writeScopes)
    );
  const writePolicies: Record<string, WritePolicy> = {};
  const childSlots: Record<string, WorkspaceSlotContext> = {};
  for (const node of nodeList) {
    const isolation = node.isolation ?? slots.isolation;
    const enforceWriteScopes = node.enforceWriteScopes ?? slots.enforceWriteScopes;
    const concurrent = nodeWrites(node) && mayRunConcurrently(node);
    if (node.kind === 'agent' || node.kind === 'script') {
      writePolicies[node.id] = {
        isolated: nodeWrites(node) && (isolation === 'worktree' || (isolation === 'auto' && concurrent)),
        enforceWriteScopes,
      };
    } else if (node.kind === 'loop' || node.kind === 'parallel') {
      childSlots[node.id] = {
        declared: slots.declared,
        inherited: workspaceSlots[node.id]!,
        isolation,
        enforceWriteScopes,
        // Parallel items run side by side; a loop's rounds run one after another.
        concurrent: concurrent || (node.kind === 'parallel' && node.maxConcurrency > 1),
      };
    }
  }

  // Precompute write-scope conflict matrix among nodes in this scope (paths only clash within one slot)
  const writeScopeConflicts: Record<string, string[]> = {};
  for (const nodeA of nodeList) {
    const conflicts: string[] = [];
    if (nodeA.writeScopes.length > 0) {
      for (const nodeB of nodeList) {
        if (nodeA.id === nodeB.id || nodeB.writeScopes.length === 0) continue;
        if (workspaceSlots[nodeA.id] !== workspaceSlots[nodeB.id]) continue;
        if (hasAnyWriteScopeOverlap(nodeA.writeScopes, nodeB.writeScopes)) {
          conflicts.push(nodeB.id);
        }
      }
    }
    writeScopeConflicts[nodeA.id] = conflicts.sort();
  }

  // Recursively compile child scopes for LoopNode and ParallelNode containers
  const childScopes: Record<string, CompiledGraphScope> = {};
  for (const node of nodeList) {
    if (node.kind === 'loop') {
      childScopes[node.id] = compileGraphScope(
        node.bodyGraph,
        `${scopePath}/${node.id}`,
        node.inputs,
        node.outputs,
        issues,
        childSlots[node.id]!
      );
    } else if (node.kind === 'parallel') {
      const itemInputs: PortDefinition[] = [
        { name: 'item', type: 'json', required: false },
        { name: 'itemIndex', type: 'number', required: false },
        ...node.inputs,
      ];
      childScopes[node.id] = compileGraphScope(
        node.itemGraph,
        `${scopePath}/${node.id}`,
        itemInputs,
        node.outputs,
        issues,
        childSlots[node.id]!
      );
    }
  }

  return {
    scopePath,
    nodesById,
    topologicalOrder,
    topologicalLevels,
    incomingControlEdges,
    outgoingControlEdges,
    incomingDataEdges,
    outgoingDataEdges,
    workspaceSlots,
    writePolicies,
    writeScopeConflicts,
    childScopes,
  };
}

/**
 * Validate a workflow definition without throwing.
 */
export function validateWorkflowDefinition(
  input: unknown
):
  | { ok: true; plan: CompiledWorkflowPlan; issues: [] }
  | { ok: false; issues: WorkflowValidationIssue[] } {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'INVALID_SCHEMA',
        message: `${issue.path.join('.') || 'root'}: ${issue.message}`,
        scopePath: '$root',
      })),
    };
  }

  const definition = parsed.data;
  const issues: WorkflowValidationIssue[] = [];
  if (definition.chief?.agentRef !== undefined && !parseAgentRef(definition.chief.agentRef)) {
    issues.push({
      code: 'INVALID_AGENT_REF',
      message: `Chief agent ref "${definition.chief.agentRef}" is malformed`,
      scopePath: '$root',
    });
  }
  const declaredSlots = new Set<string>();
  for (const slot of listWorkspaceSlots(definition)) {
    if (declaredSlots.has(slot.name)) {
      issues.push({
        code: 'UNKNOWN_WORKSPACE_SLOT',
        message: `Workspace slot "${slot.name}" is declared more than once`,
        scopePath: '$root',
      });
    }
    declaredSlots.add(slot.name);
  }
  const defaultSlot = defaultWorkspaceSlot(definition);
  if (!declaredSlots.has(defaultSlot)) {
    issues.push({
      code: 'UNKNOWN_WORKSPACE_SLOT',
      message: `Default workspace slot "${defaultSlot}" is not declared`,
      scopePath: '$root',
    });
  }
  const rootScope = compileGraphScope(
    definition.graph,
    '$root',
    definition.inputs,
    definition.outputs,
    issues,
    { declared: declaredSlots, inherited: defaultSlot, isolation: 'auto', enforceWriteScopes: false, concurrent: false }
  );

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    plan: {
      definition,
      definitionDigest: computeDefinitionDigest(definition),
      rootScope,
    },
    issues: [],
  };
}

/**
 * Compile and validate a workflow definition into an executable `CompiledWorkflowPlan`.
 * Throws `WorkflowCompilationError` if any structural, topological, or port binding rule is violated.
 */
export function compileWorkflowDefinition(input: WorkflowDefinition | unknown): CompiledWorkflowPlan {
  const result = validateWorkflowDefinition(input);
  if (!result.ok) {
    throw new WorkflowCompilationError(result.issues);
  }
  return result.plan;
}

/**
 * Compute the reachable downstream subgraph starting from `startNodeIds`.
 *
 * - `mode: 'data'`: follows only `DataEdge`s (identifies nodes whose inputs/assessments
 *   become STALE when `startNodeIds` produce a new artifact version).
 * - `mode: 'control_and_data'` (default): follows both `ControlEdge`s and `DataEdge`s
 *   (identifies all downstream nodes that must be invalidated/rerun when `startNodeIds` is rerun).
 *
 * Returns the affected node IDs in topological order (excluding `startNodeIds` unless `includeStart` is true).
 */
export function computeDownstreamSubgraph(
  scope: CompiledGraphScope,
  startNodeIds: readonly string[],
  options: {
    mode?: 'data' | 'control_and_data';
    includeStart?: boolean;
  } = {}
): string[] {
  const mode = options.mode ?? 'control_and_data';
  const includeStart = options.includeStart ?? false;
  const startSet = new Set(startNodeIds);
  const visited = new Set<string>(includeStart ? startNodeIds : []);
  const queue = [...startNodeIds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextNodes = new Set<string>();

    for (const dataEdge of scope.outgoingDataEdges[current] ?? []) {
      if (dataEdge.toNodeId !== '$output') {
        nextNodes.add(dataEdge.toNodeId);
      }
    }

    if (mode === 'control_and_data') {
      for (const ctrlEdge of scope.outgoingControlEdges[current] ?? []) {
        nextNodes.add(ctrlEdge.toNodeId);
      }
    }

    for (const nextId of nextNodes) {
      if (!visited.has(nextId) && !startSet.has(nextId)) {
        visited.add(nextId);
        queue.push(nextId);
      }
    }
  }

  return scope.topologicalOrder.filter((nodeId) => visited.has(nodeId));
}
