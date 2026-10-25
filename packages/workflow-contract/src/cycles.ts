import {
  type ControlEdge,
  type DataEdge,
  type EdgeCondition,
  withConditionSource,
  type LoopCarry,
  type LoopNode,
  type PortDefinition,
  type WorkflowGraph,
  type WorkflowNode,
} from './schema';

/**
 * Loops drawn as cycles: a way-back edge (`ControlEdge.loop`) from the step whose result
 * decides (the decider) to an earlier step, taken while its `when` holds. The runtime
 * executes nested `LoopNode`s, so the compiler lowers each cycle into one (`lowerCycles`);
 * editors keep showing the flat graph (`analyzeLoopBacks`).
 */

/** Id of the `LoopNode` the compiler makes for the way back leaving `deciderId`. */
export function cycleLoopId(deciderId: string): string {
  return `${deciderId}__loop`;
}

export interface LoopBackInfo {
  /** The way-back edge. */
  readonly edge: ControlEdge;
  /** The step the way back leaves; its result decides whether another round runs. */
  readonly deciderId: string;
  /** Where every round starts (the edge's target). */
  readonly headId: string;
  /** Every step that repeats: on a path from the head to the decider, both included. */
  readonly bodyIds: readonly string[];
  /** The `LoopNode` id runs use for it (scope keys look like `<scope>/<loopId>:round_<n>`). */
  readonly loopId: string;
}

export interface LoopBackIssue {
  readonly code: 'INVALID_LOOP_BACK' | 'LOOPS_OVERLAP';
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}

export interface LoopBackAnalysis {
  /** Valid loops, largest first. */
  readonly loops: readonly LoopBackInfo[];
  /** Data edges that close a cycle: they hand a value from one round to the next. */
  readonly carryEdgeIds: ReadonlySet<string>;
  readonly issues: readonly LoopBackIssue[];
}

const BOUNDARY = new Set(['$input', '$output']);

function reachable(from: string, next: ReadonlyMap<string, readonly string[]>, skip?: (a: string, b: string) => boolean): Set<string> {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const to of next.get(id) ?? []) {
      if (skip?.(id, to) || seen.has(to)) continue;
      seen.add(to);
      stack.push(to);
    }
  }
  return seen;
}

/** Finds the loops a graph draws as cycles (not those of nested containers), and checks them. */
export function analyzeLoopBacks(graph: WorkflowGraph): LoopBackAnalysis {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const issues: LoopBackIssue[] = [];
  const backEdges = graph.controlEdges.filter((e) => e.loop);
  const forwardControl = graph.controlEdges.filter((e) => !e.loop);

  // Forward links: ordinary control edges, then data edges one by one; a data edge whose
  // target already leads to its source goes against the flow, handing a value to the next round.
  const links = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (BOUNDARY.has(a) || BOUNDARY.has(b)) return;
    links.set(a, [...(links.get(a) ?? []), b]);
  };
  for (const e of forwardControl) link(e.fromNodeId, e.toNodeId);
  const carryEdgeIds = new Set<string>();
  for (const e of graph.dataEdges) {
    if (BOUNDARY.has(e.fromNodeId) || BOUNDARY.has(e.toNodeId)) continue;
    if (e.fromNodeId === e.toNodeId || reachable(e.toNodeId, links).has(e.fromNodeId)) carryEdgeIds.add(e.id);
    else link(e.fromNodeId, e.toNodeId);
  }
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const addForward = (a: string, b: string) => {
    if (BOUNDARY.has(a) || BOUNDARY.has(b)) return;
    forward.set(a, [...(forward.get(a) ?? []), b]);
    reverse.set(b, [...(reverse.get(b) ?? []), a]);
  };
  for (const e of forwardControl) addForward(e.fromNodeId, e.toNodeId);
  for (const e of graph.dataEdges) if (!carryEdgeIds.has(e.id)) addForward(e.fromNodeId, e.toNodeId);

  const loops: LoopBackInfo[] = [];
  for (const edge of backEdges) {
    const decider = nodes.get(edge.fromNodeId);
    const fail = (message: string) => issues.push({ code: 'INVALID_LOOP_BACK', message, edgeId: edge.id, nodeId: edge.fromNodeId });
    if (!decider) {
      fail(`The way back "${edge.id}" leaves an unknown step "${edge.fromNodeId}"`);
      continue;
    }
    if (!nodes.has(edge.toNodeId)) {
      fail(`The way back "${edge.id}" returns to an unknown step "${edge.toNodeId}"`);
      continue;
    }
    if (!edge.when || edge.when.kind === 'always' || edge.when.kind === 'otherwise') {
      fail(`The way back from "${decider.name}" needs a condition (e.g. "if NEEDS_FIX"), or the loop never ends early`);
      continue;
    }
    const fromHead = reachable(edge.toNodeId, forward);
    if (!fromHead.has(decider.id)) {
      fail(`The way back from "${decider.name}" must return to a step that leads to it`);
      continue;
    }
    const toDecider = reachable(decider.id, reverse);
    const bodyIds = graph.nodes.map((n) => n.id).filter((id) => fromHead.has(id) && toDecider.has(id));
    loops.push({ edge, deciderId: decider.id, headId: edge.toNodeId, bodyIds, loopId: cycleLoopId(decider.id) });
  }

  // Loops may nest but not partly overlap; and a step closes at most one loop.
  loops.sort((a, b) => b.bodyIds.length - a.bodyIds.length);
  const kept: LoopBackInfo[] = [];
  for (const loop of loops) {
    const clash = kept.find((other) => {
      if (other.deciderId === loop.deciderId) return true;
      const inside = loop.bodyIds.filter((id) => other.bodyIds.includes(id)).length;
      return inside > 0 && inside < loop.bodyIds.length;
    });
    if (clash) {
      issues.push({
        code: 'LOOPS_OVERLAP',
        message:
          clash.deciderId === loop.deciderId
            ? `"${loop.deciderId}" has more than one way back; a step closes one loop`
            : `Loops back to "${loop.headId}" and "${clash.headId}" overlap without one containing the other`,
        edgeId: loop.edge.id,
        nodeId: loop.deciderId,
      });
      continue;
    }
    kept.push(loop);
  }
  return { loops: kept, carryEdgeIds, issues };
}

