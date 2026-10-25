import {
  type ControlEdge,
  type DataEdge,
  edgeConditionSource,
  type EdgeCondition,
  type LoopNode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@universal-agent/workflow-contract';
import { describeScope } from './canvas';
import { type EditResult, uniqueName } from './editing';
import { graphAt, INPUTS_NODE_ID, mapGraphAt, OUTPUTS_NODE_ID, type ScopePath } from './scope';

/** `condition` without the step it reads (the way back leaves that step, which it then reads). */
function withoutSource(condition: EdgeCondition): EdgeCondition {
  if (!('sourceNodeId' in condition)) return condition;
  const { sourceNodeId: _s, ...rest } = condition;
  return rest as EdgeCondition;
}

/**
 * Turns a loop container into the flat form: its steps join the surrounding graph, and a
 * way back from the step that decided the loop to the first step carries the loop's rule
 * and round limit. Edges into and out of the loop are reconnected
 * to the steps they fed; values the loop carried between rounds become edges drawn back.
 */
export function expandLoopIntoCycle(
  definition: WorkflowDefinition,
  loopId: string,
  path: ScopePath = []
): EditResult<{ deciderId: string }> {
  const graph = graphAt(definition, path);
  const loop = graph.nodes.find((n): n is LoopNode => n.id === loopId && n.kind === 'loop');
  if (!loop) return { ok: false, error: `"${loopId}" is not a loop step here` };
  const body = loop.bodyGraph;
  if (body.nodes.length === 0) return { ok: false, error: 'The loop has no steps to expand' };
  if (body.controlEdges.some((e) => e.loop)) {
    return { ok: false, error: 'Expand the loops drawn inside it first' };
  }

  // Body steps keep their ids unless they clash with the surrounding graph.
  const taken = new Set(graph.nodes.filter((n) => n.id !== loopId).map((n) => n.id));
  const rename = new Map<string, string>();
  for (const node of body.nodes) {
    const id = taken.has(node.id) ? uniqueName(node.id, taken) : node.id;
    taken.add(id);
    rename.set(node.id, id);
  }
  const id = (nodeId: string) => rename.get(nodeId) ?? nodeId;
  const order = describeScope({ ...definition, graph: body }, []).topologicalOrder.filter((n) => rename.has(n));
  const roots = order.filter((n) => !body.controlEdges.some((e) => e.toNodeId === n));
  const head = roots[0] ?? order[0]!;
  const deciderId = edgeConditionSource(loop.continueWhen) ?? order[order.length - 1]!;

  const edgeIds = new Set([...graph.controlEdges, ...graph.dataEdges].map((e) => e.id));
  const freshId = (base: string) => {
    const next = uniqueName(base, edgeIds);
    edgeIds.add(next);
    return next;
  };

  const control: ControlEdge[] = [];
  const data: DataEdge[] = [];
  for (const e of graph.controlEdges) {
    if (e.toNodeId === loopId) control.push({ ...e, toNodeId: id(head) });
    else if (e.fromNodeId === loopId) control.push({ ...e, fromNodeId: id(deciderId) });
    else control.push(e);
  }
  for (const e of body.controlEdges) control.push({ ...e, id: freshId(e.id), fromNodeId: id(e.fromNodeId), toNodeId: id(e.toNodeId) });
  // Further first steps follow the first, so the whole body stays inside the loop.
  for (const root of roots.slice(1)) control.push({ id: freshId(`ctrl_${id(head)}_to_${id(root)}`), fromNodeId: id(head), toNodeId: id(root) });
  control.push({
    id: freshId(`loop_${id(deciderId)}_to_${id(head)}`),
    fromNodeId: id(deciderId),
    toNodeId: id(head),
    when: loop.continueWhen.kind === 'always' ? { kind: 'verdict_is', verdict: 'NEEDS_FIX' } : withoutSource(loop.continueWhen),
    loop: { maxRounds: loop.maxRounds, onExhausted: loop.onExhausted },
  });

  const carried = new Map((loop.carry ?? []).map((c) => [c.toPort, c]));
  for (const e of graph.dataEdges) {
    if (e.toNodeId === loopId) {
      // What fed the loop's input now feeds every step that read it.
      for (const inner of body.dataEdges.filter((b) => b.fromNodeId === INPUTS_NODE_ID && b.fromPort === e.toPort)) {
        data.push({ ...e, id: freshId(`${e.id}__${inner.toNodeId}`), toNodeId: id(inner.toNodeId), toPort: inner.toPort });
      }
    } else if (e.fromNodeId === loopId) {
      // The loop's output came from a step inside; downstream reads that step now.
      const inner = body.dataEdges.find((b) => b.toNodeId === OUTPUTS_NODE_ID && b.toPort === e.fromPort);
      if (inner) data.push({ ...e, fromNodeId: id(inner.fromNodeId), fromPort: inner.fromPort });
    } else {
      data.push(e);
    }
  }
  for (const e of body.dataEdges) {
    if (e.fromNodeId === INPUTS_NODE_ID) {
      const carry = carried.get(e.fromPort);
      if (carry) data.push({ ...e, id: freshId(e.id), fromNodeId: id(carry.fromNodeId), fromPort: carry.fromPort, toNodeId: id(e.toNodeId), required: false });
      continue;
    }
    if (e.toNodeId === OUTPUTS_NODE_ID) continue;
    data.push({ ...e, id: freshId(e.id), fromNodeId: id(e.fromNodeId), toNodeId: id(e.toNodeId) });
  }

  const nodes: WorkflowNode[] = [];
  for (const node of graph.nodes) {
    if (node.id !== loopId) {
      nodes.push(node);
      continue;
    }
    for (const inner of body.nodes) {
      // Settings the loop passed down stay with its steps.
      const inherited =
        inner.kind === 'agent' && !inner.agentRef && loop.defaultAgentRef ? { agentRef: loop.defaultAgentRef } : {};
      nodes.push({ ...inner, ...inherited, id: id(inner.id), ...(loop.workspace && !inner.workspace ? { workspace: loop.workspace } : {}) } as WorkflowNode);
    }
  }

  return {
    ok: true,
    deciderId: id(deciderId),
    definition: mapGraphAt(definition, path, () => ({ nodes, controlEdges: control, dataEdges: data })),
  };
}
