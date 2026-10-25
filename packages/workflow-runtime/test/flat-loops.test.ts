import { createWorkflowBuilder, type AssessmentVerdict } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  type AgentExecutionRequest,
  createWorkflowRuntime,
  DeterministicClock,
  SequentialIdGenerator,
} from '../src/index';

function flow(maxRounds = 3, onExhausted: 'fail' | 'gate' | 'pass_with_findings' = 'fail') {
  return createWorkflowBuilder('flat')
    .addAgent({
      id: 'write',
      name: 'Write',
      role: 'author',
      goal: 'x',
      inputs: [{ name: 'feedback', type: 'assessment', required: false }],
      outputs: [{ name: 'draft', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'review',
      name: 'Review',
      role: 'reviewer',
      goal: 'x',
      producesAssessment: true,
      inputs: [{ name: 'draft', type: 'artifact', required: true }],
      outputs: [{ name: 'notes', type: 'json', required: true }],
    })
    .addAgent({ id: 'ship', name: 'Ship', role: 'author', goal: 'x' })
    .addAgent({ id: 'escalate', name: 'Escalate', role: 'author', goal: 'x' })
    .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
    .connectData({ fromNodeId: 'review', fromPort: 'notes', toNodeId: 'write', toPort: 'feedback' })
    .connectControl('review', 'ship', { kind: 'verdict_is', verdict: 'PASS' })
    .connectControl('review', 'escalate', { kind: 'otherwise' })
    .loopBack('review', 'write', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds, onExhausted })
    .buildDefinition();
}

function runtimeWith(verdicts: AssessmentVerdict[]) {
  const seen: AgentExecutionRequest[] = [];
  let round = 0;
  const runtime = createWorkflowRuntime({
    clock: new DeterministicClock(),
    idGenerator: new SequentialIdGenerator(),
    executor: {
      async executeAgent(req) {
        seen.push(req);
        if (req.node.id === 'write') return { status: 'COMPLETED', artifacts: { draft: { content: `draft ${round + 1}` } } };
        if (req.node.id === 'review') {
          const verdict = verdicts[round] ?? 'PASS';
          round += 1;
          return { status: 'COMPLETED', outputs: { notes: { round } }, assessment: { verdict, summary: `round ${round}`, findings: [] } };
        }
        return { status: 'COMPLETED' };
      },
      async executeScript() {
        throw new Error('unused');
      },
    },
  });
  return { runtime, seen };
}

describe('loops drawn as a way back from the deciding step', () => {
  it('repeats while the condition sends it back, hands values to the next round, then moves on', async () => {
    const { runtime, seen } = runtimeWith(['NEEDS_FIX', 'NEEDS_FIX', 'PASS']);
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow() })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(seen.map((r) => r.node.id)).toEqual(['write', 'review', 'write', 'review', 'write', 'review', 'ship']);

    const writes = seen.filter((r) => r.node.id === 'write');
    expect(writes.map((r) => r.inputs.feedback)).toEqual([undefined, { round: 1 }, { round: 2 }]);
    expect(writes[1]!.scopeKey).toBe('$root/review__loop:round_1');
    expect(done.scopes['$root/review__loop:round_2']!.nodes.review).toMatchObject({ status: 'SUCCEEDED', latestVerdict: 'PASS' });
    expect(done.scopes.$root!.nodes.escalate!.status).toBe('SKIPPED');
  });

  it('takes the otherwise branch for results no other branch handles', async () => {
    const { runtime, seen } = runtimeWith(['BLOCKED']);
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow() })).runId);
    // BLOCKED stops the loop as a failure (never a pass), so nothing after it runs.
    expect(done.status).toBe('FAILED');
    expect(seen.map((r) => r.node.id)).toEqual(['write', 'review']);
  });

  it('applies the round limit and what to do when rounds run out', async () => {
    const { runtime, seen } = runtimeWith(['NEEDS_FIX', 'NEEDS_FIX', 'NEEDS_FIX']);
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow(2, 'pass_with_findings') })).runId);
    expect(seen.filter((r) => r.node.id === 'review')).toHaveLength(2);
    expect(done.scopes.$root!.nodes.review__loop!.status).toBe('SUCCEEDED');
  });

  it('branches on a step\'s result straight from its edges, otherwise included', async () => {
    const definition = createWorkflowBuilder('branch')
      .addScript({ id: 'probe', name: 'Probe', command: 'x', outputs: [{ name: 'mode', type: 'string', required: true }] })
      .addAgent({ id: 'fast', name: 'Fast', role: 'author', goal: 'x' })
      .addAgent({ id: 'slow', name: 'Slow', role: 'author', goal: 'x' })
      .connectControl('probe', 'fast', { kind: 'port_equals', port: 'mode', value: 'fast' })
      .connectControl('probe', 'slow', { kind: 'otherwise' })
      .buildDefinition();
    const ran: string[] = [];
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          ran.push(req.node.id);
          return { status: 'COMPLETED' };
        },
        async executeScript() {
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, outputs: { mode: 'thorough' } };
        },
      },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(ran).toEqual(['slow']);
    expect(done.scopes.$root!.nodes.fast!.status).toBe('SKIPPED');
  });
});
