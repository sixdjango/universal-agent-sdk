import {
  type CompiledGraphScope,
  type CompiledWorkflowPlan,
  computeDownstreamSubgraph,
  type ControlEdge,
  type EdgeCondition,
  type LoopNode,
  type ParallelNode,
  type WorkflowEvent,
} from '@universal-agent/workflow-contract';
import type {
  GraphScopeState,
  NodeRuntimeState,
  PortValueRecord,
  RunSnapshotState,
  WorkflowRunState,
} from '../ports';

export function resolveCompiledScopeByKey(
  plan: CompiledWorkflowPlan,
  scopeKey: string
): CompiledGraphScope {
  if (scopeKey === '$root') {
    return plan.rootScope;
  }
  const segments = scopeKey.split('/');
  let current = plan.rootScope;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const containerId = seg.split(/[:[]/)[0]!;
    const child = current.childScopes[containerId];
    if (child) {
      current = child;
    }
  }
  return current;
}

/**
 * Container nodes enclosing `scopeKey`, outermost first
 * (e.g. `$root/fix_loop:round_1/items[2]` -> [fix_loop, items]).
 */
export function resolveContainerChain(
  plan: CompiledWorkflowPlan,
  scopeKey: string
): (LoopNode | ParallelNode)[] {
  const chain: (LoopNode | ParallelNode)[] = [];
  let current = plan.rootScope;
  for (const seg of scopeKey.split('/').slice(1)) {
    const containerId = seg.split(/[:[]/)[0]!;
    const container = current.nodesById[containerId];
    const child = current.childScopes[containerId];
    if (!container || !child || (container.kind !== 'loop' && container.kind !== 'parallel')) {
      break;
    }
    chain.push(container);
    current = child;
  }
  return chain;
}

export function reviveAncestorScopes(
  scopes: Readonly<Record<string, GraphScopeState>>,
  childScopeKey: string
): Record<string, GraphScopeState> {
  const updated: Record<string, GraphScopeState> = { ...scopes };
  let currKey = childScopeKey;
  while (currKey !== '$root') {
    const slashIdx = currKey.lastIndexOf('/');
    if (slashIdx <= 0) break;
    const parentKey = currKey.slice(0, slashIdx);
    const segment = currKey.slice(slashIdx + 1);
    const containerNodeId = segment.split(/[:[]/)[0]!;
    const parentScope = updated[parentKey];
    if (parentScope && parentScope.nodes[containerNodeId]) {
      updated[parentKey] = {
        ...parentScope,
        status: 'RUNNING',
        nodes: {
          ...parentScope.nodes,
          [containerNodeId]: {
            ...parentScope.nodes[containerNodeId]!,
            status: 'PENDING',
            error: undefined,
          },
        },
      };
    }
    currKey = parentKey;
  }
  return updated;
}

export function createInitialScopeState(
  compiledScope: CompiledGraphScope,
  scopeKey: string,
  inputs: Readonly<Record<string, PortValueRecord>>,
  extra?: { roundIndex?: number; itemScopeKeys?: readonly string[] }
): GraphScopeState {
  const nodes: Record<string, NodeRuntimeState> = {};
  for (const nodeId of compiledScope.topologicalOrder) {
    nodes[nodeId] = {
      nodeId,
      status: 'PENDING',
      retryCount: 0,
      outputs: {},
    };
  }
  return {
    scopeKey,
    scopePath: compiledScope.scopePath,
    status: 'RUNNING',
    inputs,
    outputs: {},
    nodes,
    ...(extra?.roundIndex !== undefined ? { roundIndex: extra.roundIndex } : {}),
    ...(extra?.itemScopeKeys !== undefined ? { itemScopeKeys: extra.itemScopeKeys } : {}),
  };
}

export function evaluateEdgeCondition(
  condition: EdgeCondition | undefined,
  defaultSourceNodeId: string,
  scopeState: Pick<GraphScopeState, 'nodes'>,
  /** Edges leaving the same node; `otherwise` holds when none of their conditions does. */
  siblings: readonly ControlEdge[] = []
): boolean {
  if (!condition || condition.kind === 'always') {
    return true;
  }
  if (condition.kind === 'otherwise') {
    return !siblings.some(
      (edge) =>
        edge.when &&
        edge.when.kind !== 'always' &&
        edge.when.kind !== 'otherwise' &&
        !edge.loop &&
        evaluateEdgeCondition(edge.when, defaultSourceNodeId, scopeState)
    );
  }
  if (condition.kind === 'all') return condition.conditions.every((c) => evaluateEdgeCondition(c, defaultSourceNodeId, scopeState));
  if (condition.kind === 'any') return condition.conditions.some((c) => evaluateEdgeCondition(c, defaultSourceNodeId, scopeState));
  const sourceId = condition.sourceNodeId ?? defaultSourceNodeId;
  const sourceNode = scopeState.nodes[sourceId];
  if (!sourceNode) return false;

  switch (condition.kind) {
    case 'verdict_is':
      return sourceNode.latestVerdict === condition.verdict;
    case 'verdict_in':
      return (
        sourceNode.latestVerdict !== undefined &&
        condition.verdicts.includes(sourceNode.latestVerdict)
      );
    case 'port_equals': {
      const portRec = sourceNode.outputs[condition.port];
      return portRec?.value === condition.value;
    }
    case 'port_truthy': {
      const portRec = sourceNode.outputs[condition.port];
      return Boolean(portRec?.value);
    }
    case 'port_compare': {
      const raw = sourceNode.outputs[condition.port]?.value;
      const value = condition.measure === 'length' ? lengthOf(raw) : raw;
      return compareValues(value, condition.op, condition.value);
    }
  }
}

/** Length of a list or text; undefined for anything else. */
function lengthOf(value: unknown): number | undefined {
  return Array.isArray(value) || typeof value === 'string' ? value.length : undefined;
}

/** `==` / `!=` compare anything; ordering holds only between two numbers. */
function compareValues(left: unknown, op: '==' | '!=' | '>' | '>=' | '<' | '<=', right: string | number | boolean | null): boolean {
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;
  if (typeof left !== 'number' || typeof right !== 'number' || Number.isNaN(left)) return false;
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
  }
}

/**
 * Nodes whose control predecessors are settled with at least one activated edge and whose
 * required data inputs are available (ignores write-scope conflicts).
 */
function findRunnableNodeIds(
  compiledScope: CompiledGraphScope,
  nodes: Readonly<Record<string, NodeRuntimeState>>
): string[] {
  const runnable: string[] = [];
  for (const nodeId of compiledScope.topologicalOrder) {
    const nodeState = nodes[nodeId]!;
    if (nodeState.status !== 'PENDING' && nodeState.status !== 'STALE') {
      continue;
    }

    const inEdges = compiledScope.incomingControlEdges[nodeId] ?? [];
    const controlReady =
      inEdges.length === 0 ||
      (inEdges.every((e) => {
        const s = nodes[e.fromNodeId]?.status;
        return s === 'SUCCEEDED' || s === 'SKIPPED';
      }) &&
        inEdges.some((e) => {
          const s = nodes[e.fromNodeId]?.status;
          return (
            s === 'SUCCEEDED' &&
            evaluateEdgeCondition(e.when, e.fromNodeId, { nodes }, compiledScope.outgoingControlEdges[e.fromNodeId])
          );
        }));
    if (!controlReady) continue;

    const dataReady = (compiledScope.incomingDataEdges[nodeId] ?? []).every((de) => {
      if (!de.required || de.fromNodeId === '$input') return true;
      return nodes[de.fromNodeId]?.status === 'SUCCEEDED';
    });
    if (dataReady) {
      runnable.push(nodeId);
    }
  }
  return runnable;
}

/**
 * Propagates `SKIPPED` status (Dead-Path Elimination) across a scope in topological order,
 * and collects scope-level `$output` bindings once terminal nodes finish.
 */
export function reduceScopeTransitions(
  compiledScope: CompiledGraphScope,
  scopeState: GraphScopeState
): GraphScopeState {
  const updatedNodes: Record<string, NodeRuntimeState> = { ...scopeState.nodes };

  for (const nodeId of compiledScope.topologicalOrder) {
    const current = updatedNodes[nodeId]!;
    if (current.status !== 'PENDING' && current.status !== 'STALE') {
      continue;
    }

    const inEdges: readonly ControlEdge[] = compiledScope.incomingControlEdges[nodeId] ?? [];
    if (inEdges.length === 0) {
      continue;
    }

    // Check if all incoming control edges are settled (source SUCCEEDED or SKIPPED)
    const allPredecessorsSettled = inEdges.every((edge) => {
      const predStatus = updatedNodes[edge.fromNodeId]?.status;
      return predStatus === 'SUCCEEDED' || predStatus === 'SKIPPED';
    });

    if (!allPredecessorsSettled) {
      continue;
    }

    // At least one incoming edge must come from a SUCCEEDED node AND evaluate `when` to true
    const anyEdgeActivated = inEdges.some((edge) => {
      const pred = updatedNodes[edge.fromNodeId];
      if (!pred || pred.status !== 'SUCCEEDED') return false;
      return evaluateEdgeCondition(
        edge.when,
        edge.fromNodeId,
        { ...scopeState, nodes: updatedNodes },
        compiledScope.outgoingControlEdges[edge.fromNodeId]
      );
    });

    // A required input whose producer was skipped can never arrive, so the consumer is dead too.
    const requiredInputSkipped = (compiledScope.incomingDataEdges[nodeId] ?? []).some(
      (de) =>
        de.required &&
        de.fromNodeId !== '$input' &&
        updatedNodes[de.fromNodeId]?.status === 'SKIPPED'
    );

    if (!anyEdgeActivated || requiredInputSkipped) {
      updatedNodes[nodeId] = {
        ...current,
        status: 'SKIPPED',
      };
    }
  }

  // Compute scope outputs from incomingDataEdges.$output
  const nextOutputs: Record<string, PortValueRecord> = { ...scopeState.outputs };
  for (const outEdge of compiledScope.incomingDataEdges.$output ?? []) {
    if (outEdge.fromNodeId === '$input') {
      const inVal = scopeState.inputs[outEdge.fromPort];
      if (inVal !== undefined) {
        nextOutputs[outEdge.toPort] = inVal;
      }
    } else {
      const fromNode = updatedNodes[outEdge.fromNodeId];
      if (fromNode?.status === 'SUCCEEDED') {
        const portVal = fromNode.outputs[outEdge.fromPort];
        if (portVal !== undefined) {
          nextOutputs[outEdge.toPort] = portVal;
        }
      }
    }
  }

  // Determine overall scope status. A waiting node only parks the scope once no other
  // node is running or runnable, so independent branches keep progressing.
  const statuses = Object.values(updatedNodes).map((n) => n.status);
  let status = scopeState.status;
  if (statuses.some((s) => s === 'FAILED')) {
    status = 'FAILED';
  } else if (
    statuses.some((s) => s === 'WAITING') &&
    !statuses.some((s) => s === 'RUNNING') &&
    findRunnableNodeIds(compiledScope, updatedNodes).length === 0
  ) {
    status = 'WAITING';
  } else if (
    statuses.length > 0 &&
    statuses.every((s) => s === 'SUCCEEDED' || s === 'SKIPPED')
  ) {
    status = 'SUCCEEDED';
  } else {
    status = 'RUNNING';
  }

  return {
    ...scopeState,
    status,
    nodes: updatedNodes,
    outputs: nextOutputs,
  };
}

/**
 * Computes the conflict-free set of nodes ready to execute in `compiledScope`.
 * Respects `writeScopeConflicts` so no two nodes with overlapping writeScopes run concurrently.
 */
export function computeScopeReadyNodeIds(
  compiledScope: CompiledGraphScope,
  scopeState: GraphScopeState
): string[] {
  const reduced = reduceScopeTransitions(compiledScope, scopeState);
  const candidates = findRunnableNodeIds(compiledScope, reduced.nodes);

  // Filter out candidates that conflict with currently RUNNING nodes or earlier selected candidates
  const activeWriterIds = new Set<string>(
    Object.values(reduced.nodes)
      .filter((n) => n.status === 'RUNNING')
      .map((n) => n.nodeId)
  );

  const selected: string[] = [];
  for (const candidateId of candidates) {
    const conflicts = compiledScope.writeScopeConflicts[candidateId] ?? [];
    const hasConflict = conflicts.some((conflictId) => activeWriterIds.has(conflictId));
    if (!hasConflict) {
      selected.push(candidateId);
      activeWriterIds.add(candidateId);
    }
  }

  return selected;
}

/**
 * Reopens the target and its enclosing containers, invalidating all downstream
 * consumers, assessments, outputs and pending questions. Preserves unrelated branches.
 */
export function invalidateSubgraphForRerun(
  plan: CompiledWorkflowPlan,
  runState: WorkflowRunState,
  targetNodeId: string,
  scopeKey = '$root',
  timestampMs = Date.now()
): {
  nextState: RunSnapshotState;
  affectedNodeIds: string[];
  events: WorkflowEvent[];
} {
  const scopeState = runState.scopes[scopeKey];
  if (!scopeState) {
    throw new Error(`Scope "${scopeKey}" not found in run "${runState.runId}"`);
  }

  const compiledScope = resolveCompiledScopeByKey(plan, scopeKey);

  if (!compiledScope.nodesById[targetNodeId]) {
    throw new Error(`Node "${targetNodeId}" does not exist in scope "${scopeKey}"`);
  }

  const downstreamIds = computeDownstreamSubgraph(compiledScope, [targetNodeId], {
    mode: 'control_and_data',
    includeStart: false,
  });

  const events: WorkflowEvent[] = [];
  const updatedAssessments = { ...runState.assessments };
  const updatedScopes = { ...runState.scopes };
  const waitRequests = { ...runState.waitRequests };
  const invalidateEvidence = (key: string, nodeId: string) => {
    for (const assessment of Object.values(updatedAssessments)) {
      const attempt = runState.attempts[assessment.attemptId];
      if (attempt?.scopeKey === key && attempt.nodeId === nodeId) {
        updatedAssessments[assessment.assessmentId] = { ...assessment, stale: true };
      }
    }
    for (const wait of Object.values(waitRequests)) {
      if (wait.scopeKey === key && wait.nodeId === nodeId && wait.status === 'PENDING') {
        waitRequests[wait.requestId] = { ...wait, status: 'CANCELLED' };
      }
    }
  };
  const removeScopeTree = (root: string) => {
    for (const key of Object.keys(updatedScopes)) {
      if (key !== root && !key.startsWith(`${root}/`)) continue;
      for (const node of Object.values(updatedScopes[key]!.nodes)) invalidateEvidence(key, node.nodeId);
      delete updatedScopes[key];
    }
  };

  // A repaired nested output also invalidates consumers of its enclosing containers.
  // Preserve sibling parallel items, and discard only later loop rounds that used old feedback.
  let currentKey = scopeKey;
  let currentNodeId = targetNodeId;
  let preserveChildren = false;
  while (true) {
    const current = updatedScopes[currentKey]!;
    const compiled = resolveCompiledScopeByKey(plan, currentKey);
    const affected = [currentNodeId, ...computeDownstreamSubgraph(compiled, [currentNodeId], {
      mode: 'control_and_data', includeStart: false,
    })];
    const nodes = { ...current.nodes };
    for (const nodeId of affected) {
      invalidateEvidence(currentKey, nodeId);
      nodes[nodeId] = {
        ...nodes[nodeId]!,
        status: nodeId === currentNodeId ? 'PENDING' : 'STALE',
        outputs: {},
        parallelItems: undefined,
        retryCount: 0,
        latestVerdict: undefined,
        latestAssessmentId: undefined,
        activeWaitRequestId: undefined,
        error: undefined,
      };
      events.push({
        type: 'node.invalidated', runId: runState.runId, scopeKey: currentKey, nodeId,
        reason: `upstream_rerun:${targetNodeId}`, timestampMs,
      });
      if (preserveChildren && nodeId === currentNodeId) continue;
      const prefix = `${currentKey}/${nodeId}`;
      for (const key of Object.keys(updatedScopes)) {
        if (key.startsWith(`${prefix}[`) || key.startsWith(`${prefix}:`)) removeScopeTree(key);
      }
    }
    // Rebuild exported ports so a failed repair cannot leave old success outputs visible.
    updatedScopes[currentKey] = {
      ...reduceScopeTransitions(compiled, { ...current, nodes, outputs: {} }), status: 'RUNNING',
    };
    if (currentKey === '$root') break;
    const slash = currentKey.lastIndexOf('/');
    const parentKey = currentKey.slice(0, slash);
    const segment = currentKey.slice(slash + 1);
    const containerId = segment.split(/[:[]/)[0]!;
    const roundPrefix = `${containerId}:round_`;
    if (segment.startsWith(roundPrefix)) {
      const round = Number(segment.slice(roundPrefix.length));
      const prefix = `${parentKey}/${roundPrefix}`;
      for (const key of Object.keys(updatedScopes)) {
        if (key.startsWith(prefix) && Number(key.slice(prefix.length).split('/')[0]) > round) removeScopeTree(key);
      }
    }
    currentKey = parentKey;
    currentNodeId = containerId;
    preserveChildren = true;
  }

  return {
    nextState: {
      ...runState,
      status: 'RUNNING',
      scopes: updatedScopes,
      assessments: updatedAssessments,
      waitRequests,
      outputs: Object.fromEntries(Object.entries(updatedScopes.$root!.outputs).map(([key, record]) => [key, record.value])),
      events: [...runState.events, ...events],
    },
    affectedNodeIds: [targetNodeId, ...downstreamIds],
    events,
  };
}
