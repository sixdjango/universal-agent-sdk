import { describe, expect, it } from 'vitest';
import { analyzeLoopBacks, createWorkflowBuilder, type LoopNode, validateWorkflowDefinition } from '../src/index';

/** request -> write -> review (PASS -> ship, NEEDS_FIX -> back to write, max 4). */
function flatLoop() {
  return createWorkflowBuilder('flat')
    .addWorkflowInput({ name: 'request', type: 'string', required: true })
    .addWorkflowOutput({ name: 'notes', type: 'artifact', required: true })
    .addAgent({
      id: 'write',
      name: 'Write',
      role: 'author',
      goal: 'x',
      inputs: [
        { name: 'request', type: 'string', required: true },
        { name: 'feedback', type: 'assessment', required: false },
      ],
      outputs: [{ name: 'draft', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'review',
      name: 'Review',
      role: 'reviewer',
      goal: 'x',
      producesAssessment: true,
      inputs: [{ name: 'draft', type: 'artifact', required: true }],
      outputs: [{ name: 'assessment', type: 'assessment', required: true }],
    })
    .addAgent({ id: 'ship', name: 'Ship', role: 'author', goal: 'x', inputs: [{ name: 'draft', type: 'artifact', required: true }], outputs: [{ name: 'notes', type: 'artifact', required: true }] })
    .connectData({ fromNodeId: '$input', fromPort: 'request', toNodeId: 'write', toPort: 'request' })
    .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
    .connectControl('review', 'ship', { kind: 'verdict_is', verdict: 'PASS' })
    .loopBack('review', 'write', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 4, onExhausted: 'gate' })
    // The previous round's review goes back to the writer.
    .connectData({ fromNodeId: 'review', fromPort: 'assessment', toNodeId: 'write', toPort: 'feedback' })
    .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'ship', toPort: 'draft' })
    .connectData({ fromNodeId: 'ship', fromPort: 'notes', toNodeId: '$output', toPort: 'notes' })
    .buildDefinition();
}

