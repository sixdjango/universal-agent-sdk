import { createWorkflowBuilder, resolveSubflows, type NodeParallel } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { createWorkflowRuntime, foldRunLog, type AgentExecutionRequest, type AgentExecutionResult } from '../src/index';

const port = (name: string, type: 'json' | 'array' = 'json', required = true) => ({ name, type, required });
const unused = async (): Promise<never> => { throw new Error('unused'); };
const options: NodeParallel = { itemsPort: 'item', maxConcurrency: 2, failurePolicy: 'settle_all' };
function definition(parallel: NodeParallel | undefined = options) {
  return createWorkflowBuilder('batch').addWorkflowInput(port('items', 'array')).addWorkflowOutput(port('value', 'array')).addWorkflowOutput(port('meta', 'array'))
    .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work', parallel, maxTechnicalRetries: 1,
      inputs: [port('item')], outputs: [port('value'), port('meta')] })
    .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'work', toPort: 'item' })
    .connectData({ fromNodeId: 'work', fromPort: 'value', toNodeId: '$output', toPort: 'value' })
    .connectData({ fromNodeId: 'work', fromPort: 'meta', toNodeId: '$output', toPort: 'meta' }).buildDefinition();
}
const result = (value: unknown): AgentExecutionResult => ({ status: 'COMPLETED', outputs: { value, meta: false } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe('node parallel execution', () => {
  it('gives an authored parallel step the same item fields: the items port holds one item, next to its index', async () => {
    const seen: Record<string, unknown>[] = [];
    const runtime = createWorkflowRuntime({
      executor: {
        async executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
          seen.push(req.inputs);
          return { status: 'COMPLETED', outputs: { result: `${req.inputs.page}#${req.inputs.index} for ${req.inputs.brand}` } };
        },
        executeScript: unused,
      },
    });
    const flow = createWorkflowBuilder('pages')
      .addWorkflowInput(port('pages', 'array')).addWorkflowInput({ name: 'brand', type: 'string', required: true })
      .addWorkflowOutput(port('results', 'array'))
      .addParallel({
        id: 'each', name: 'Each page', itemsPort: 'pages', maxConcurrency: 2,
        inputs: [port('pages', 'array'), { name: 'brand', type: 'string', required: true }], outputs: [port('results', 'array')],
        itemBody: (b) => b
          .addAgent({ id: 'build', name: 'Build', role: 'worker', goal: 'Build',
            inputs: [port('page'), { name: 'index', type: 'number', required: true }, { name: 'brand', type: 'string', required: true }], outputs: [port('result')] })
          .connectData({ fromNodeId: '$input', fromPort: 'pages', toNodeId: 'build', toPort: 'page' })
          .connectData({ fromNodeId: '$input', fromPort: 'itemIndex', toNodeId: 'build', toPort: 'index' })
          .connectData({ fromNodeId: '$input', fromPort: 'brand', toNodeId: 'build', toPort: 'brand' })
          .connectData({ fromNodeId: 'build', fromPort: 'result', toNodeId: '$output', toPort: 'results' }),
      })
      .connectData({ fromNodeId: '$input', fromPort: 'pages', toNodeId: 'each', toPort: 'pages' })
      .connectData({ fromNodeId: '$input', fromPort: 'brand', toNodeId: 'each', toPort: 'brand' })
      .connectData({ fromNodeId: 'each', fromPort: 'results', toNodeId: '$output', toPort: 'results' })
      .buildDefinition();
    const { runId } = await runtime.start({ definition: flow, inputs: { pages: ['home', 'pricing'], brand: 'Lumen' } });
    const done = await runtime.runUntilSettled(runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.results).toEqual(['home#0 for Lumen', 'pricing#1 for Lumen']);
    expect(seen.map((inputs) => inputs.page).sort()).toEqual(['home', 'pricing']);
  });

  it('bounds concurrency by the host cap and collects ALL outputs in input order despite out-of-order completion', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started = [deferred(), deferred(), deferred()];
    let active = 0, peak = 0;
    const runtime = createWorkflowRuntime({ parallelOptions: { maxConcurrency: 2 }, executor: { executeScript: unused, async executeAgent(req) {
      const i = req.inputs.item as number;
      peak = Math.max(peak, ++active); started[i]!.resolve();
      await gates[i]!.promise; active--;
      return result(i);
    } } });
    const start = await runtime.start({ definition: definition({ ...options, maxConcurrency: 10 }), inputs: { items: [0, 1, 2] } });
    const running = runtime.runUntilSettled(start.runId);
    await Promise.all([started[0]!.promise, started[1]!.promise]);
    expect(peak).toBe(2);
    gates[1]!.resolve(); await started[2]!.promise;
    gates[2]!.resolve(); gates[0]!.resolve();
    const done = await running;
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs).toEqual({ value: [0, 1, 2], meta: [false, false, false] });
    expect(done.scopes.$root!.nodes.work!.parallelItems?.map(i => i.scopeKey)).toEqual(['$root/work[0]', '$root/work[1]', '$root/work[2]']);
    expect(foldRunLog(await runtime.store.readLog(done.runId))).toEqual(done);
  });

  it('leaves a normal node as one invocation receiving the whole list when parallel is absent', async () => {
    const flow = definition(); delete (flow.graph.nodes[0] as any).parallel;
    const seen: AgentExecutionRequest[] = [];
    const runtime = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent(req) { seen.push(req); return result(req.inputs.item); } } });
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow, inputs: { items: ['A', 'B'] } })).runId);
    expect(done.status).toBe('SUCCEEDED'); expect(seen).toHaveLength(1);
    expect(seen[0]!.scopeKey).toBe('$root'); expect(done.outputs).toEqual({ value: ['A', 'B'], meta: false });
  });

  it('settle_all finishes siblings but fails the batch and preserves failed positions', async () => {
    const calls: unknown[] = [];
    const runtime = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent(req) {
      calls.push(req.inputs.item);
      if (req.inputs.item === 1) throw new Error('broken item');
      return result(req.inputs.item);
    } } });
    const done = await runtime.runUntilSettled((await runtime.start({ definition: definition(), inputs: { items: [0, 1, 2] } })).runId);
    expect(done.status).toBe('FAILED');
    expect(calls.filter(i => i === 1)).toHaveLength(2);
    expect(calls).toContain(2);
    expect(done.scopes.$root!.nodes.work).toMatchObject({ status: 'FAILED', outputs: { value: { value: [0, null, 2] }, meta: { value: [false, null, false] } }, parallelItems: [ { status: 'SUCCEEDED' }, { status: 'FAILED', error: 'broken item' }, { status: 'SUCCEEDED' } ] });
    expect(done.outputs).toEqual({});
  });

  it('fail_fast cancels running siblings, never starts queued items, and does not retry cancellation', async () => {
    const entered = deferred();
    const calls: unknown[] = [];
    const runtime = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent(req) {
      calls.push(req.inputs.item);
      if (req.inputs.item === 0) { await entered.promise; throw new Error('fatal'); }
      entered.resolve();
      await new Promise<void>(resolve => req.signal!.addEventListener('abort', () => resolve(), { once: true }));
      req.signal!.throwIfAborted();
      return result('must not succeed');
    } } });
    const done = await runtime.runUntilSettled((await runtime.start({ definition: definition({ ...options, failurePolicy: 'fail_fast' }), inputs: { items: [0, 1, 2] } })).runId);
    expect(done.status).toBe('FAILED');
    expect(calls).toEqual([0, 1, 0]);
    expect(done.scopes['$root/work[1]']!.nodes.work).toMatchObject({ status: 'FAILED', error: expect.stringContaining('Cancelled') });
    expect(done.scopes['$root/work[2]']!.nodes.work!.status).toBe('SKIPPED');
    expect(Object.values(done.attempts).filter(a => a.scopeKey === '$root/work[1]')).toHaveLength(1);
  });

  it('external cancellation waits for all workers and never publishes success', async () => {
    const entered = deferred(); let active = 0;
    const abort = new AbortController();
    const runtime = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent(req) {
      if (++active === 2) entered.resolve();
      await new Promise<void>(resolve => req.signal!.addEventListener('abort', () => resolve(), { once: true }));
      active--;
      return result('adapter ignored cancellation');
    } } });
    const start = await runtime.start({ definition: definition(), inputs: { items: [0, 1] } });
    const running = runtime.runUntilSettled(start.runId, { signal: abort.signal });
    await entered.promise; abort.abort();
    await expect(running).rejects.toThrow();
    expect(active).toBe(0);
    expect((await runtime.store.getRun(start.runId))!.scopes.$root!.nodes.work!.status).not.toBe('SUCCEEDED');
  });

  it('handles empty arrays, null outputs, invalid inputs and missing required outputs explicitly', async () => {
    let called = 0;
    const runtime = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent() { called++; return result(null); } } });
    const run = async (items: unknown) => runtime.runUntilSettled((await runtime.start({ definition: definition(), inputs: { items } })).runId);
    expect((await run([])).outputs).toEqual({ value: [], meta: [] }); expect(called).toBe(0);
    expect((await run([1])).outputs.value).toEqual([null]);
    expect((await run('bad')).status).toBe('FAILED');
    const missing = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent() { return { status: 'COMPLETED', outputs: { value: 1 } }; } } });
    const done = await missing.runUntilSettled((await missing.start({ definition: definition(), inputs: { items: [1] } })).runId);
    expect(done.status).toBe('FAILED');
    expect(done.scopes.$root!.nodes.work!.parallelItems![0]!.error).toContain('meta');
  });

  it('retries only the failed invocation and Chief repairs one item without rerunning siblings', async () => {
    const calls: AgentExecutionRequest[] = [];
    const flow = definition(); flow.chief = { enabled: true, triggers: [], maxLevel: 'operate', maxInterventionsPerRun: 5, maxConsecutiveNoops: 2 } as any;
    const runtime = createWorkflowRuntime({ chief: { async review() { return { rationale: 'Repair item 1', commands: [
      { kind: 'inject_guidance', nodeId: 'work', scopeKey: '$root/work[0]', text: 'fixed' },
      { kind: 'rerun_from_node', nodeId: 'work', scopeKey: '$root/work[0]' },
    ] }; } }, executor: { executeScript: unused, async executeAgent(req) {
      calls.push(req);
      if (req.inputs.item === 'A' && calls.filter(c => c.inputs.item === 'A').length === 1) throw new Error('transient');
      return result(req.renderedPrompt.includes('fixed') ? 'A fixed' : req.inputs.item);
    } } });
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow, inputs: { items: ['A', 'B'] } })).runId);
    expect(calls.filter(c => c.scopeKey === '$root/work[0]').map(c => c.retryIndex)).toEqual([0, 1]);
    const message = await runtime.postChiefMessage({ runId: done.runId, text: 'Fix item 1', authorId: 'owner' });
    const invalidated = await runtime.answerChiefMessage({ runId: done.runId, messageId: message.messageId });
    expect(invalidated.scopes.$root!.nodes.work!.parallelItems).toBeUndefined();
    const repaired = await runtime.resume(done.runId);
    expect(repaired.status).toBe('SUCCEEDED'); expect(repaired.outputs.value).toEqual(['A fixed', 'B']);
    expect(calls.filter(c => c.scopeKey === '$root/work[1]')).toHaveLength(1);
    expect(Object.values(repaired.attempts).filter(a => a.scopeKey === '$root/work[0]')).toHaveLength(2);
  });

  it('repeats a step on its own combined per-item assessment, then branches on it', async () => {
    const flow = createWorkflowBuilder('parallel-loop').addWorkflowInput(port('items', 'array'))
      .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Review', producesAssessment: true, parallel: options, inputs: [port('item')] })
      .addAgent({ id: 'finish', name: 'Finish', role: 'worker', goal: 'Finish' })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'review', toPort: 'item' })
      .loopBack('review', 'review', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2 })
      .connectControl('review', 'finish', { kind: 'verdict_is', verdict: 'PASS' }).buildDefinition();
    const runtime = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent(req) {
      if (req.node.id === 'finish') return { status: 'COMPLETED' };
      return { status: 'COMPLETED', assessment: { verdict: req.inputs.item === 'A' && req.scopeKey.includes('round_0') ? 'NEEDS_FIX' : 'PASS', summary: 'Independent check' } };
    } } });
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow, inputs: { items: ['A', 'B'] } })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.scopes['$root/review__loop:round_0']!.nodes.review!.latestVerdict).toBe('NEEDS_FIX');
    expect(done.scopes['$root/review__loop:round_1']!.nodes.review!.latestVerdict).toBe('PASS');
    expect(done.scopes.$root!.nodes.finish!.status).toBe('SUCCEEDED');
    expect(Object.values(done.attempts).filter(a => a.nodeId === 'review')).toHaveLength(4);
  });

  it('retains artifact metadata and explicit reference delivery when another parallel node consumes the outputs', async () => {
    const flow = createWorkflowBuilder('artifacts').addWorkflowInput(port('items', 'array'))
      .addAgent({ id: 'produce', name: 'Produce', role: 'worker', goal: 'Produce', parallel: options, inputs: [port('item')], outputs: [{ name: 'file', type: 'artifact', required: true }] })
      .addAgent({ id: 'consume', name: 'Consume', role: 'worker', goal: 'Consume', parallel: { ...options, itemsPort: 'file' }, inputs: [{ name: 'file', type: 'artifact', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'produce', toPort: 'item' })
      .connectData({ fromNodeId: 'produce', fromPort: 'file', toNodeId: 'consume', toPort: 'file', withControl: true, delivery: 'artifact_ref' }).buildDefinition();
    const refs: string[] = [];
    const runtime = createWorkflowRuntime({ executor: { executeScript: unused, async executeAgent(req) {
      if (req.node.id === 'produce') return { status: 'COMPLETED', artifacts: { file: { content: String(req.inputs.item) } } };
      const entry = req.manifest.entries.find(e => e.portName === 'file')!;
      expect(entry.mode).toBe('artifact_ref');
      refs.push(entry.artifactRef!.artifactId);
      return { status: 'COMPLETED' };
    } } });
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow, inputs: { items: ['A', 'B'] } })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(refs.sort()).toEqual(done.scopes.$root!.nodes.produce!.outputs.file!.items!.map(i => i!.artifactId).sort());
    expect(done.scopes.$root!.nodes.produce!.outputs.file!.value).toEqual(['A', 'B']);
  });

  it('runs Script and Sub-flow properties with independent conditions and complete output aggregation', async () => {
    const child = createWorkflowBuilder('child').addWorkflowInput(port('item')).addWorkflowOutput(port('value')).addWorkflowOutput(port('meta'))
      .addScript({ id: 'compute', name: 'Compute', command: 'test', inputs: [port('item')], outputs: [port('value'), port('meta')] })
      .addAgent({ id: 'accept', name: 'Accept', role: 'reviewer', goal: 'Accept' })
      .connectData({ fromNodeId: '$input', fromPort: 'item', toNodeId: 'compute', toPort: 'item' })
      .connectControl('compute', 'accept', { kind: 'verdict_is', verdict: 'PASS' })
      .connectData({ fromNodeId: 'compute', fromPort: 'value', toNodeId: '$output', toPort: 'value' })
      .connectData({ fromNodeId: 'compute', fromPort: 'meta', toNodeId: '$output', toPort: 'meta' }).buildDefinition();
    const parent = createWorkflowBuilder('parent').addWorkflowInput(port('items', 'array')).addWorkflowOutput(port('value', 'array'))
      .addSubflow({ id: 'sub', name: 'Sub', workflowId: child.id, inputs: child.inputs, outputs: child.outputs, parallel: options })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'sub', toPort: 'item' })
      .connectData({ fromNodeId: 'sub', fromPort: 'value', toNodeId: '$output', toPort: 'value' }).buildDefinition();
    const accepted: string[] = [];
    const runtime = createWorkflowRuntime({ executor: { async executeAgent(req) { accepted.push(req.scopeKey); return { status: 'COMPLETED' }; }, async executeScript(req) { return { exitCode: 0, stdout: '', stderr: '', outputs: { value: req.inputs.item, meta: { checked: true } } }; } } });
    const def = await resolveSubflows(parent, async () => child);
    const done = await runtime.runUntilSettled((await runtime.start({ definition: def, inputs: { items: [2, 3] } })).runId);
    expect(done.status).toBe('SUCCEEDED'); expect(done.outputs.value).toEqual([2, 3]);
    expect(accepted.sort()).toEqual(['$root/sub[0]/sub:round_0', '$root/sub[1]/sub:round_0']);
    const scriptFlow = definition();
    const agent = scriptFlow.graph.nodes[0]!;
    scriptFlow.graph.nodes[0] = { ...agent, kind: 'script', command: 'test', args: [], timeoutMs: 1000, producesAssessment: false } as any;
    const scripts = await runtime.runUntilSettled((await runtime.start({ definition: scriptFlow, inputs: { items: [4, 5] } })).runId);
    expect(scripts.outputs).toEqual({ value: [4, 5], meta: [{ checked: true }, { checked: true }] });
  });
});
