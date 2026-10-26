import { createWorkflowBuilder, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { type AgentExecutionRequest, type AgentExecutionResult, createWorkflowRuntime, RunForkError } from '../src/index';

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, role: 'worker', goal: `do ${id}`, ...extra });
const str = (name: string, required = true) => ({ name, type: 'string' as const, required });

/** plan → [write ⇄ review] → ship, with ship's goal configurable to tell definitions apart. */
function flow(shipGoal = 'ship it'): WorkflowDefinition {
  return createWorkflowBuilder('forkable')
    .addWorkflowOutput(str('shipped'))
    .addAgent(step('plan', { outputs: [str('plan')] }))
    .addAgent(step('write', { inputs: [str('plan')], outputs: [str('draft')], writeScopes: ['src'] }))
    .addAgent(step('review', { producesAssessment: true, inputs: [str('draft')] }))
    .addAgent(step('ship', { goal: shipGoal, inputs: [str('draft')], outputs: [str('shipped')] }))
    .connectData({ fromNodeId: 'plan', fromPort: 'plan', toNodeId: 'write', toPort: 'plan', withControl: true })
    .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
    .loopBack('review', 'write', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2 })
    .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'ship', toPort: 'draft' })
    .connectControl('review', 'ship')
    .connectData({ fromNodeId: 'ship', fromPort: 'shipped', toNodeId: '$output', toPort: 'shipped' })
    .buildDefinition();
}

function harness(options: { failWrite?: boolean } = {}) {
  const calls: { runId: string; nodeId: string; goal: string }[] = [];
  const runtime = createWorkflowRuntime({
    executor: {
      async executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
        calls.push({ runId: req.runId, nodeId: req.node.id, goal: req.node.goal });
        switch (req.node.id) {
          case 'plan':
            return { status: 'COMPLETED', outputs: { plan: 'p1' } };
          case 'write':
            if (options.failWrite) throw new Error('write broke');
            return { status: 'COMPLETED', outputs: { draft: `draft from ${req.inputs.plan}` }, changes: { diff: 'diff --git a/src/a.ts b/src/a.ts\n', files: [{ path: 'src/a.ts', status: 'M' }] } };
          case 'review':
            return { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'ok' } };
          default:
            return { status: 'COMPLETED', outputs: { shipped: `shipped ${req.inputs.draft} (${req.node.goal})` } };
        }
      },
      async executeScript() {
        throw new Error('unused');
      },
    },
  });
  return { runtime, calls };
}

describe('forking a run from a step', () => {
  it('takes over the steps before it, runs it and what follows again, and leaves the source run alone', async () => {
    const { runtime, calls } = harness();
    const { runId: sourceId } = await runtime.start({ definition: flow() });
    const source = await runtime.runUntilSettled(sourceId);
    expect(source.status).toBe('SUCCEEDED');

    const plan = await runtime.planFork({ sourceRunId: sourceId, nodeId: 'ship' });
    expect(plan.fromNodeId).toBe('ship');
    expect(plan.inherited).toEqual(['plan', 'review__loop']);
    expect(plan.rerun).toEqual(['ship']);
    // The writer's change in the loop is handed over for replay, in the slot it wrote to.
    expect(plan.changes).toMatchObject([{ slot: 'main', nodeId: 'write', files: ['src/a.ts'] }]);

    const forked = await runtime.forkRun({ sourceRunId: sourceId, nodeId: 'ship' });
    expect(forked.events.find((e) => e.type === 'run.forked')).toMatchObject({ sourceRunId: sourceId, fromNodeId: 'ship', inherited: ['plan', 'review__loop'] });
    const done = await runtime.runUntilSettled(forked.runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(calls.filter((c) => c.runId === forked.runId).map((c) => c.nodeId)).toEqual(['ship']);
    expect(done.outputs.shipped).toBe('shipped draft from p1 (ship it)');
    // Taken-over records belong to the fork now; the source run did not change.
    expect(Object.values(done.attempts).every((a) => a.runId === forked.runId)).toBe(true);
    expect(Object.keys(done.scopes).some((k) => k.startsWith('$root/review__loop:round_'))).toBe(true);
    expect((await runtime.store.getRun(sourceId))!.revision).toBe(source.revision);
  });

  it('forks from the container when the step is inside a loop, and runs the latest definition', async () => {
    const { runtime, calls } = harness();
    const { runId: sourceId } = await runtime.start({ definition: flow() });
    await runtime.runUntilSettled(sourceId);

    const forked = await runtime.forkRun({ sourceRunId: sourceId, nodeId: 'write', definition: flow('ship it carefully') });
    const done = await runtime.runUntilSettled(forked.runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(calls.filter((c) => c.runId === forked.runId).map((c) => c.nodeId)).toEqual(['write', 'review', 'ship']);
    expect(done.outputs.shipped).toBe('shipped draft from p1 (ship it carefully)');
  });

  it('refuses a fork whose upstream steps did not finish in the source run', async () => {
    const { runtime } = harness({ failWrite: true });
    const { runId: sourceId } = await runtime.start({ definition: flow() });
    expect((await runtime.runUntilSettled(sourceId)).status).toBe('FAILED');
    await expect(runtime.forkRun({ sourceRunId: sourceId, nodeId: 'ship' })).rejects.toThrow(RunForkError);
    await expect(runtime.planFork({ sourceRunId: sourceId, nodeId: 'ship' })).rejects.toThrow(/"review__loop" is upstream of it but did not finish/);
    await expect(runtime.planFork({ sourceRunId: sourceId, nodeId: 'nope' })).rejects.toThrow(/not in the workflow/);
    // Forking from the failed loop itself works: plan is taken over, the loop runs again.
    expect((await runtime.planFork({ sourceRunId: sourceId, nodeId: 'write' })).inherited).toEqual(['plan']);
  });
});