describe('loops drawn as cycles', () => {
  it('finds the loop, its steps, and the data edge that carries a value round', () => {
    const analysis = analyzeLoopBacks(flatLoop().graph);
    expect(analysis.issues).toEqual([]);
    expect(analysis.loops).toHaveLength(1);
    expect(analysis.loops[0]).toMatchObject({ deciderId: 'review', headId: 'write', bodyIds: ['write', 'review'], loopId: 'review__loop' });
    expect([...analysis.carryEdgeIds]).toEqual(['data_review.assessment_to_write.feedback']);
  });

  it('compiles the cycle into a LoopNode the runtime already knows', () => {
    const result = validateWorkflowDefinition(flatLoop());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const root = result.plan.rootScope;
    // The plan keeps the definition as drawn.
    expect(result.plan.definition.graph.nodes.map((n) => n.id)).toEqual(['write', 'review', 'ship']);
    expect(root.topologicalOrder).toEqual(['review__loop', 'ship']);
    const loop = root.nodesById.review__loop as LoopNode;
    expect(loop).toMatchObject({
      name: 'Review',
      maxRounds: 4,
      onExhausted: 'gate',
      continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'review' },
      origin: { deciderId: 'review', backEdgeId: 'loop_review_to_write' },
      carry: [{ fromNodeId: 'review', fromPort: 'assessment', toPort: 'carry__write__feedback' }],
    });
    expect(loop.inputs.map((p) => p.name).sort()).toEqual(['carry__write__feedback', 'in__write__request']);
    expect(loop.outputs.map((p) => p.name)).toEqual(['out__write__draft']);
    expect(root.childScopes.review__loop!.topologicalOrder).toEqual(['write', 'review']);
    // Leaving the loop: "if PASS" now hangs off the loop, whose verdict is the decider's.
    expect(root.incomingControlEdges.ship).toEqual([
      expect.objectContaining({ fromNodeId: 'review__loop', when: { kind: 'verdict_is', verdict: 'PASS' } }),
    ]);
    expect(root.incomingDataEdges.ship).toEqual([expect.objectContaining({ fromNodeId: 'review__loop', fromPort: 'out__write__draft' })]);
  });

  it('reports ways back that cannot form a loop, against the graph as drawn', () => {
    const issuesOf = (build: (b: ReturnType<typeof createWorkflowBuilder>) => ReturnType<typeof createWorkflowBuilder>) => {
      const result = validateWorkflowDefinition(
        build(
          createWorkflowBuilder('bad')
            .addAgent({ id: 'a', name: 'A', role: 'author', goal: 'x' })
            .addAgent({ id: 'b', name: 'B', role: 'author', goal: 'x' })
            .connectControl('a', 'b')
        ).buildDefinition()
      );
      return result.ok ? [] : result.issues.map((i) => `${i.code}@${i.scopePath}: ${i.message}`);
    };
    expect(issuesOf((b) => b.loopBack('b', 'a', { kind: 'always' }))).toEqual([
      expect.stringContaining('INVALID_LOOP_BACK@$root: The way back from "B" needs a condition'),
    ]);
    expect(issuesOf((b) => b.loopBack('a', 'b', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }))).toEqual([
      expect.stringContaining('must return to a step that leads to it'),
    ]);
    // A plain cycle without a way back is still an error, with a hint.
    expect(issuesOf((b) => b.connectControl('b', 'a', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }))[0]).toContain('Close a loop with a way back');
    // A branch condition must check a step of this graph.
    expect(issuesOf((b) => b.connectControl('b', 'a', { kind: 'verdict_is', verdict: 'PASS', sourceNodeId: 'ghost' }, 'x').loopBack('b', 'a', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }))).toEqual(
      expect.arrayContaining([expect.stringContaining('checks "ghost"')])
    );
  });

  it('nests loops drawn inside loops', () => {
    const definition = createWorkflowBuilder('nested')
      .addAgent({ id: 'plan', name: 'Plan', role: 'author', goal: 'x' })
      .addAgent({ id: 'build', name: 'Build', role: 'author', goal: 'x' })
      .addScript({ id: 'test', name: 'Test', command: 'true' })
      .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'x', producesAssessment: true })
      .connectControl('plan', 'build')
      .connectControl('build', 'test')
      .loopBack('test', 'build', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 5 })
      .connectControl('test', 'review', { kind: 'verdict_is', verdict: 'PASS' })
      .loopBack('review', 'plan', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2 })
      .buildDefinition();
    const result = validateWorkflowDefinition(definition);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const outer = result.plan.rootScope.childScopes.review__loop!;
    expect(result.plan.rootScope.topologicalOrder).toEqual(['review__loop']);
    expect(outer.topologicalOrder).toEqual(['plan', 'test__loop', 'review']);
    expect(outer.childScopes.test__loop!.topologicalOrder).toEqual(['build', 'test']);
  });
});

describe('compound edge conditions', () => {
  const step = (id: string) => ({ id, name: id, role: 'worker', goal: id, outputs: [{ name: 'score', type: 'number' as const, required: true }] });

  it('checks every step a compound condition names, and refuses "otherwise" inside one', () => {
    const definition = createWorkflowBuilder('compound')
      .addAgent(step('a'))
      .addAgent(step('b'))
      .connectControl('a', 'b', {
        kind: 'all',
        conditions: [
          { kind: 'port_compare', port: 'score', op: '>', value: 1 },
          { kind: 'any', conditions: [{ kind: 'verdict_is', verdict: 'PASS', sourceNodeId: 'ghost' }, { kind: 'otherwise' }] },
        ],
      })
      .buildDefinition();
    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.message)).toEqual([
      expect.stringContaining('checks "ghost"'),
      expect.stringContaining('puts "otherwise" inside'),
    ]);
  });

  it('lets a way back repeat on a compound condition, aimed at the deciding step', () => {
    const definition = createWorkflowBuilder('compound-loop')
      .addAgent(step('build'))
      .addAgent({ ...step('check'), producesAssessment: true })
      .connectControl('build', 'check')
      .loopBack('check', 'build', {
        kind: 'any',
        conditions: [
          { kind: 'verdict_is', verdict: 'NEEDS_FIX' },
          { kind: 'port_compare', port: 'score', op: '<', value: 80 },
        ],
      })
      .buildDefinition();
    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loop = result.plan.rootScope.nodesById['check__loop'] as LoopNode;
    expect(loop.continueWhen).toEqual({
      kind: 'any',
      conditions: [
        { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'check' },
        { kind: 'port_compare', port: 'score', op: '<', value: 80, sourceNodeId: 'check' },
      ],
    });
  });
});
