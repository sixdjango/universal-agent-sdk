import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { createWorkflowBuilder, validateWorkflowDefinition, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel } from '../src/model/canvas';
import { connect, findExecutionPath, isPlausibleConnection, removeEdge, type CanvasConnection, type EditResult } from '../src/model/editing';
import { Inspector } from '../src/components/Inspector';
import { FlowEdge } from '../src/canvas/FlowEdge';

function definition() {
  return createWorkflowBuilder('connections')
    .addAgent({ id: 'a', name: 'Author', role: 'worker', goal: 'Write', inputs: [], outputs: [{ name: 'result', type: 'string', required: true }] })
    .addAgent({ id: 'b', name: 'Reviewer', role: 'reviewer', goal: 'Review', inputs: [], outputs: [{ name: 'result', type: 'string', required: true }] })
    .buildDefinition();
}
function ok<T>(value: EditResult<T>): Extract<EditResult<T>, { ok: true }> {
  if (!value.ok) throw new Error(value.error);
  return value as Extract<EditResult<T>, { ok: true }>;
}
const parameter: CanvasConnection = { source: 'a', sourceHandle: 'out:result', target: 'b', targetHandle: 'in:+' };
const execution: CanvasConnection = { source: 'a', sourceHandle: 'ctrl-out', target: 'b', targetHandle: 'ctrl-in' };
function inspector(definition: WorkflowDefinition, target: { type: 'node'; nodeId: string } | { type: 'edge'; edgeId: string }) {
  return renderToStaticMarkup(<Inspector definition={definition} path={[]} target={target} agents={[]} runtimes={[]} issues={[]}
    onChange={() => {}} onClose={() => {}} onError={() => {}} onOpenScope={() => {}} onRefreshRuntime={async () => {}} />);
}

