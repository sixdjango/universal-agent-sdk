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

  it('fans out a parallel node into concurrent item cards with fanned-out edges during a run', async () => {
    const definition = createWorkflowBuilder('parallel-flow', 'Parallel flow')
      .addWorkflowInput({ name: 'topics', type: 'json', required: true })
      .addWorkflowOutput({ name: 'digest', type: 'artifact', required: true })
      .addParallel({
        id: 'explain_each',
        name: 'Explain each topic',
        itemsPort: 'topics',
        maxConcurrency: 3,
        failurePolicy: 'fail_fast',
        inputs: [{ name: 'topics', type: 'json', required: true }],
        outputs: [{ name: 'results', type: 'json', required: true }],
        itemBody: (b) =>
          b
            .addAgent({
              id: 'explain',
              name: 'Explain one topic',
              role: 'author',
              goal: 'Explain the topic',
              inputs: [{ name: 'topic', type: 'json', required: true }],
              outputs: [{ name: 'explanation', type: 'string', required: true }],
            })
            .connectData({ fromNodeId: '$input', fromPort: 'topics', toNodeId: 'explain', toPort: 'topic' })
            .connectData({ fromNodeId: 'explain', fromPort: 'explanation', toNodeId: '$output', toPort: 'results' }),
      })
      .addAgent({
        id: 'combine',
        name: 'Write digest',
        role: 'author',
        goal: 'Combine explanations',
        inputs: [{ name: 'explanations', type: 'json', required: true }],
        outputs: [{ name: 'digest', type: 'artifact', required: true }],
      })
      .connectData({ fromNodeId: '$input', fromPort: 'topics', toNodeId: 'explain_each', toPort: 'topics' })
      .connectData({
        fromNodeId: 'explain_each',
        fromPort: 'results',
        toNodeId: 'combine',
        toPort: 'explanations',
        withControl: true,
      })
      .connectData({ fromNodeId: 'combine', fromPort: 'digest', toNodeId: '$output', toPort: 'digest' })
      .buildDefinition();

    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'explain') {
            return {
              status: 'COMPLETED',
              outputs: { explanation: `Explained ${String(req.inputs.topic)}` },
            };
          }
          return {
            status: 'COMPLETED',
            artifacts: { digest: { content: 'Combined digest' } },
          };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });

    // Even when started with a comma-separated string, coerceParallelItems splits into 3 concurrent items
    const started = await runtime.start({
      definition,
      inputs: { topics: 'SQLite WAL, CRDTs, Raft' },
    });

    // Right after start (before runUntilSettled finishes), previewItems already fans out 3 concurrent running cards
    const runningModel = buildCanvasModel({ definition, run: started, runActive: true });
    expect(runningModel.nodes.map((n) => n.id)).toEqual([
      INPUTS_NODE_ID,
      'explain_each[0]',
      'explain_each[1]',
      'explain_each[2]',
      'combine',
      OUTPUTS_NODE_ID,
    ]);
    expect(byId(runningModel.nodes, 'explain_each[0]').data).toMatchObject({
      title: 'Explain each topic #1',
      subtitle: 'SQLite WAL',
      status: 'running',
      scopeNodeId: 'explain_each',
      itemIndex: 0,
    });
    expect(byId(runningModel.nodes, 'explain_each[1]').data).toMatchObject({
      title: 'Explain each topic #2',
      subtitle: 'CRDTs',
      status: 'running',
      scopeNodeId: 'explain_each',
      itemIndex: 1,
    });
    expect(byId(runningModel.nodes, 'explain_each[2]').data).toMatchObject({
      title: 'Explain each topic #3',
      subtitle: 'Raft',
      status: 'running',
      scopeNodeId: 'explain_each',
      itemIndex: 2,
    });
    // Edges fan out from $input to all 3 item cards and fan in from all 3 item cards to combine
    expect(runningModel.edges.filter((e) => e.source === INPUTS_NODE_ID && !e.data.control)).toHaveLength(3);
    expect(runningModel.edges.filter((e) => e.target === 'combine' && !e.data.control)).toHaveLength(3);
    // Flow lines show the order; parameter lines wait until a card is selected.
    expect(runningModel.edges.filter((e) => e.source === INPUTS_NODE_ID && e.data.control)).toHaveLength(3);
    expect(runningModel.edges.filter((e) => e.target === 'combine' && e.data.control)).toHaveLength(3);
    expect(runningModel.edges.filter((e) => !e.data.control).every((e) => e.hidden)).toBe(true);

    const settled = await runtime.runUntilSettled(started.runId);
    expect(settled.status).toBe('SUCCEEDED');
    const settledModel = buildCanvasModel({ definition, run: settled, runActive: false });
    expect(settledModel.nodes.map((n) => n.id)).toEqual([
      INPUTS_NODE_ID,
      'explain_each[0]',
      'explain_each[1]',
      'explain_each[2]',
      'combine',
      OUTPUTS_NODE_ID,
    ]);
    expect(byId(settledModel.nodes, 'explain_each[0]').data.status).toBe('succeeded');
    expect(byId(settledModel.nodes, 'explain_each[1]').data.status).toBe('succeeded');
    expect(byId(settledModel.nodes, 'explain_each[2]').data.status).toBe('succeeded');
  });
});
