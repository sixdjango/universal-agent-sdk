import { validateWorkflowDefinition, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel } from '../src/model/canvas';
import {
  addNode,
  addPort,
  connect,
  createBlankWorkflow,
  type EditResult,
  removeEdge,
  removeNode,
  removePort,
  setEdgeCondition,
  updateNode,
  updatePort,
} from '../src/model/editing';

function ok<T>(result: EditResult<T>): Extract<EditResult<T>, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result as Extract<EditResult<T>, { ok: true }>;
}

/** request -> author -> reviewer, built only through editor operations. */
function buildDraft(): { definition: WorkflowDefinition; author: string; reviewer: string } {
  let definition = createBlankWorkflow('Review flow', ['review-flow']);
  const a = ok(addNode(definition, 'agent'));
  definition = a.definition;
  const r = ok(addNode(definition, 'agent'));
  definition = updateNode(r.definition, r.nodeId, { name: 'Review', producesAssessment: true, outputs: [] });
  // Input field -> author: dropping on the "+" row creates the author's input port.
  definition = ok(connect(definition, { source: '$input', sourceHandle: 'out:request', target: a.nodeId, targetHandle: 'in:+' })).definition;
  // Author result -> reviewer "+ input": creates the port and orders reviewer after author.
  definition = ok(connect(definition, { source: a.nodeId, sourceHandle: 'out:result', target: r.nodeId, targetHandle: 'in:+' })).definition;
  return { definition, author: a.nodeId, reviewer: r.nodeId };
}

describe('editor operations', () => {
  it('supervises new workflows with the default chief, allowed to operate', () => {
    const chief = createBlankWorkflow('Fresh', []).chief;
    expect(chief?.agentRef).toBeUndefined();
    expect(chief?.maxLevel).toBe('operate');
  });

  it('builds a workflow from scratch that the contract compiler accepts', () => {
    const { definition, author, reviewer } = buildDraft();

    expect(definition.id).toBe('review-flow_2');
    expect(definition.graph.nodes.find((n) => n.id === author)?.inputs.map((p) => p.name)).toEqual(['request']);
    expect(definition.graph.nodes.find((n) => n.id === reviewer)?.inputs).toEqual([
      { name: 'result', type: 'artifact', required: true },
    ]);
    expect(definition.graph.controlEdges).toEqual([{ id: `ctrl_${author}_to_${reviewer}`, fromNodeId: author, toNodeId: reviewer }]);

    const result = validateWorkflowDefinition(definition);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('refuses double-feeding an input and duplicate ordering, and supports explicit control edges', () => {
    const { definition, author, reviewer } = buildDraft();
    const again = connect(definition, { source: author, sourceHandle: 'out:result', target: reviewer, targetHandle: 'in:result' });
    expect(again.ok ? '' : again.error).toContain('already receives data');

    const ordered = connect(definition, { source: author, sourceHandle: 'ctrl-out', target: reviewer, targetHandle: 'ctrl-in' });
    expect(ordered.ok ? '' : ordered.error).toContain('already ordered');

    const toInputs = connect(definition, { source: author, sourceHandle: 'out:result', target: '$input', targetHandle: 'in:+' });
    expect(toInputs.ok).toBe(false);

    const gate = ok(addNode(definition, 'gate'));
    const ctrl = ok(connect(gate.definition, { source: reviewer, sourceHandle: 'ctrl-out', target: gate.nodeId, targetHandle: 'ctrl-in' }));
    const conditioned = setEdgeCondition(ctrl.definition, ctrl.edgeIds[0]!, { kind: 'verdict_is', verdict: 'PASS' });
    expect(conditioned.graph.controlEdges.find((e) => e.id === ctrl.edgeIds[0])?.when).toEqual({ kind: 'verdict_is', verdict: 'PASS' });
    expect(setEdgeCondition(conditioned, ctrl.edgeIds[0]!, undefined).graph.controlEdges.find((e) => e.id === ctrl.edgeIds[0])?.when).toBeUndefined();
  });

  it('renames ports without breaking edges and cleans up on removal', () => {
    const { definition, author, reviewer } = buildDraft();
    const renamed = ok(updatePort(definition, author, 'out', 'result', { name: 'Draft Change' })).definition;
    expect(renamed.graph.dataEdges.find((e) => e.fromNodeId === author)?.fromPort).toBe('draft_change');
    expect(validateWorkflowDefinition(renamed).ok).toBe(true);

    const clash = ok(addPort(renamed, author, 'out', { name: 'notes' })).definition;
    expect(updatePort(clash, author, 'out', 'notes', { name: 'draft_change' }).ok).toBe(false);

    // The reviewer's own input keeps its name; only the author's output was renamed.
    const portless = removePort(renamed, reviewer, 'in', 'result');
    expect(portless.graph.dataEdges.some((e) => e.toNodeId === reviewer)).toBe(false);

    const withoutAuthor = removeNode(definition, author);
    expect(withoutAuthor.graph.dataEdges).toEqual([]);
    expect(withoutAuthor.graph.controlEdges).toEqual([]);

    const edgeId = definition.graph.dataEdges[0]!.id;
    expect(removeEdge(definition, edgeId).graph.dataEdges.map((e) => e.id)).not.toContain(edgeId);
  });

  it('renders drafts that do not compile yet instead of failing', () => {
    let definition = buildDraft().definition;
    const [first, second] = definition.graph.nodes;
    // A back edge makes a cycle; the canvas must still lay the graph out.
    definition = { ...definition, graph: { ...definition.graph, controlEdges: [...definition.graph.controlEdges, { id: 'back', fromNodeId: second!.id, toNodeId: first!.id }] } };
    expect(validateWorkflowDefinition(definition).ok).toBe(false);
    const model = buildCanvasModel({ definition, editable: true });
    expect(model.nodes.map((n) => n.id).sort()).toEqual(['$input', '$output', first!.id, second!.id].sort());
  });
});
