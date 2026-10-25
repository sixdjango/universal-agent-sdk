import { describe, expect, it } from 'vitest';
import { createWorkflowBuilder, type LoopNode, resolveSubflows, validateWorkflowDefinition, type WorkflowDefinition } from '../src/index';

const review = createWorkflowBuilder('review-flow', 'Review flow')
  .addWorkflowInput({ name: 'draft', type: 'artifact', required: true })
  .addWorkflowOutput({ name: 'verdict', type: 'json', required: true })
  .addAgent({ id: 'critic', name: 'Critic', role: 'reviewer', goal: 'x', producesAssessment: true, workspace: 'docs', inputs: [{ name: 'draft', type: 'artifact', required: true }], outputs: [{ name: 'notes', type: 'json', required: true }] })
  .connectData({ fromNodeId: '$input', fromPort: 'draft', toNodeId: 'critic', toPort: 'draft' })
  .connectData({ fromNodeId: 'critic', fromPort: 'notes', toNodeId: '$output', toPort: 'verdict' })
  .addWorkspace({ name: 'docs' })
  .buildDefinition();

function parent(): WorkflowDefinition {
  const p = createWorkflowBuilder('main', 'Main')
    .addAgent({ id: 'write', name: 'Write', role: 'author', goal: 'x', outputs: [{ name: 'draft', type: 'artifact', required: true }] })
    .addNode({
      kind: 'subflow',
      id: 'check',
      name: 'Run the review flow',
      workflowId: 'review-flow',
      inputs: [{ name: 'draft', type: 'artifact', required: true }],
      outputs: [{ name: 'verdict', type: 'json', required: true }],
      writeScopes: [],
      maxTechnicalRetries: 0,
    })
    .addAgent({ id: 'ship', name: 'Ship', role: 'author', goal: 'x', inputs: [{ name: 'verdict', type: 'json', required: true }] })
    .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'check', toPort: 'draft', withControl: true })
    .connectData({ fromNodeId: 'check', fromPort: 'verdict', toNodeId: 'ship', toPort: 'verdict', withControl: true })
    .buildDefinition();
  return p;
}

describe('sub-flows', () => {
  it('validates a sub-flow step by its ports before it is resolved', () => {
    expect(validateWorkflowDefinition(parent()).ok).toBe(true);
  });

  it('embeds the workflow when resolved and compiles it as a single run', async () => {
    const library = new Map([[review.id, review]]);
    const resolved = await resolveSubflows(parent(), async (id) => library.get(id));
    const node = resolved.graph.nodes.find((n) => n.id === 'check')!;
    expect(node.kind === 'subflow' && node.snapshot).toMatchObject({ workflowId: 'review-flow', name: 'Review flow', digest: expect.stringMatching(/^sha256:/) });

    const result = validateWorkflowDefinition(resolved);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const loop = result.plan.rootScope.nodesById.check as LoopNode;
    expect(loop).toMatchObject({ kind: 'loop', maxRounds: 1, origin: { subflowOf: 'review-flow' } });
    expect(result.plan.rootScope.childScopes.check!.topologicalOrder).toEqual(['critic']);
    // The child's workspace slot is unknown to the parent, so its step uses the parent's.
    expect(loop.bodyGraph.nodes[0]!.workspace).toBeUndefined();
  });

  it('refuses unknown workflows and circles', async () => {
    await expect(resolveSubflows(parent(), async () => undefined)).rejects.toThrow('does not exist');
    const loopy = { ...review, graph: { ...review.graph, nodes: [...review.graph.nodes, { ...parent().graph.nodes[1]!, id: 'again', workflowId: 'main' }] } } as WorkflowDefinition;
    const library = new Map<string, WorkflowDefinition>([[review.id, loopy], ['main', parent()]]);
    await expect(resolveSubflows(parent(), async (id) => library.get(id))).rejects.toThrow('run in a circle: main → review-flow → main');
  });
});
