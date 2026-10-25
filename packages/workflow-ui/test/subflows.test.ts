import { createWorkflowBuilder, resolveSubflows, validateWorkflowDefinition, withEmbeddedSubflows } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel } from '../src/model/canvas';
import { addNode, setSubflowWorkflow } from '../src/model/editing';

const child = createWorkflowBuilder('child', 'Child flow')
  .addWorkflowInput({ name: 'topic', type: 'string', required: true })
  .addWorkflowOutput({ name: 'summary', type: 'string', required: true })
  .addAgent({ id: 'inner', name: 'Inner', role: 'author', goal: 'x', inputs: [{ name: 'topic', type: 'string', required: true }], outputs: [{ name: 'summary', type: 'string', required: true }] })
  .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'inner', toPort: 'topic' })
  .connectData({ fromNodeId: 'inner', fromPort: 'summary', toNodeId: '$output', toPort: 'summary' })
  .buildDefinition();

function parent() {
  const base = createWorkflowBuilder('parent').addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x' }).buildDefinition();
  const added = addNode(base, 'subflow');
  if (!added.ok) throw new Error(added.error);
  return { definition: setSubflowWorkflow(added.definition, added.nodeId, child), id: added.nodeId };
}

describe('sub-flow steps', () => {
  it('take the chosen workflow’s fields and name, and validate as plain steps', () => {
    const { definition, id } = parent();
    expect(definition.graph.nodes.find((n) => n.id === id)).toMatchObject({
      kind: 'subflow',
      workflowId: 'child',
      name: 'Child flow',
      inputs: [{ name: 'topic' }],
      outputs: [{ name: 'summary' }],
    });
    const result = validateWorkflowDefinition(definition);
    // Its required input still needs wiring, like any step's.
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['MISSING_REQUIRED_INPUT_BINDING']);
  });

  it('show the workflow they run in design, and open into its steps once embedded', async () => {
    const { definition, id } = parent();
    const design = buildCanvasModel({ definition, workflowNames: { child: 'Child flow' }, editable: true });
    const card = design.nodes.find((n) => n.id === id)!.data;
    expect(card).toMatchObject({ kind: 'subflow', subflowOf: 'child', subtitle: 'Sub-flow' });
    expect(card.rows.find((r) => r.id === 'workflow')).toMatchObject({ value: 'Child flow', kind: 'open' });
    expect(card.rows.some((r) => r.kind === 'add')).toBe(false);

    const embedded = withEmbeddedSubflows(await resolveSubflows(definition, async (wid) => (wid === 'child' ? child : null)));
    const view = buildCanvasModel({ definition: embedded, workflowNames: { child: 'Child flow' } });
    const embeddedCard = view.nodes.find((n) => n.id === id)!.data;
    expect(embeddedCard).toMatchObject({ kind: 'subflow', subtitle: 'Child flow' });
    expect(embeddedCard.loop).toBeUndefined();
    expect(embeddedCard.rows.find((r) => r.id === 'open')).toBeDefined();

    const inside = buildCanvasModel({ definition: embedded, path: [id], workflowNames: { child: 'Child flow' } });
    expect(inside.banner?.title).toBe('Sub-flow · Child flow');
    expect(inside.nodes.map((n) => n.id)).toContain('inner');
    expect(inside.edges.some((e) => e.type === 'loop')).toBe(false);
  });
});
