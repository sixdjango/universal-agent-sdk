import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  type AgentExecutionRequest,
  type AgentExecutionResult,
  createWorkflowRuntime,
  DeterministicClock,
  SequentialIdGenerator,
} from '../src/index';

function reviewFlow(maxTechnicalRetries = 0) {
  return createWorkflowBuilder('review-only')
    .addAgent({
      id: 'author',
      name: 'Author',
      role: 'author',
      goal: 'Write it',
      outputs: [{ name: 'draft', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'review',
      name: 'Review',
      role: 'reviewer',
      goal: 'Review it',
      acceptanceCriteria: ['Correct'],
      producesAssessment: true,
      maxTechnicalRetries,
      inputs: [{ name: 'draft', type: 'artifact', required: true }],
    })
    .connectData({ fromNodeId: 'author', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
    .buildDefinition();
}

function runtimeWith(review: (req: AgentExecutionRequest, call: number) => AgentExecutionResult) {
  const prompts: Record<string, string> = {};
  let reviewCalls = 0;
  const runtime = createWorkflowRuntime({
    clock: new DeterministicClock(),
    idGenerator: new SequentialIdGenerator(),
    executor: {
      async executeAgent(req) {
        prompts[req.node.id] = req.renderedPrompt;
        if (req.node.id === 'author') {
          return { status: 'COMPLETED', artifacts: { draft: { content: 'text' } } };
        }
        reviewCalls += 1;
        return review(req, reviewCalls);
      },
      async executeScript() {
        throw new Error('unused');
      },
    },
  });
  return { runtime, prompts, calls: () => reviewCalls };
}

describe('reviewer verdicts fail closed', () => {
  it('fails a reviewer that returns no assessment instead of treating it as PASS', async () => {
    const { runtime, calls } = runtimeWith(() => ({ status: 'COMPLETED', outputs: { notes: 'LGTM' } }));
    const started = await runtime.start({ definition: reviewFlow() });
    const done = await runtime.runUntilSettled(started.runId);

    expect(done.status).toBe('FAILED');
    const node = done.scopes.$root!.nodes.review!;
    expect(node.status).toBe('FAILED');
    expect(node.latestVerdict).toBeUndefined();
    expect(node.error).toContain('Reviewer node "review" returned no structured assessment');
    expect(calls()).toBe(1);
  });

  it('rejects verdicts outside PASS / NEEDS_FIX / FAIL / BLOCKED', async () => {
    const { runtime } = runtimeWith(() => ({
      status: 'COMPLETED',
      assessment: { verdict: 'LGTM' as never, summary: 'ship it' },
    }));
    const started = await runtime.start({ definition: reviewFlow() });
    const done = await runtime.runUntilSettled(started.runId);

    expect(done.status).toBe('FAILED');
    expect(done.scopes.$root!.nodes.review!.error).toContain('invalid verdict "LGTM"');
  });

  it('spends technical retries on a missing verdict and recovers when the retry returns one', async () => {
    const { runtime, calls } = runtimeWith((_req, call) =>
      call === 1
        ? { status: 'COMPLETED' }
        : { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'verified' } }
    );
    const started = await runtime.start({ definition: reviewFlow(1) });
    const done = await runtime.runUntilSettled(started.runId);

    expect(done.status).toBe('SUCCEEDED');
    expect(done.scopes.$root!.nodes.review!.latestVerdict).toBe('PASS');
    expect(done.scopes.$root!.nodes.review!.retryCount).toBe(1);
    expect(calls()).toBe(2);
  });

  it('tells every agent the output contract and reviewers that the verdict is mandatory', async () => {
    const { runtime, prompts } = runtimeWith(() => ({
      status: 'COMPLETED',
      assessment: { verdict: 'PASS', summary: 'ok' },
    }));
    const started = await runtime.start({ definition: reviewFlow() });
    await runtime.runUntilSettled(started.runId);

    expect(prompts.author).toContain('## Output Contract');
    expect(prompts.author).toContain('```ua-workflow-result');
    expect(prompts.author).toContain('"draft"');
    expect(prompts.author).not.toContain('verdict');
    expect(prompts.review).toContain('"verdict": "PASS | NEEDS_FIX | FAIL | BLOCKED"');
    expect(prompts.review).toContain('A reply without a valid verdict is treated as a failed review, not a pass.');
  });
});

describe('loops only succeed on a passing verdict', () => {
  /** loop(author -> review) -> ship, where ship only runs "if PASS". */
  function loopThenShip(reviewerVerdict: (round: number) => 'PASS' | 'NEEDS_FIX' | 'FAIL' | 'BLOCKED', options: { chief?: boolean } = {}) {
    const builder = createWorkflowBuilder('loop-verdicts')
      .addLoop({
        id: 'fix_loop',
        name: 'Fix loop',
        maxRounds: 3,
        continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'review' },
        outputs: [{ name: 'result', type: 'artifact', required: true }],
        body: (b) =>
          b
            .addAgent({ id: 'author', name: 'Author', role: 'author', goal: 'Write', outputs: [{ name: 'result', type: 'artifact', required: true }] })
            .addAgent({
              id: 'review',
              name: 'Review',
              role: 'reviewer',
              goal: 'Review',
              producesAssessment: true,
              inputs: [{ name: 'result', type: 'artifact', required: true }],
            })
            .connectData({ fromNodeId: 'author', fromPort: 'result', toNodeId: 'review', toPort: 'result', withControl: true })
            .connectData({ fromNodeId: 'author', fromPort: 'result', toNodeId: '$output', toPort: 'result' }),
      })
      .addAgent({ id: 'ship', name: 'Ship', role: 'author', goal: 'Ship it' })
      .connectControl('fix_loop', 'ship', { kind: 'verdict_is', verdict: 'PASS' });
    if (options.chief) builder.setChief({});

    let round = 0;
    const shipped: string[] = [];
    const chiefTriggers: string[] = [];
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      ...(options.chief
        ? {
            chief: {
              async review(input) {
                chiefTriggers.push(`${input.trigger.kind}:${input.trigger.nodeId}`);
                return { rationale: '', commands: [] };
              },
            },
          }
        : {}),
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'author') return { status: 'COMPLETED', artifacts: { result: { content: `v${round}` } } };
          if (req.node.id === 'ship') {
            shipped.push('shipped');
            return { status: 'COMPLETED' };
          }
          round += 1;
          return { status: 'COMPLETED', assessment: { verdict: reviewerVerdict(round), summary: `round ${round} review` } };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    return { definition: builder.buildDefinition(), runtime, shipped, chiefTriggers };
  }

  it.each(['FAIL', 'BLOCKED'] as const)('fails the loop when the reviewer returns %s, and nothing after it runs', async (verdict) => {
    const { definition, runtime, shipped } = loopThenShip((r) => (r === 1 ? 'NEEDS_FIX' : verdict));
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);

    expect(done.status).toBe('FAILED');
    const loop = done.scopes.$root!.nodes.fix_loop!;
    expect(loop.status).toBe('FAILED');
    expect(loop.latestVerdict).toBe(verdict);
    expect(loop.error).toBe(`Loop "fix_loop" stopped in round 2: "Review" returned ${verdict} (round 2 review)`);
    expect(shipped).toEqual([]);
  });

  it('still succeeds on PASS and lets "if PASS" steps run', async () => {
    const { definition, runtime, shipped } = loopThenShip((r) => (r === 1 ? 'NEEDS_FIX' : 'PASS'));
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.scopes.$root!.nodes.fix_loop!.latestVerdict).toBe('PASS');
    expect(shipped).toEqual(['shipped']);
  });

  it('tells the chief when a loop fails on its verdict', async () => {
    const { definition, runtime, chiefTriggers } = loopThenShip(() => 'BLOCKED', { chief: true });
    await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(chiefTriggers).toContain('node.failed:fix_loop');
  });

  it('does not invent a PASS when the deciding step has no verdict', async () => {
    const definition = createWorkflowBuilder('no-verdict-loop')
      .addLoop({
        id: 'once',
        name: 'Once',
        maxRounds: 2,
        continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'work' },
        body: (b) => b.addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' }),
      })
      .buildDefinition();
    const runtime = createWorkflowRuntime({
      executor: {
        async executeAgent() {
          return { status: 'COMPLETED' };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.scopes.$root!.nodes.once!.latestVerdict).toBeUndefined();
  });
});
