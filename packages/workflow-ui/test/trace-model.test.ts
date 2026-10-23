import { createWorkflowBuilder, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import {
  createWorkflowRuntime,
  DeterministicClock,
  InMemoryAgentRegistry,
  SequentialIdGenerator,
} from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildTraceModel, formatCostUsd, formatDurationMs, formatTokenCount } from '../src/model/trace';

function traceWorkflow(): WorkflowDefinition {
  return createWorkflowBuilder('trace-flow', 'Trace flow')
    .addWorkflowInput({ name: 'request', type: 'string', required: true })
    .addWorkflowOutput({ name: 'notes', type: 'artifact', required: true })
    .addAgent({
      id: 'build',
      name: 'Build the change',
      role: 'author',
      agentRef: 'builder',
      goal: 'Build it',
      inputs: [{ name: 'request', type: 'string', required: true }],
      outputs: [{ name: 'change', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'review',
      name: 'Review the change',
      role: 'reviewer',
      goal: 'Review it',
      acceptanceCriteria: ['Works as requested'],
      producesAssessment: true,
      inputs: [{ name: 'change', type: 'artifact', required: true }],
    })
    .connectData({ fromNodeId: '$input', fromPort: 'request', toNodeId: 'build', toPort: 'request' })
    .connectData({ fromNodeId: 'build', fromPort: 'change', toNodeId: 'review', toPort: 'change', withControl: true })
    .connectData({ fromNodeId: 'build', fromPort: 'change', toNodeId: '$output', toPort: 'notes' })
    .buildDefinition();
}

describe('buildTraceModel', () => {
  it('computes KPI totals, waterfall spans, child sub-spans, and marks the slowest span', async () => {
    let now = 1000;
    const clock = {
      nowMs() {
        now += 10;
        return now;
      },
    };
    const runtime = createWorkflowRuntime({
      clock,
      idGenerator: new SequentialIdGenerator(),
      agentRegistry: new InMemoryAgentRegistry([
        { id: 'builder', name: 'Builder', charter: 'Builds.', runtime: { adapter: 'acp', agentType: 'deepseek' } },
      ]),
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'build') {
            now += 4200;
            return {
              status: 'COMPLETED',
              artifacts: { change: { content: '# Diff\nAdded feature' } },
              receipt: {
                attemptId: req.attemptId,
                agentType: 'deepseek',
                inputTokens: 2400,
                outputTokens: 800,
                totalCostUsd: 0.08,
                durationMs: 4200,
              },
            };
          }
          now += 1800;
          return {
            status: 'COMPLETED',
            assessment: { verdict: 'PASS', summary: 'All criteria hold.' },
            receipt: {
              attemptId: req.attemptId,
              agentType: 'deepseek',
              inputTokens: 1500,
              outputTokens: 300,
              totalCostUsd: 0.04,
              durationMs: 1800,
            },
          };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });

    const started = await runtime.start({
      definition: traceWorkflow(),
      inputs: { request: 'Launch the new pricing page by Friday' },
    });
    const run = await runtime.runUntilSettled(started.runId);
    expect(run.status).toBe('SUCCEEDED');

    const trace = buildTraceModel({
      run,
      runActive: false,
      agentNames: { builder: 'Builder' },
    });

    expect(trace.status).toBe('done');
    expect(trace.headline).toBe('Launch the new pricing page by Friday');
    expect(trace.llmCalls).toBe(2);
    expect(trace.totalTokens).toBe(5000);
    expect(trace.totalCostUsd).toBeCloseTo(0.12, 5);
    expect(trace.errorCount).toBe(0);
    expect(trace.spans).toHaveLength(2);

    const buildSpan = trace.spans[0]!;
    expect(buildSpan.title).toBe('Build the change');
    expect(buildSpan.subtitle).toContain('Builder');
    expect(buildSpan.isSlowest).toBe(true);
    expect(buildSpan.children.length).toBeGreaterThan(0);

    const reviewSpan = trace.spans[1]!;
    expect(reviewSpan.title).toBe('Review the change');
    expect(reviewSpan.verdict).toBe('PASS');
    expect(reviewSpan.isSlowest).toBeUndefined();
  });

  it('formats durations, costs, and token counts cleanly', () => {
    expect(formatDurationMs(800)).toBe('0.8s');
    expect(formatDurationMs(6900)).toBe('6.9s');
    expect(formatDurationMs(82_000)).toBe('1m 22s');
    expect(formatCostUsd(0.12)).toBe('$0.12');
    expect(formatTokenCount(99_700)).toBe('99.7k');
  });
});
