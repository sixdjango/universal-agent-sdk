import { createWorkflowBuilder, type LoopNode, validateWorkflowDefinition } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, DeterministicClock, SequentialIdGenerator } from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel, compilePlan } from '../src/model/canvas';
import { expandLoopIntoCycle } from '../src/model/cycle-editing';
import { connect, setEdgeCondition } from '../src/model/editing';

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error((result as unknown as { error: string }).error);
  return result as Extract<T, { ok: true }>;
}

/** write -> review -> ship (if PASS), then the user drags review back to write. */
function drawn() {
  let d = createWorkflowBuilder('drawn')
    .addAgent({ id: 'write', name: 'Write', role: 'author', goal: 'x', outputs: [{ name: 'draft', type: 'artifact', required: true }] })
    .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'x', producesAssessment: true, inputs: [{ name: 'draft', type: 'artifact', required: true }] })
    .addAgent({ id: 'ship', name: 'Ship', role: 'author', goal: 'x' })
    .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
    .buildDefinition();
  const forward = ok(connect(d, { source: 'review', sourceHandle: 'ctrl-out', target: 'ship', targetHandle: 'ctrl-in' }));
  d = setEdgeCondition(forward.definition, forward.edgeIds[0]!, { kind: 'verdict_is', verdict: 'PASS' });
  d = ok(connect(d, { source: 'review', sourceHandle: 'ctrl-out', target: 'write', targetHandle: 'ctrl-in' })).definition;
  return { definition: d };
}

