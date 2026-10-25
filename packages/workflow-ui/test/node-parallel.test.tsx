import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime } from '@universal-agent/workflow-runtime';
import { buildCanvasModel } from '../src/model/canvas';
import { buildTraceModel } from '../src/model/trace';
import { updatePort } from '../src/model/editing';
import { NodeExecutionDetails } from '../src/components/TraceView';
import { Inspector } from '../src/components/Inspector';

const definition = () => createWorkflowBuilder('batch').addWorkflowInput({ name: 'items', type: 'array', required: true })
  .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work', parallel: { itemsPort: 'item', maxConcurrency: 2, failurePolicy: 'settle_all' },
    inputs: [{ name: 'item', type: 'json', required: true }], outputs: [{ name: 'value', type: 'json', required: true }] })
  .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'work', toPort: 'item' }).buildDefinition();

describe('node parallel presentation', () => {
  it('keeps a single Agent card, its ID, position and connections in design and execution views', async () => {
    const def = definition();
    const runtime = createWorkflowRuntime({ executor: { async executeAgent(req) { return { status: 'COMPLETED', outputs: { value: req.inputs.item } }; }, async executeScript() { throw new Error('unused'); } } });
    const run = await runtime.runUntilSettled((await runtime.start({ definition: def, inputs: { items: ['A', 'B'] } })).runId);
    const layout = { work: { x: 123, y: 456 } };
    const design = buildCanvasModel({ definition: def, layout, editable: true });
    const executed = buildCanvasModel({ definition: def, layout, run });
    expect(executed.nodes.map(n => n.id)).toEqual(design.nodes.map(n => n.id));
    expect(executed.edges.map(e => [e.source, e.target])).toEqual(design.edges.map(e => [e.source, e.target]));
    for (const model of [design, executed]) {
      const card = model.nodes.find(n => n.id === 'work')!;
      expect(card.position).toEqual(layout.work); expect(card.data.kind).toBe('agent');
      expect(card.data.subtitle).toContain('Parallel ×2');
      expect(card.data.rows.find(r => r.id === 'in-item')!.value).toBe('array');
    }
    expect(executed.nodes.find(n => n.id === 'work')!.data.rows.find(r => r.id === 'parallel-items')!.value).toBe('2/2 done');
    const trace = buildTraceModel({ run, runActive: false });
    const batch = trace.spans.find(s => s.parallelBatch) ?? trace.spans.flatMap(s => s.children).find(s => s.parallelBatch);
    expect(batch).toMatchObject({ kind: 'agent', parallelBatch: true });
    expect(batch!.children.map(s => [s.scopeKey, s.nodeId, s.hasConversation])).toEqual([
      ['$root/work[0]', 'work', true], ['$root/work[1]', 'work', true],
    ]);
    const html = renderToStaticMarkup(<NodeExecutionDetails span={batch!} runId={run.runId} onClose={() => {}} onOpenArtifact={() => {}} onRerun={() => {}} onAnswer={async () => {}} />);
    expect(html).toContain('Item execution'); expect(html).toContain('Work · Item 1'); expect(html).toContain('Work · Item 2');
  });

  it('keeps an empty batch visible and inspectable as a completed ordinary node', async () => {
    const def = definition();
    const runtime = createWorkflowRuntime({ executor: { async executeAgent() { throw new Error('empty batch must not call an agent'); }, async executeScript() { throw new Error('unused'); } } });
    const run = await runtime.runUntilSettled((await runtime.start({ definition: def, inputs: { items: [] } })).runId);
    const trace = buildTraceModel({ run, runActive: false });
    expect(trace.spans.find(s => s.parallelBatch)).toMatchObject({ nodeId: 'work', scopeKey: '$root', kind: 'agent', status: 'done', children: [] });
  });

  it('shows item progress in the selected round of a step that repeats on its own result', async () => {
    const def = definition();
    def.graph.controlEdges.push({ id: 'back', fromNodeId: 'work', toNodeId: 'work', when: { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, loop: { maxRounds: 2, onExhausted: 'fail' } });
    const runtime = createWorkflowRuntime({ executor: { async executeAgent(req) { return { status: 'COMPLETED', outputs: { value: req.inputs.item }, assessment: { verdict: 'PASS', summary: 'Checked' } }; }, async executeScript() { throw new Error('unused'); } } });
    const run = await runtime.runUntilSettled((await runtime.start({ definition: def, inputs: { items: ['A', 'B'] } })).runId);
    const card = buildCanvasModel({ definition: def, run }).nodes.find(n => n.id === 'work')!;
    expect(card.data.kind).toBe('agent');
    expect(card.data.rows.find(r => r.id === 'parallel-items')!.value).toBe('2/2 done');
  });

  it('renames the selected input without losing its parallel binding and exposes the inspector control', () => {
    const def = definition();
    const result = updatePort(def, 'work', 'in', 'item', { name: 'file' });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.definition.graph.nodes[0]).toMatchObject({ kind: 'agent', parallel: { itemsPort: 'file' } });
    const html = renderToStaticMarkup(<Inspector definition={result.definition} path={[]} target={{ type: 'node', nodeId: 'work' }}
      agents={[]} runtimes={[]} issues={[]} onChange={() => {}} onClose={() => {}} onError={() => {}} onOpenScope={() => {}} onRefreshRuntime={async () => {}} />);
    expect(html).toContain('Run items in parallel'); expect(html).toContain('Maximum concurrent items');
  });
});
