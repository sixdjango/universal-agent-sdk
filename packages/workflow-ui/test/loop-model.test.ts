import { createWorkflowBuilder, type LoopNode } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, DeterministicClock, SequentialIdGenerator } from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel } from '../src/model/canvas';
import { describeContainerRule, describeLoop } from '../src/model/loop';

function haikuLoop(extra: Partial<LoopNode> = {}) {
  return createWorkflowBuilder('haiku')
    .addLoop({
      id: 'fix',
      name: 'Fix',
      maxRounds: 3,
      onExhausted: 'gate',
      continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX' },
      body: (b) =>
        b
          .addAgent({ id: 'draft', name: 'Draft', role: 'author', goal: 'x' })
          .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'x', producesAssessment: true })
          .connectControl('draft', 'review'),
      ...extra,
    })
    .buildDefinition();
}

describe('loop description', () => {
  it('names the deciding step (the last one when the condition names none) and spells out the rule', () => {
    const definition = haikuLoop();
    const loop = definition.graph.nodes[0] as LoopNode;
    const summary = describeLoop(loop, ['draft', 'review']);
    expect(summary).toMatchObject({
      deciderId: 'review',
      repeatWhen: '“Review” returns NEEDS_FIX',
      endsWhen: 'PASS finishes · FAIL or BLOCKED stops it',
      repeatLabel: 'NEEDS_FIX',
      maxRounds: 3,
      whenOutOfRounds: 'ask you',
      rounds: [],
    });
    expect(describeContainerRule(loop, ['draft', 'review'])).toContain('then it will ask you');

    const always = describeLoop({ ...loop, continueWhen: { kind: 'always' }, onExhausted: 'pass_with_findings' }, ['draft']);
    expect(always).toMatchObject({ deciderId: 'draft', repeatWhen: 'every round, until the limit', whenOutOfRounds: 'continue with the open findings' });
  });

  it('shows each round of a run, and marks the decider and the way back inside the body', async () => {
    let round = 0;
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          if (req.node.id !== 'review') return { status: 'COMPLETED' };
          round += 1;
          return { status: 'COMPLETED', assessment: { verdict: round < 3 ? 'NEEDS_FIX' : 'PASS', summary: '' } };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const definition = haikuLoop();
    const run = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const outer = buildCanvasModel({ definition, run });
    const card = outer.nodes.find((n) => n.id === 'fix')!.data;
    expect(card.subtitle).toBe('Round 3 of 3');
    expect(card.loop!.rounds.map((r) => [r.number, r.state, r.verdict])).toEqual([
      [1, 'again', 'NEEDS_FIX'],
      [2, 'again', 'NEEDS_FIX'],
      [3, 'passed', 'PASS'],
    ]);

    const inner = buildCanvasModel({ definition, run, path: ['fix'], scopeKey: '$root/fix:round_2' });
    expect(inner.nodes.find((n) => n.id === 'review')!.data).toMatchObject({ loopRole: 'decider', loopRepeat: 'NEEDS_FIX' });
    expect(inner.nodes.find((n) => n.id === '$input')!.data.loopRole).toBe('start');
    expect(inner.edges.find((e) => e.type === 'loop')).toMatchObject({ source: 'review', target: '$input', data: { tone: 'delivered' } });
    expect(inner.banner).toMatchObject({ kind: 'loop', title: 'Loop · Fix' });
    expect(buildCanvasModel({ definition }).banner).toBeUndefined();
  });
});