function portOf(node: WorkflowNode | undefined, side: 'inputs' | 'outputs', name: string): PortDefinition | undefined {
  return node?.[side].find((p) => p.name === name);
}

/** A condition of an edge leaving a loop, re-aimed at the loop (its verdict is the decider's). */
function exitCondition(when: EdgeCondition | undefined, body: ReadonlySet<string>): EdgeCondition | undefined | null {
  if (!when || when.kind === 'always' || when.kind === 'otherwise') return when;
  if (when.kind === 'all' || when.kind === 'any') {
    const conditions = when.conditions.map((c) => exitCondition(c, body));
    return conditions.some((c) => c === null || c === undefined) ? null : { ...when, conditions: conditions as EdgeCondition[] };
  }
  if (when.sourceNodeId && !body.has(when.sourceNodeId)) return when;
  if (when.kind === 'verdict_is' || when.kind === 'verdict_in') {
    const { sourceNodeId: _s, ...rest } = when;
    return rest;
  }
  return null;
}

export interface LoweringIssue {
  readonly code: 'INVALID_LOOP_BACK' | 'LOOPS_OVERLAP';
  readonly message: string;
  /** Scope path in the authored definition. */
  readonly scopePath: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}

/**
 * Rewrites every cycle closed by a way back into a `LoopNode` holding the
 * steps that repeat, recursively (nested cycles and container bodies). Edges into and out
 * of the cycle become the loop's ports; data edges that close the cycle become `carry`.
 * Graphs without ways back come back unchanged.
 */
export function lowerCycles(graph: WorkflowGraph, scopePath: string, issues: LoweringIssue[]): WorkflowGraph {
  // Containers drawn by hand keep their own bodies, lowered on their own.
  let lowered: WorkflowGraph = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.kind === 'loop'
        ? { ...n, bodyGraph: lowerCycles(n.bodyGraph, `${scopePath}/${n.id}`, issues) }
        : n.kind === 'parallel'
          ? { ...n, itemGraph: lowerCycles(n.itemGraph, `${scopePath}/${n.id}`, issues) }
          : n
    ),
  };
  if (!graph.controlEdges.some((e) => e.loop)) return lowered;

  const analysis = analyzeLoopBacks(lowered);
  for (const issue of analysis.issues) issues.push({ ...issue, scopePath });
  // Outermost loops are lowered here; loops inside them when their body is lowered.
  const outermost = analysis.loops.filter(
    (loop) => !analysis.loops.some((other) => other !== loop && loop.bodyIds.every((id) => other.bodyIds.includes(id)))
  );
  const invalidBackEdges = new Set(analysis.issues.map((i) => i.edgeId).filter(Boolean));
  for (const loop of outermost) lowered = lowerOne(lowered, loop, analysis, scopePath, issues);
  // Ways back that could not form a loop are dropped so the rest still compiles (they are reported).
  return {
    ...lowered,
    controlEdges: lowered.controlEdges.filter((e) => !(e.loop && invalidBackEdges.has(e.id))),
  };
}

