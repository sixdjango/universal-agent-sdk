import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { createWorkflowRuntime, DeterministicClock, RunCancelledError, SequentialIdGenerator } from '../src/index';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('cancelling a run', () => {
  it('stops it for good: late results are dropped and nothing starts again', async () => {
    const started = deferred();
    const finish = deferred();
    const calls: string[] = [];
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          calls.push(req.node.id);
          started.resolve();
          // Ignores cancellation and finishes anyway.
          await finish.promise;
          return { status: 'COMPLETED', outputs: { draft: 'late' } };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const definition = createWorkflowBuilder('cancel')
      .addAgent({ id: 'author', name: 'Author', role: 'author', goal: 'Write', outputs: [{ name: 'draft', type: 'string', required: true }] })
      .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Review', inputs: [{ name: 'draft', type: 'string', required: true }] })
      .connectData({ fromNodeId: 'author', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
      .buildDefinition();
    const { runId } = await runtime.start({ definition });
    const driving = runtime.runUntilSettled(runId).catch((err: unknown) => err);

    await started.promise;
    const cancelled = await runtime.cancelRun({ runId });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.events.at(-1)).toMatchObject({ type: 'run.finished', status: 'CANCELLED' });

    finish.resolve();
    expect(await driving).toBeInstanceOf(RunCancelledError);
    const after = await runtime.runUntilSettled(runId);
    expect(after.status).toBe('CANCELLED');
    expect(after.scopes.$root!.nodes.author!.status).not.toBe('SUCCEEDED');
    expect(calls).toEqual(['author']);
    // Cancelling again, or a finished run, changes nothing.
    expect((await runtime.cancelRun({ runId })).revision).toBe(after.revision);
  });
});
