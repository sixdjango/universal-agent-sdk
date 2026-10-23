import { validateWorkflowDefinition, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, DeterministicClock, SequentialIdGenerator } from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel, containerInstanceKeys } from '../src/model/canvas';
import { addNode, connect, createBlankWorkflow, type EditResult, portsOf, removePort, updatePort } from '../src/model/editing';
import { graphAt } from '../src/model/scope';

function ok<T>(result: EditResult<T>): Extract<EditResult<T>, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result as Extract<EditResult<T>, { ok: true }>;
}

const issuesOf = (definition: WorkflowDefinition) => {
  const result = validateWorkflowDefinition(definition);
  return result.ok ? [] : result.issues.map((i) => `${i.scopePath} ${i.code}: ${i.message}`);
};

/** request -> loop(author -> review), with the request wired through to the author. */
function loopWorkflow(): WorkflowDefinition {
  let d = createBlankWorkflow('Loop flow', []);
  d = ok(addNode(d, 'loop')).definition;
  d = ok(connect(d, { source: '$input', sourceHandle: 'out:request', target: 'loop', targetHandle: 'in:+' })).definition;
  d = ok(connect(d, { source: '$input', sourceHandle: 'out:request', target: 'author', targetHandle: 'in:+' }, ['loop'])).definition;
  return d;
}

describe('editing loop bodies and parallel items', () => {
  it('adds containers that are valid out of the box and wires through their ports', () => {
    const d = loopWorkflow();
    expect(issuesOf(d)).toEqual([]);
    expect(portsOf(d, 'loop', 'in').map((p) => p.name)).toEqual(['request']);
    expect(graphAt(d, ['loop']).dataEdges.some((e) => e.fromNodeId === '$input' && e.toNodeId === 'author')).toBe(true);

    const withParallel = ok(addNode(d, 'parallel')).definition;
    // The new parallel step needs its list wired from outside before it is valid.
    expect(issuesOf(withParallel).some((i) => i.includes('MISSING_REQUIRED_INPUT_BINDING') && i.includes('items'))).toBe(true);
  });

  it('keeps a container port in sync on both sides when renamed or removed from either view', () => {
    const d = loopWorkflow();
    const renamedInside = ok(updatePort(d, '$input', 'out', 'request', { name: 'spec' }, ['loop'])).definition;
    expect(portsOf(renamedInside, 'loop', 'in').map((p) => p.name)).toEqual(['spec']);
    expect(renamedInside.graph.dataEdges.find((e) => e.toNodeId === 'loop')?.toPort).toBe('spec');
    expect(graphAt(renamedInside, ['loop']).dataEdges.find((e) => e.fromNodeId === '$input')?.fromPort).toBe('spec');
    expect(issuesOf(renamedInside)).toEqual([]);

    const renamedOutside = ok(updatePort(d, 'loop', 'out', 'result', { name: 'patch' })).definition;
    expect(graphAt(renamedOutside, ['loop']).dataEdges.find((e) => e.toNodeId === '$output')?.toPort).toBe('patch');
    expect(issuesOf(renamedOutside)).toEqual([]);

    const removed = removePort(d, 'loop', 'in', 'request');
    expect(removed.graph.dataEdges.some((e) => e.toNodeId === 'loop')).toBe(false);
    expect(graphAt(removed, ['loop']).dataEdges.some((e) => e.fromNodeId === '$input')).toBe(false);
  });

  it('exposes built-in parallel item fields read-only and follows the list input rename', () => {
    let d = ok(addNode(createBlankWorkflow('Fan out', []), 'parallel')).definition;
    // Inside, each item sees the built-in fields plus the step's own inputs.
    expect(portsOf(d, '$input', 'out', ['parallel']).map((p) => p.name)).toEqual(['item', 'itemIndex', 'items']);
    expect(updatePort(d, '$input', 'out', 'item', { name: 'x' }, ['parallel']).ok).toBe(false);
    expect(removePort(d, '$input', 'out', 'item', ['parallel'])).toBe(d);

    d = ok(updatePort(d, 'parallel', 'in', 'items', { name: 'files' })).definition;
    const node = d.graph.nodes.find((n) => n.id === 'parallel');
    expect(node?.kind === 'parallel' && node.itemsPort).toBe('files');
  });

  it('renders a nested graph with the container ports as its inputs and outputs', () => {
    const d = loopWorkflow();
    const model = buildCanvasModel({ definition: d, path: ['loop'], editable: true, layout: { 'loop/author': { x: 7, y: 9 } } });
    expect(model.nodes.map((n) => n.id)).toEqual(['$input', 'author', 'review', '$output']);
    expect(model.nodes[0]!.data.title).toBe('Each round gets');
    expect(model.nodes[0]!.data.rows[0]).toMatchObject({ label: 'request', handle: { id: 'out:request' } });
    expect(model.nodes[3]!.data.title).toBe('Loop result');
    expect(model.nodes.find((n) => n.id === 'author')?.position).toEqual({ x: 7, y: 9 });

    const root = buildCanvasModel({ definition: d, editable: true });
    expect(root.nodes.find((n) => n.id === 'loop')?.data.rows[0]).toMatchObject({ kind: 'open', value: '2 inside' });
  });

  it('shows each loop round of a run separately', async () => {
    let reviews = 0;
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'author') return { status: 'COMPLETED', artifacts: { result: { content: `v${reviews}` } } };
          reviews += 1;
          return { status: 'COMPLETED', assessment: { verdict: reviews === 1 ? 'NEEDS_FIX' : 'PASS', summary: '' } };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const started = await runtime.start({ definition: loopWorkflow(), inputs: { request: 'go' } });
    const run = await runtime.runUntilSettled(started.runId);
    expect(run.status).toBe('SUCCEEDED');

    const rounds = containerInstanceKeys(run, '$root/loop');
    expect(rounds).toEqual(['$root/loop:round_0', '$root/loop:round_1']);
    const first = buildCanvasModel({ definition: run.definition, run, path: ['loop'], scopeKey: rounds[0] });
    const second = buildCanvasModel({ definition: run.definition, run, path: ['loop'], scopeKey: rounds[1] });
    expect(first.nodes.find((n) => n.id === 'review')?.data.verdict).toBe('NEEDS_FIX');
    expect(second.nodes.find((n) => n.id === 'review')?.data.verdict).toBe('PASS');
    expect(first.nodes.find((n) => n.id === 'author')?.data.activity).toHaveLength(1);
  });
});