describe('loops drawn on the canvas', () => {
  it('turns a connection from a step back to an earlier one into a way back decided by that step', () => {
    const { definition } = drawn();
    const edges = definition.graph.controlEdges.filter((e) => e.fromNodeId === 'review');
    expect(edges).toEqual([
      expect.objectContaining({ toNodeId: 'ship', when: { kind: 'verdict_is', verdict: 'PASS' } }),
      expect.objectContaining({ toNodeId: 'write', when: { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, loop: { maxRounds: 3, onExhausted: 'fail' } }),
    ]);
    expect(validateWorkflowDefinition(definition).ok).toBe(true);
    // A step closes one loop.
    expect(connect(definition, { source: 'review', sourceHandle: 'ctrl-out', target: 'review', targetHandle: 'ctrl-in' }).ok).toBe(false);
    // A step connected to itself repeats on its own result.
    const self = ok(connect(definition, { source: 'ship', sourceHandle: 'ctrl-out', target: 'ship', targetHandle: 'ctrl-in' })).definition;
    expect(self.graph.controlEdges.find((e) => e.fromNodeId === 'ship' && e.toNodeId === 'ship')).toMatchObject({ loop: { maxRounds: 3 } });
    expect(validateWorkflowDefinition(self).ok).toBe(true);
  });

  it('shows the flat graph with a loop region, the way back and the branch out of it', () => {
    const { definition } = drawn();
    const model = buildCanvasModel({ definition, editable: true });
    expect(model.nodes.map((n) => n.id).sort()).toEqual(['$input', '$output', 'review', 'ship', 'write'].sort());
    expect(model.loops).toEqual([
      expect.objectContaining({ deciderId: 'review', headId: 'write', memberIds: ['write', 'review'], maxRounds: 3 }),
    ]);
    expect(model.edges.find((e) => e.type === 'loop')).toMatchObject({ source: 'review', target: 'write', data: { label: 'NEEDS_FIX → again · max 3' } });
    expect(model.edges.find((e) => e.source === 'review' && e.target === 'ship')?.data).toMatchObject({ label: 'if PASS', pinned: true });
    expect(model.nodes.find((n) => n.id === 'review')!.data).toMatchObject({ loopRole: 'decider', loopRepeat: 'NEEDS_FIX' });
    expect(model.nodes.find((n) => n.id === 'write')!.data.loopRole).toBe('start');
  });

  it('folds the shown round of a run onto the flat graph', async () => {
    const { definition } = drawn();
    let reviews = 0;
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          if (req.node.id !== 'review') return { status: 'COMPLETED', artifacts: { draft: { content: 'd' } } };
          reviews += 1;
          return { status: 'COMPLETED', assessment: { verdict: reviews < 2 ? 'NEEDS_FIX' : 'PASS', summary: '' } };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const run = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(run.status).toBe('SUCCEEDED');

    const latest = buildCanvasModel({ definition, run });
    const region = latest.loops![0]!;
    expect(region.rounds.map((r) => r.verdict)).toEqual(['NEEDS_FIX', 'PASS']);
    expect(region.shownRound).toBe(1);
    const status = (m: typeof latest, id: string) => m.nodes.find((n) => n.id === id)!.data;
    expect(status(latest, 'review')).toMatchObject({ status: 'succeeded', verdict: 'PASS' });
    expect(status(latest, 'ship').status).toBe('succeeded');
    // Card history spans both rounds.
    expect(status(latest, 'review').activity.length).toBe(2);

    const first = buildCanvasModel({ definition, run, loopRounds: { [region.loopId]: 0 } });
    expect(status(first, 'review').verdict).toBe('NEEDS_FIX');
    expect(first.edges.find((e) => e.type === 'loop')!.data.tone).toBe('delivered');
  });

  it('expands a loop container into the flat form without changing what runs', () => {
    const container = createWorkflowBuilder('box')
      .addWorkflowInput({ name: 'topic', type: 'string', required: true })
      .addLoop({
        id: 'fix',
        name: 'Until it passes',
        maxRounds: 4,
        onExhausted: 'gate',
        continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'review' },
        inputs: [{ name: 'topic', type: 'string', required: true }],
        outputs: [{ name: 'draft', type: 'artifact', required: true }],
        body: (b) =>
          b
            .addAgent({ id: 'write', name: 'Write', role: 'author', goal: 'x', inputs: [{ name: 'topic', type: 'string', required: true }], outputs: [{ name: 'draft', type: 'artifact', required: true }] })
            .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'x', producesAssessment: true, inputs: [{ name: 'draft', type: 'artifact', required: true }] })
            .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'write', toPort: 'topic' })
            .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
            .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: '$output', toPort: 'draft' }),
      })
      .addAgent({ id: 'ship', name: 'Ship', role: 'author', goal: 'x', inputs: [{ name: 'draft', type: 'artifact', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'fix', toPort: 'topic' })
      .connectData({ fromNodeId: 'fix', fromPort: 'draft', toNodeId: 'ship', toPort: 'draft', withControl: true })
      .buildDefinition();

    const expanded = ok(expandLoopIntoCycle(container, 'fix'));
    const g = expanded.definition.graph;
    expect(expanded.deciderId).toBe('review');
    expect(g.nodes.map((n) => n.id)).toEqual(['write', 'review', 'ship']);
    expect(g.controlEdges.find((e) => e.loop)).toMatchObject({ fromNodeId: 'review', toNodeId: 'write', when: { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, loop: { maxRounds: 4, onExhausted: 'gate' } });
    expect(g.dataEdges.map((e) => `${e.fromNodeId}.${e.fromPort}->${e.toNodeId}.${e.toPort}`).sort()).toEqual(
      ['$input.topic->write.topic', 'write.draft->review.draft', 'write.draft->ship.draft'].sort()
    );

    // It compiles back into the same kind of loop.
    const plan = compilePlan(expanded.definition);
    const loop = plan.rootScope.nodesById.review__loop as LoopNode;
    expect(plan.rootScope.topologicalOrder).toEqual(['review__loop', 'ship']);
    expect(loop).toMatchObject({ maxRounds: 4, onExhausted: 'gate', continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'review' } });
    expect(plan.rootScope.childScopes.review__loop!.topologicalOrder).toEqual(['write', 'review']);
  });
});