function lowerOne(
  graph: WorkflowGraph,
  loop: LoopBackInfo,
  analysis: LoopBackAnalysis,
  scopePath: string,
  issues: LoweringIssue[]
): WorkflowGraph {
  const body = new Set(loop.bodyIds);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const decider = nodes.get(loop.deciderId)!;
  const inside = (id: string) => body.has(id);
  // Carry edges of loops nested inside this one stay in the body for the inner loop.
  const nested = analysis.loops.filter((l) => l !== loop && l.bodyIds.every((id) => body.has(id)));
  const innerCarry = (e: DataEdge) => nested.some((l) => l.bodyIds.includes(e.fromNodeId) && l.bodyIds.includes(e.toNodeId));

  const inputs: PortDefinition[] = [];
  const outputs: PortDefinition[] = [];
  const carry: LoopCarry[] = [];
  const bodyControl: ControlEdge[] = [];
  const bodyData: DataEdge[] = [];
  const outerControl: ControlEdge[] = [];
  const outerData: DataEdge[] = [];
  const outputPort = new Map<string, string>();

  for (const e of graph.controlEdges) {
    if (e.id === loop.edge.id) continue;
    const from = inside(e.fromNodeId);
    const to = inside(e.toNodeId);
    if (from && to) bodyControl.push(e);
    else if (!from && !to) outerControl.push(e);
    else if (to) {
      // Waiting for something outside: the whole loop waits for it.
      if (!outerControl.some((o) => o.fromNodeId === e.fromNodeId && o.toNodeId === loop.loopId && JSON.stringify(o.when) === JSON.stringify(e.when))) {
        outerControl.push({ ...e, toNodeId: loop.loopId });
      }
    } else {
      const when = exitCondition(e.when, body);
      if (when === null) {
        issues.push({
          code: 'INVALID_LOOP_BACK',
          message: `"${e.id}" leaves the loop on an output of a step inside it; conditions leaving a loop can only check its verdict`,
          scopePath,
          edgeId: e.id,
        });
        continue;
      }
      const lifted = { ...e, fromNodeId: loop.loopId, ...(when ? { when } : {}) };
      if (!when) delete (lifted as { when?: EdgeCondition }).when;
      if (!outerControl.some((o) => o.fromNodeId === loop.loopId && o.toNodeId === e.toNodeId && JSON.stringify(o.when) === JSON.stringify(lifted.when))) {
        outerControl.push(lifted);
      }
    }
  }

  for (const e of graph.dataEdges) {
    const from = inside(e.fromNodeId);
    const to = inside(e.toNodeId);
    if (analysis.carryEdgeIds.has(e.id) && from && to && !innerCarry(e)) {
      const port = `carry__${e.toNodeId}__${e.toPort}`;
      const type = portOf(nodes.get(e.toNodeId), 'inputs', e.toPort)?.type ?? 'json';
      if (!inputs.some((p) => p.name === port)) inputs.push({ name: port, type, required: false });
      carry.push({ fromNodeId: e.fromNodeId, fromPort: e.fromPort, toPort: port });
      bodyData.push({ ...e, fromNodeId: '$input', fromPort: port, required: false });
    } else if (from && to) {
      bodyData.push(e);
    } else if (!from && !to) {
      outerData.push(e);
    } else if (to) {
      const port = `in__${e.toNodeId}__${e.toPort}`;
      const type = portOf(nodes.get(e.toNodeId), 'inputs', e.toPort)?.type ?? 'json';
      if (!inputs.some((p) => p.name === port)) inputs.push({ name: port, type, required: e.required });
      outerData.push({ ...e, toNodeId: loop.loopId, toPort: port });
      bodyData.push({ ...e, id: `${e.id}__in`, fromNodeId: '$input', fromPort: port });
    } else {
      const key = `${e.fromNodeId}.${e.fromPort}`;
      let port = outputPort.get(key);
      if (!port) {
        port = `out__${e.fromNodeId}__${e.fromPort}`;
        outputPort.set(key, port);
        const type = portOf(nodes.get(e.fromNodeId), 'outputs', e.fromPort)?.type ?? 'json';
        outputs.push({ name: port, type, required: false });
        bodyData.push({ id: `${e.id}__out`, fromNodeId: e.fromNodeId, fromPort: e.fromPort, toNodeId: '$output', toPort: port, required: false, delivery: e.delivery });
      }
      outerData.push({ ...e, fromNodeId: loop.loopId, fromPort: port });
    }
  }

  const when = loop.edge.when!;
  const loopNode: LoopNode = {
    kind: 'loop',
    id: loop.loopId,
    name: decider.name,
    inputs,
    outputs,
    writeScopes: [],
    maxTechnicalRetries: 0,
    maxRounds: loop.edge.loop?.maxRounds ?? 3,
    onExhausted: loop.edge.loop?.onExhausted ?? 'fail',
    continueWhen: withConditionSource(when, decider.id),
    bodyGraph: lowerCycles(
      { nodes: graph.nodes.filter((n) => inside(n.id)), controlEdges: bodyControl, dataEdges: bodyData },
      `${scopePath}/${loop.loopId}`,
      issues
    ),
    ...(carry.length > 0 ? { carry } : {}),
    origin: { deciderId: decider.id, backEdgeId: loop.edge.id },
  };

  const firstIndex = graph.nodes.findIndex((n) => inside(n.id));
  const remaining = graph.nodes.filter((n) => !inside(n.id));
  remaining.splice(Math.min(firstIndex, remaining.length), 0, loopNode);
  return { nodes: remaining, controlEdges: outerControl, dataEdges: outerData };
}
