import { createWorkflowBuilder, resolveSubflows, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { type AgentExecutionRequest, createWorkflowRuntime, DeterministicClock, SequentialIdGenerator } from '../src/index';

const child = createWorkflowBuilder('summarize', 'Summarize')
  .addWorkflowInput({ name: 'text', type: 'string', required: true })
  .addWorkflowOutput({ name: 'summary', type: 'string', required: true })
  .addAgent({ id: 'sum', name: 'Summarize', role: 'author', goal: 'x', inputs: [{ name: 'text', type: 'string', required: true }], outputs: [{ name: 'summary', type: 'string', required: true }] })
  .connectData({ fromNodeId: '$input', fromPort: 'text', toNodeId: 'sum', toPort: 'text' })
  .connectData({ fromNodeId: 'sum', fromPort: 'summary', toNodeId: '$output', toPort: 'summary' })
  .buildDefinition();

const parent: WorkflowDefinition = createWorkflowBuilder('main')
  .addWorkflowInput({ name: 'doc', type: 'string', required: true })
  .addNode({
    kind: 'subflow',
    id: 'digest',
    name: 'Digest',
    workflowId: 'summarize',
    inputs: [{ name: 'text', type: 'string', required: true }],
    outputs: [{ name: 'summary', type: 'string', required: true }],
    writeScopes: [],
    maxTechnicalRetries: 0,
  })
  .addAgent({ id: 'publish', name: 'Publish', role: 'author', goal: 'x', inputs: [{ name: 'summary', type: 'string', required: true }] })
  .connectData({ fromNodeId: '$input', fromPort: 'doc', toNodeId: 'digest', toPort: 'text' })
  .connectData({ fromNodeId: 'digest', fromPort: 'summary', toNodeId: 'publish', toPort: 'summary', withControl: true })
  .buildDefinition();

function runtime() {
  const seen: AgentExecutionRequest[] = [];
  const rt = createWorkflowRuntime({
    clock: new DeterministicClock(),
    idGenerator: new SequentialIdGenerator(),
    executor: {
      async executeAgent(req) {
        seen.push(req);
        return req.node.id === 'sum'
          ? { status: 'COMPLETED', outputs: { summary: `short: ${String(req.inputs.text)}` } }
          : { status: 'COMPLETED' };
      },
      async executeScript() {
        throw new Error('unused');
      },
    },
  });
  return { rt, seen };
}

describe('sub-flow steps', () => {
  it('run the embedded workflow once and hand its outputs on', async () => {
    const { rt, seen } = runtime();
    const definition = await resolveSubflows(parent, async (id) => (id === child.id ? child : null));
    const done = await rt.runUntilSettled((await rt.start({ definition, inputs: { doc: 'long text' } })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(seen.map((r) => [r.node.id, r.scopeKey])).toEqual([
      ['sum', '$root/digest:round_0'],
      ['publish', '$root'],
    ]);
    expect(seen[1]!.inputs.summary).toBe('short: long text');
    // The run keeps the workflow it ran.
    const step = done.definition.graph.nodes.find((n) => n.id === 'digest')!;
    expect(step.kind === 'subflow' && step.snapshot?.workflowId).toBe('summarize');
  });

  it('fail clearly when nobody embedded the workflow', async () => {
    const { rt } = runtime();
    const done = await rt.runUntilSettled((await rt.start({ definition: parent, inputs: { doc: 'x' } })).runId);
    expect(done.status).toBe('FAILED');
    expect(done.scopes.$root!.nodes.digest!.error).toContain('was not resolved');
  });
});