describe('execution and parameter connections', () => {
  it('keeps parameter dashes in pixels instead of stretching a dash across the whole SVG path', () => {
    const render = (control: boolean, tone: 'idle' | 'skipped' = 'idle') => renderToStaticMarkup(<ReactFlowProvider><svg>
      <FlowEdge id="edge" source="a" target="b" sourceX={0} sourceY={0} targetX={200} targetY={20}
        sourcePosition={Position.Right} targetPosition={Position.Left} data={{ control, tone, label: 'result' }} />
    </svg></ReactFlowProvider>);
    const parameter = render(false), execution = render(true);
    expect(parameter).toContain('Parameter: result'); expect(parameter).not.toContain('pathLength="1"');
    expect(execution).toContain('Execution: result'); expect(execution).toContain('pathLength="1"');
    expect(render(true, 'skipped')).not.toContain('pathLength="1"');
  });

  it.each([
    ['ctrl-out', 'in:result'], ['ctrl-out', 'in:+'], ['out:result', 'ctrl-in'], ['out:+', 'ctrl-in'],
    ['out:result', 'out:result'], ['ctrl-in', 'ctrl-out'], ['loop-out', 'ctrl-in'],
  ])('rejects %s → %s both during dragging and during the edit, without creating fields', (sourceHandle, targetHandle) => {
    const def = definition(); const before = JSON.stringify(def);
    const connection = { ...execution, sourceHandle, targetHandle };
    expect(isPlausibleConnection(connection)).toBe(false);
    expect(connect(def, connection)).toMatchObject({ ok: false, error: expect.stringContaining('cannot be mixed') });
    expect(JSON.stringify(def)).toBe(before);
  });

  it('adds one execution dependency with a parameter binding, including after a saved-definition round trip', () => {
    const result = ok(connect(definition(), parameter));
    expect(result.message).toContain('Also added execution dependency: Author → Reviewer');
    expect(result.addedControlEdgeId).toBe('ctrl_a_to_b');
    expect(result.definition.graph.dataEdges).toHaveLength(1);
    expect(result.definition.graph.controlEdges).toHaveLength(1);
    expect(validateWorkflowDefinition(result.definition).ok).toBe(true);
    const stored = JSON.parse(JSON.stringify(result.definition));
    const model = buildCanvasModel({ definition: stored, editable: true });
    expect(model.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: result.edgeIds[0], sourceHandle: 'out:result', targetHandle: 'in:result', hidden: true, data: expect.objectContaining({ control: false }) }),
      expect.objectContaining({ id: result.addedControlEdgeId, sourceHandle: 'ctrl-out', targetHandle: 'ctrl-in', data: expect.objectContaining({ control: true, label: 'After success' }) }),
    ]));
    expect(inspector(stored, { type: 'edge', edgeId: result.edgeIds[0]! })).toContain('Author → Reviewer · after success');
    const nodeHtml = inspector(stored, { type: 'node', nodeId: 'b' });
    expect(nodeHtml).toContain('Execution prerequisites'); expect(nodeHtml).toContain('result ← Author.result');
  });

  it('keeps explicit execution separate from parameters and reuses it without duplication', () => {
    const result = ok(connect(definition(), execution));
    expect(result.definition.graph.nodes.map(n => n.inputs)).toEqual([[], []]);
    expect(result.definition.graph.dataEdges).toEqual([]);
    const bound = ok(connect(result.definition, parameter));
    expect(bound.addedControlEdgeId).toBeUndefined(); expect(bound.definition.graph.controlEdges).toEqual(result.definition.graph.controlEdges);
    expect(bound.message).toContain('existing execution path');
    const html = inspector(bound.definition, { type: 'edge', edgeId: result.edgeIds[0]! });
    expect(html).toContain('Execution connection'); expect(html).toContain('also have parameter bindings');
  });

  it('does not bypass an existing conditional path, and explains where its dependency comes from', () => {
    const builder = createWorkflowBuilder('branches');
    for (const node of definition().graph.nodes) builder.addNode(node);
    const def = builder.connectControl('a', 'b', { kind: 'verdict_is', verdict: 'PASS' }).buildDefinition();
    const result = ok(connect(def, parameter));
    expect(result.definition.graph.controlEdges).toEqual(def.graph.controlEdges);
    expect(findExecutionPath(result.definition.graph, 'a', 'b')?.map(edge => edge.toNodeId)).toEqual(['b']);
    const html = inspector(result.definition, { type: 'edge', edgeId: result.edgeIds[0]! });
    expect(html).toContain('Author → Reviewer · if PASS');
    expect(html).not.toContain('Run “Reviewer” only when'); // Conditions belong to the execution line.
    expect(buildCanvasModel({ definition: result.definition }).edges.find(edge => edge.source === 'a' && edge.data.control)?.data.label).toBe('if PASS');
  });

  it('keeps workflow boundary inputs and previous-round feedback as parameter connections', () => {
    const input = { ...parameter, source: '$input', sourceHandle: 'out:request' };
    const withInput = { ...definition(), inputs: [{ name: 'request', type: 'string' as const, required: true }] };
    const supplied = ok(connect(withInput, input));
    expect(supplied.definition.graph.controlEdges).toEqual([]);
    expect(isPlausibleConnection({ ...execution, source: '$input' })).toBe(false);
    expect(isPlausibleConnection({ ...execution, target: '$output' })).toBe(false);
    const ordered = ok(connect(definition(), execution)).definition;
    const feedback = ok(connect(ordered, { ...parameter, source: 'b', target: 'a' }));
    expect(feedback.definition.graph.controlEdges).toEqual(ordered.graph.controlEdges);
    expect(feedback.definition.graph.dataEdges[0]!.required).toBe(false);
    expect(feedback.message).toContain('Previous-round');
    expect(inspector(feedback.definition, { type: 'edge', edgeId: feedback.edgeIds[0]! })).toContain('absent in the first round');
  });

  it('keeps remaining execution dependencies visible when a parameter binding is deleted', () => {
    const result = ok(connect(definition(), parameter));
    const removed = removeEdge(result.definition, result.edgeIds[0]!);
    expect(removed.graph.controlEdges).toEqual(result.definition.graph.controlEdges);
    expect(buildCanvasModel({ definition: removed }).edges.map(e => [e.source, e.target])).toEqual(expect.arrayContaining([['a', 'b']]));
    expect(buildCanvasModel({ definition: removed }).edges.filter(e => e.id === 'ctrl_a_to_b')).toHaveLength(1);
    expect(inspector(result.definition, { type: 'edge', edgeId: result.edgeIds[0]! })).toContain('keeps the execution lines');
    const withoutExecution = removeEdge(result.definition, result.addedControlEdgeId!);
    expect(withoutExecution.graph.dataEdges).toEqual(result.definition.graph.dataEdges);
  });

  it('preserves saved and automatic node positions when showing the previously hidden dependency', () => {
    const def = ok(connect(definition(), parameter)).definition;
    const dataOnly = { ...def, graph: { ...def.graph, controlEdges: [] } };
    const positions = (d: WorkflowDefinition) => buildCanvasModel({ definition: d }).nodes.map(n => [n.id, n.position]);
    expect(positions(def)).toEqual(positions(dataOnly));
    const layout = { a: { x: 123, y: 456 }, b: { x: 789, y: 42 } };
    const model = buildCanvasModel({ definition: def, layout, selectedNodeId: 'a' });
    for (const id of ['a', 'b'] as const) expect(model.nodes.find(n => n.id === id)?.position).toEqual(layout[id]);
    expect(model.nodes.map(n => n.data.kind)).toEqual(['inputs', 'agent', 'agent', 'outputs']);
  });

  it('draws the flow between steps and shows parameter lines only for the selected step', () => {
    const base = createWorkflowBuilder('flow')
      .addWorkflowInput({ name: 'topic', type: 'string', required: true })
      .addAgent({ id: 'a', name: 'Author', role: 'worker', goal: 'Write', inputs: [{ name: 'topic', type: 'string', required: true }], outputs: [{ name: 'draft', type: 'string', required: true }, { name: 'notes', type: 'string', required: true }] })
      .addAgent({ id: 'b', name: 'Reviewer', role: 'reviewer', goal: 'Review', inputs: [], outputs: [{ name: 'result', type: 'string', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'a', toPort: 'topic' })
      .buildDefinition();
    const once = ok(connect(base, { ...parameter, sourceHandle: 'out:draft' })).definition;
    const def = ok(connect(once, { ...parameter, sourceHandle: 'out:notes' })).definition;
    const shown = (selectedNodeId?: string) =>
      buildCanvasModel({ definition: def, ...(selectedNodeId ? { selectedNodeId } : {}) }).edges.filter(e => !e.hidden);
    // Unselected: one flow line per step, including from the inputs card that only passes a parameter.
    expect(shown().map(e => [e.source, e.target, e.sourceHandle, e.targetHandle])).toEqual(expect.arrayContaining([
      ['$input', 'a', 'ctrl-out', 'ctrl-in'], ['a', 'b', 'ctrl-out', 'ctrl-in'],
    ]));
    expect(shown().every(e => e.data.control)).toBe(true);
    expect(shown('b').filter(e => !e.data.control).map(e => e.sourceHandle)).toEqual(['out:draft', 'out:notes']);
    // A step that takes and gives nothing still hangs between the inputs and outputs cards.
    expect(shown().map(e => [e.source, e.target])).toEqual(expect.arrayContaining([['b', '$output']]));
    expect(shown('a').filter(e => !e.data.control)).toHaveLength(3);
  });

  it('turns cards round on a row that runs right to left, from where they are placed', () => {
    let builder = createWorkflowBuilder('snake');
    for (const id of ['a', 'b', 'c', 'd', 'e']) builder = builder.addAgent({ id, name: id.toUpperCase(), role: 'worker', goal: 'x' });
    const def = builder.connectControl('a', 'b').connectControl('b', 'c').connectControl('c', 'd').connectControl('d', 'e').buildDefinition();
    // a b c on the first row, then d below c and e left of it.
    const layout = { $input: { x: -400, y: 0 }, a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 800, y: 0 }, d: { x: 800, y: 500 }, e: { x: 400, y: 500 }, $output: { x: 0, y: 500 } };
    const model = buildCanvasModel({ definition: def, layout });
    const reversed = model.nodes.filter(n => n.data.reversed).map(n => n.id).sort();
    expect(reversed).toEqual(['$output', 'd', 'e']);
  });

  it('dims connections away from the selected card and labels its own, without changing the definition', () => {
    const first = ok(connect(definition(), parameter)).definition;
    const def = { ...first, graph: { ...first.graph, nodes: [...first.graph.nodes, { ...first.graph.nodes[1]!, id: 'c', name: 'Publish' }] } };
    const result = ok(connect(def, { ...parameter, source: 'b', target: 'c', targetHandle: 'in:result' })).definition;
    const before = JSON.stringify(result);
    const model = buildCanvasModel({ definition: result, selectedNodeId: 'a' });
    expect(model.edges.find(edge => !edge.data.control && edge.source === 'b')?.data.muted).toBe(true);
    expect(model.edges.find(edge => edge.source === 'a' && edge.target === 'b')?.data).toMatchObject({ muted: false, focused: true });
    expect(JSON.stringify(result)).toBe(before);
  });
});
