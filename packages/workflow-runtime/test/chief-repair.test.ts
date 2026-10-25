import {
  ChiefPolicySchema, createBoundedFixLoopFlow, createParallelFanOutFlow, createWorkflowBuilder,
  type ChiefCommand,
} from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  createWorkflowRuntime, foldRunLog, InMemoryAgentRegistry,
  type ChiefSupervisor, type WorkflowRunState,
} from '../src/index';

const unused = async () => { throw new Error('unused'); };
const onMessage = (commands: (state: WorkflowRunState) => ChiefCommand[]): ChiefSupervisor => ({
  async review(input) {
    return { rationale: 'Repair with the original graph', commands: input.trigger.kind === 'user.message' ? commands(input.state) : [] };
  },
});
async function ask(runtime: ReturnType<typeof createWorkflowRuntime>, runId: string) {
  const { messageId } = await runtime.postChiefMessage({ runId, text: 'Repair and verify again', authorId: 'owner' });
  return runtime.answerChiefMessage({ runId, messageId });
}
const intervention = (state: WorkflowRunState) => state.events.filter(e => e.type === 'chief.intervened').at(-1)!;

describe('chief repair boundaries', () => {
  it('rebuilds enclosing outputs and downstream checks while preserving other parallel items', async () => {
    const definition = createParallelFanOutFlow({ id: 'repair-item', workerGoal: 'Process', reducerGoal: 'Verify and combine' });
    definition.chief = ChiefPolicySchema.parse({});
    const calls: Record<string, number> = {};
    const runtime = createWorkflowRuntime({
      chief: onMessage(() => [
        { kind: 'inject_guidance', scopeKey: '$root/fan_out[0]', nodeId: 'item_worker', text: 'Correct the first item' },
        { kind: 'rerun_from_node', scopeKey: '$root/fan_out[0]', nodeId: 'item_worker' },
      ]),
      executor: {
        async executeAgent(req) {
          const key = `${req.scopeKey}/${req.node.id}`;
          calls[key] = (calls[key] ?? 0) + 1;
          if (req.node.id === 'item_worker') {
            if (calls[key] === 2) expect(req.renderedPrompt).toContain('Correct the first item');
            return { status: 'COMPLETED', outputs: { itemResult: `${req.inputs.item}:${calls[key]}` } };
          }
          return { status: 'COMPLETED', outputs: { summary: (req.inputs.results as string[]).join(',') }, assessment: { verdict: 'PASS', summary: 'Checked all items' } };
        },
        executeScript: unused,
      },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition, inputs: { items: ['A', 'B'] } })).runId);
    expect(done.outputs.summary).toBe('A:1,B:1');
    const repairing = await ask(runtime, done.runId);
    expect(repairing.outputs).toEqual({});
    expect(repairing.scopes.$root!.nodes.reducer).toMatchObject({ status: 'STALE', outputs: {} });
    expect(Object.values(repairing.assessments).every(a => a.stale)).toBe(true);
    const repaired = await runtime.resume(done.runId);
    expect(repaired.status).toBe('SUCCEEDED');
    expect(repaired.outputs.summary).toBe('A:2,B:1');
    expect(calls).toEqual({ '$root/fan_out[0]/item_worker': 2, '$root/fan_out[1]/item_worker': 1, '$root/reducer': 2 });
    expect(foldRunLog(await runtime.store.readLog(done.runId))).toEqual(repaired);
  });

  it('discards later loop rounds that consumed the old feedback', async () => {
    const definition = createBoundedFixLoopFlow({ id: 'repair-round', authorGoal: 'Write', acceptanceCriteria: ['Correct'], maxRounds: 2 });
    definition.chief = ChiefPolicySchema.parse({ triggers: [] });
    const calls: Record<string, number> = {};
    const runtime = createWorkflowRuntime({
      chief: onMessage(() => [{ kind: 'rerun_from_node', scopeKey: '$root/fix_loop:round_0', nodeId: 'author' }]),
      executor: {
        async executeAgent(req) {
          const key = `${req.scopeKey}/${req.node.id}`;
          calls[key] = (calls[key] ?? 0) + 1;
          return req.node.id === 'author'
            ? { status: 'COMPLETED', artifacts: { candidate: { content: `${key}:${calls[key]}` } } }
            : { status: 'COMPLETED', assessment: { verdict: req.scopeKey.endsWith('round_0') ? 'NEEDS_FIX' : 'PASS', summary: `Review ${calls[key]}` } };
        },
        executeScript: unused,
      },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition, inputs: { specification: 'spec' } })).runId);
    const oldAttempts = Object.keys(done.attempts);
    const repairing = await ask(runtime, done.runId);
    expect(repairing.scopes['$root/fix_loop:round_1']).toBeUndefined();
    expect(Object.values(repairing.assessments).every(a => a.stale)).toBe(true);
    const repaired = await runtime.resume(done.runId);
    expect(repaired.status).toBe('SUCCEEDED');
    expect(Object.values(calls)).toEqual([2, 2, 2, 2]);
    expect(oldAttempts.every(id => repaired.attempts[id])).toBe(true);
    expect(Object.values(repaired.assessments).filter(a => !a.stale)).toHaveLength(2);
    expect(foldRunLog(await runtime.store.readLog(done.runId))).toEqual(repaired);
  });

  it('returns to the scheduler when the automatic chief discards the loop round being entered', async () => {
    const definition = createBoundedFixLoopFlow({ id: 'repair-between-rounds', authorGoal: 'Write', acceptanceCriteria: ['Correct'], maxRounds: 2 });
    definition.chief = ChiefPolicySchema.parse({ triggers: ['loop.round_needs_fix'] });
    let authorCalls = 0;
    let reviewCalls = 0;
    const runtime = createWorkflowRuntime({
      chief: { async review() { return { rationale: 'Redo the previous round', commands: [{ kind: 'rerun_from_node', scopeKey: '$root/fix_loop:round_0', nodeId: 'author' }] }; } },
      executor: { async executeAgent(req) {
        if (req.node.id === 'author') return { status: 'COMPLETED', artifacts: { candidate: { content: `v${++authorCalls}` } } };
        return { status: 'COMPLETED', assessment: { verdict: ++reviewCalls === 1 ? 'NEEDS_FIX' : 'PASS', summary: 'Check' } };
      }, executeScript: unused },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition, inputs: { specification: 'spec' } })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect([authorCalls, reviewCalls]).toEqual([2, 2]);
    expect(done.scopes['$root/fix_loop:round_1']).toBeUndefined();
  });

  it('reopens a parallel container safely when its automatic chief replaces the current item scopes', async () => {
    const definition = createParallelFanOutFlow({ id: 'repair-container', workerGoal: 'Process', reducerGoal: 'Combine' });
    definition.chief = ChiefPolicySchema.parse({ triggers: ['node.failed'] });
    const parallel = definition.graph.nodes.find(n => n.id === 'fan_out')!;
    if (parallel.kind === 'parallel') parallel.maxConcurrency = 1;
    let failed = false;
    const runtime = createWorkflowRuntime({
      chief: { async review() { return { rationale: 'Retry the whole batch', commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'fan_out' }] }; } },
      executor: { async executeAgent(req) {
        if (req.node.id === 'item_worker') {
          if (!failed) { failed = true; throw new Error('interrupted batch'); }
          return { status: 'COMPLETED', outputs: { itemResult: req.inputs.item } };
        }
        return { status: 'COMPLETED', outputs: { summary: (req.inputs.results as string[]).join(',') } };
      }, executeScript: unused },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition, inputs: { items: ['A', 'B'] } })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.summary).toBe('A,B');
    expect(done.chief.interventionCount).toBe(1);
  });

  it('rejects a direct chief rerun while a node is still executing and records the rejection', async () => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const definition = createWorkflowBuilder('inflight-chief').setChief({ triggers: [] })
      .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' }).buildDefinition();
    const runtime = createWorkflowRuntime({
      chief: onMessage(() => [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'work' }]),
      executor: { async executeAgent() { started(); await gate; return { status: 'COMPLETED' }; }, executeScript: unused },
    });
    const { runId } = await runtime.start({ definition });
    const running = runtime.runUntilSettled(runId);
    try {
      await entered;
      const answered = await ask(runtime, runId);
      expect(intervention(answered)).toMatchObject({ applied: [], rejected: [{ reason: expect.stringContaining('still executing') }] });
    } finally { release(); }
    expect((await running).status).toBe('SUCCEEDED');
    expect(intervention(await ask(runtime, runId)).applied).toHaveLength(1);
  });

  it('invalidates a rerun reviewer’s own verdict and cancels superseded questions', async () => {
    const definition = createWorkflowBuilder('obsolete-evidence').setChief({ triggers: [] })
      .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Review', producesAssessment: true })
      .addGate({ id: 'approval', name: 'Approval', prompt: 'Approve this version?' })
      .connectControl('review', 'approval').buildDefinition();
    const runtime = createWorkflowRuntime({
      chief: onMessage(() => [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'review' }]),
      executor: { async executeAgent() { return { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'Checked' } }; }, executeScript: unused },
    });
    const waiting = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const oldWait = Object.values(waiting.waitRequests)[0]!;
    const repairing = await ask(runtime, waiting.runId);
    expect(Object.values(repairing.assessments).every(a => a.stale)).toBe(true);
    expect(repairing.scopes.$root!.nodes.review!.latestVerdict).toBeUndefined();
    expect(repairing.waitRequests[oldWait.requestId]!.status).toBe('CANCELLED');
    await expect(runtime.respond({ runId: waiting.runId, requestId: oldWait.requestId, answer: 'approved', responderId: 'owner' })).rejects.toThrow('cancelled');
    const waitingAgain = await runtime.resume(waiting.runId);
    expect(waitingAgain.status).toBe('WAITING');
    const pending = Object.values(waitingAgain.waitRequests).filter(w => w.status === 'PENDING');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).not.toBe(oldWait.requestId);
  });

  it.each(['gate', 'role'] as const)('cannot answer a human %s on their behalf', async kind => {
    const builder = createWorkflowBuilder('human-boundary').setChief({ triggers: [] });
    if (kind === 'gate') builder.addGate({ id: 'work', name: 'Approve', prompt: 'Approve?' });
    else builder.addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' });
    const runtime = createWorkflowRuntime({
      chief: onMessage(state => [{ kind: 'answer_wait', requestId: Object.values(state.waitRequests)[0]!.requestId, answer: 'yes' }]),
      executor: { async executeAgent() { return { status: 'WAIT_REQUESTED', waitRequest: { prompt: 'Owner approval?', requiredRole: 'owner' } }; }, executeScript: unused },
    });
    const waiting = await runtime.runUntilSettled((await runtime.start({ definition: builder.buildDefinition() })).runId);
    const answered = await ask(runtime, waiting.runId);
    expect(answered.status).toBe('WAITING');
    expect(Object.values(answered.waitRequests)[0]!.status).toBe('PENDING');
    expect(intervention(answered)).toMatchObject({ applied: [], rejected: [{ command: { kind: 'answer_wait' } }] });
  });

  it('rejects a scoped agent swap that targets no such node instance', async () => {
    const definition = createWorkflowBuilder('invalid-scope').setChief({})
      .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' }).buildDefinition();
    const runtime = createWorkflowRuntime({
      agentRegistry: new InMemoryAgentRegistry([{ id: 'senior', name: 'Senior', charter: 'Repair' }]),
      chief: onMessage(() => [{ kind: 'swap_agent', scopeKey: '$root/nonexistent[0]', nodeId: 'work', agentRef: 'senior' }]),
      executor: { async executeAgent() { return { status: 'COMPLETED' }; }, executeScript: unused },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const answered = await ask(runtime, done.runId);
    expect(answered.chief.agentOverrides).toEqual([]);
    expect(intervention(answered)).toMatchObject({ applied: [], rejected: [{ reason: expect.stringContaining('does not exist') }] });
  });

  it('does not fall back to a default chief when its configured profile cannot be resolved', async () => {
    const definition = createWorkflowBuilder('missing-chief').setChief({ agentRef: 'missing' })
      .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' }).buildDefinition();
    let chiefCalls = 0;
    const runtime = createWorkflowRuntime({
      agentRegistry: new InMemoryAgentRegistry(),
      chief: { async review() { chiefCalls++; return { rationale: '', commands: [] }; } },
      executor: { async executeAgent() { return { status: 'COMPLETED' }; }, executeScript: unused },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const answered = await ask(runtime, done.runId);
    expect(chiefCalls).toBe(0);
    expect(intervention(answered).rationale).toContain('not registered');
  });

  it('does not execute the same chief message twice', async () => {
    const definition = createWorkflowBuilder('idempotent-chief').setChief({})
      .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' }).buildDefinition();
    let reviews = 0;
    const runtime = createWorkflowRuntime({
      chief: { async review() { reviews++; return { rationale: 'redo', commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'work' }] }; } },
      executor: { async executeAgent() { return { status: 'COMPLETED' }; }, executeScript: unused },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const { messageId } = await runtime.postChiefMessage({ runId: done.runId, text: 'redo', authorId: 'owner' });
    const first = await runtime.answerChiefMessage({ runId: done.runId, messageId });
    const second = await runtime.answerChiefMessage({ runId: done.runId, messageId });
    expect(second).toEqual(first);
    expect(reviews).toBe(1);
  });

  it('keeps the configured intervention limit for human messages while still allowing a reply', async () => {
    const definition = createWorkflowBuilder('bounded-chief').setChief({ maxInterventionsPerRun: 0 })
      .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' }).buildDefinition();
    const runtime = createWorkflowRuntime({
      chief: { async review() { return { rationale: '', reply: 'I can explain the failure, but the intervention allowance is exhausted.', commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'work' }] }; } },
      executor: { async executeAgent() { return { status: 'COMPLETED' }; }, executeScript: unused },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const answered = await ask(runtime, done.runId);
    expect(answered.status).toBe('SUCCEEDED');
    expect(answered.chief.interventionCount).toBe(0);
    expect(intervention(answered)).toMatchObject({ reply: expect.any(String), applied: [], rejected: [{ reason: expect.stringContaining('maxInterventionsPerRun') }] });
  });

  it('does not apply a late chief decision after cancellation', async () => {
    const controller = new AbortController();
    const definition = createWorkflowBuilder('cancel-chief').setChief({})
      .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work' }).buildDefinition();
    const runtime = createWorkflowRuntime({
      chief: { async review() {
        controller.abort();
        return { rationale: 'late result', commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'work' }] };
      } },
      executor: { async executeAgent() { return { status: 'COMPLETED' }; }, executeScript: unused },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const { messageId } = await runtime.postChiefMessage({ runId: done.runId, text: 'redo', authorId: 'owner' });
    await expect(runtime.answerChiefMessage({ runId: done.runId, messageId, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const state = (await runtime.store.getRun(done.runId))!;
    expect(state.status).toBe('SUCCEEDED');
    expect(state.events.filter(e => e.type === 'chief.intervened')).toHaveLength(0);
  });
});
