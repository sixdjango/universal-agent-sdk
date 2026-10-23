import { createWorkflowBuilder, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import {
  type AgentExecutionResult,
  createWorkflowRuntime,
  DeterministicClock,
  InMemoryAgentRegistry,
  SequentialIdGenerator,
  type WorkflowRunState,
} from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel, describeRun, INPUTS_NODE_ID, OUTPUTS_NODE_ID } from '../src/model/canvas';

function reviewFlow(): WorkflowDefinition {
  return createWorkflowBuilder('canvas-flow', 'Canvas flow')
    .addWorkflowInput({ name: 'request', type: 'string', required: true })
    .addWorkflowOutput({ name: 'notes', type: 'artifact', required: true })
    .addAgent({
      id: 'build',
      name: 'Build',
      role: 'author',
      agentRef: 'builder',
      goal: 'Build it',
      inputs: [{ name: 'request', type: 'string', required: true }],
      outputs: [{ name: 'change', type: 'artifact', required: true }],
    })
    .addGate({ id: 'signoff', name: 'Ship it?', prompt: 'Ship?', options: [{ value: 'ship', label: 'Ship' }], outputs: [{ name: 'decision', type: 'string', required: true }] })
    .addAgent({
      id: 'notes',
      name: 'Notes',
      role: 'author',
      goal: 'Write notes',
      inputs: [{ name: 'change', type: 'artifact', required: true }],
      outputs: [{ name: 'notes', type: 'artifact', required: true }],
    })
    .connectData({ fromNodeId: '$input', fromPort: 'request', toNodeId: 'build', toPort: 'request' })
    .connectControl('build', 'signoff')
    .connectControl('signoff', 'notes', { kind: 'port_equals', port: 'decision', value: 'ship' })
    .connectData({ fromNodeId: 'build', fromPort: 'change', toNodeId: 'notes', toPort: 'change' })
    .connectData({ fromNodeId: 'notes', fromPort: 'notes', toNodeId: '$output', toPort: 'notes' })
    .buildDefinition();
}

async function runFlow(build: () => AgentExecutionResult): Promise<WorkflowRunState> {
  const runtime = createWorkflowRuntime({
    clock: new DeterministicClock(),
    idGenerator: new SequentialIdGenerator(),
    agentRegistry: new InMemoryAgentRegistry([{ id: 'builder', name: 'Builder', charter: 'Builds.' }]),
    executor: {
      async executeAgent(req) {
        if (req.node.id === 'build') return build();
        return { status: 'COMPLETED', artifacts: { notes: { content: 'notes' } } };
      },
      async executeScript() {
        throw new Error('unused');
      },
    },
  });
  const started = await runtime.start({ definition: reviewFlow(), inputs: { request: 'Add export' } });
  return runtime.runUntilSettled(started.runId);
}

const byId = <T extends { id: string }>(items: readonly T[], id: string) => items.find((i) => i.id === id)!;

describe('buildCanvasModel', () => {
  it('lays out the design view with input/output cards, port handles and conditional edges', () => {
    const model = buildCanvasModel({ definition: reviewFlow(), agentNames: { builder: 'Builder' } });

    expect(model.nodes.map((n) => n.id)).toEqual([INPUTS_NODE_ID, 'build', 'signoff', 'notes', OUTPUTS_NODE_ID]);
    expect(model.nodes.every((n) => n.data.status === 'idle')).toBe(true);
    const xs = model.nodes.map((n) => n.position.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));

    const build = byId(model.nodes, 'build').data;
    expect(build.rows[0]).toMatchObject({ kind: 'agent', value: 'Builder' });
    expect(build.rows.find((r) => r.id === 'in-request')?.handle).toEqual({ type: 'target', id: 'in:request' });

    const dataEdge = byId(model.edges, 'data_$input.request_to_build.request');
    expect(dataEdge).toMatchObject({ sourceHandle: 'out:request', targetHandle: 'in:request' });
    // Unconditional control edges are drawn; conditional ones carry their condition as label.
    expect(model.edges.find((e) => e.data.label === 'if decision = ship')?.data.control).toBe(true);
  });

  it('shows a waiting gate with its question, delivered edges and attempt activity', async () => {
    const run = await runFlow(() => ({ status: 'COMPLETED', artifacts: { change: { content: 'diff' } } }));
    expect(run.status).toBe('WAITING');
    const model = buildCanvasModel({ definition: run.definition, run, runActive: false });

    const gate = byId(model.nodes, 'signoff').data;
    expect(gate.status).toBe('waiting');
    expect(gate.pendingWait?.prompt).toBe('Ship?');
    expect(gate.rows[0]).toMatchObject({ kind: 'decision', value: 'Choose', tone: 'warn' });

    const build = byId(model.nodes, 'build').data;
    expect(build.status).toBe('succeeded');
    expect(build.activity).toHaveLength(1);
    expect(build.rows.find((r) => r.id === 'out-change')?.artifactId).toBeDefined();

    expect(byId(model.edges, 'data_$input.request_to_build.request').data).toMatchObject({
      tone: 'delivered',
      label: 'request · 10 B',
    });
    expect(model.edges.find((e) => e.target === 'signoff')?.data.tone).toBe('flowing');
    expect(describeRun(run, 0)).toEqual({ text: '1 waiting for you', tone: 'warn' });
  });

  it('marks the failed path red and nodes after it as not reached', async () => {
    const run = await runFlow(() => {
      throw new Error('compiler exploded');
    });
    expect(run.status).toBe('FAILED');
    const model = buildCanvasModel({ definition: run.definition, run, runActive: false });

    const build = byId(model.nodes, 'build').data;
    expect(build.status).toBe('failed');
    expect(build.activityTitle).toContain('compiler exploded');
    expect(build.activity[0]?.tone).toBe('danger');
    expect(byId(model.nodes, 'signoff').data.status).toBe('unreached');
    expect(byId(model.edges, 'data_$input.request_to_build.request').data.tone).toBe('failed');
    expect(describeRun(run, 0)).toEqual({ text: 'Failed · 1 node', tone: 'danger' });
  });

  it('treats the scheduler ready set as running while the server drives the run', async () => {
    const run = await runFlow(() => ({ status: 'COMPLETED', artifacts: { change: { content: 'diff' } } }));
    const fresh: WorkflowRunState = {
      ...run,
      status: 'RUNNING',
      scopes: {
        ...run.scopes,
        $root: {
          ...run.scopes.$root!,
          status: 'RUNNING',
          nodes: { ...run.scopes.$root!.nodes, build: { ...run.scopes.$root!.nodes.build!, status: 'PENDING' } },
        },
      },
    };
    const model = buildCanvasModel({ definition: fresh.definition, run: fresh, runActive: true });
    expect(byId(model.nodes, 'build').data.status).toBe('running');
    expect(byId(model.edges, 'data_$input.request_to_build.request').data.tone).toBe('flowing');
  });
});
