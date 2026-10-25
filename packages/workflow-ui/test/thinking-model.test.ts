import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  createWorkflowRuntime,
  InMemoryAgentRegistry,
  SequentialIdGenerator,
} from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel } from '../src/model/canvas';
import { buildTraceModel } from '../src/model/trace';
import { buildChiefThread } from '../src/model/chief-thread';
import { buildChiefThinkingTrace, buildNodeThinkingTrace } from '../src/model/thinking';

describe('thinking trace model', () => {
  it('builds live running steps from liveProgress and falls back to node definition', () => {
    const def = createWorkflowBuilder('think-flow', 'Think flow')
      .addWorkflowInput({ name: 'topic', type: 'string', required: true })
      .addAgent({
        id: 'writer',
        name: 'Write draft',
        role: 'author',
        goal: 'Write a draft',
        acceptanceCriteria: ['Clear structure', 'Concrete examples'],
        inputs: [{ name: 'topic', type: 'string', required: true }],
        outputs: [{ name: 'draft', type: 'artifact', required: true }],
      })
      .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'writer', toPort: 'topic' })
      .buildDefinition();

    const fallback = buildNodeThinkingTrace({
      node: def.graph.nodes[0]!,
      status: 'running',
    });
    expect(fallback).toBeDefined();
    expect(fallback?.state).toBe('running');
    expect(fallback?.headerLabel).toBe('Thinking');
    expect(fallback?.steps[0]).toMatchObject({
      kind: 'read',
      status: 'done',
      label: 'Prepared 1 input',
      pills: [{ label: 'topic', badge: 'IN' }],
    });
    expect(fallback?.steps[1]).toMatchObject({
      kind: 'think',
      status: 'running',
      label: 'Working on "Write draft"',
    });

    const withLive = buildNodeThinkingTrace({
      node: def.graph.nodes[0]!,
      status: 'running',
      live: {
        runId: 'run_1',
        scopeKey: '$root',
        nodeId: 'writer',
        attemptId: 'att_1',
        startedAtMs: 1000,
        steps: [
          {
            id: 's1',
            kind: 'search',
            status: 'done',
            label: 'Searched the codebase',
            pills: [{ label: 'router.ts', badge: 'TS' }, { label: 'auth.ts', badge: 'TS' }],
          },
          {
            id: 's2',
            kind: 'read',
            status: 'running',
            label: 'Reading 2 of 4 files',
          },
        ],
      },
    });
    expect(withLive?.startedAtMs).toBe(1000);
    expect(withLive?.steps).toHaveLength(2);
    expect(withLive?.steps[0]?.pills).toHaveLength(2);
  });

  it('attaches completed thinking trace with receipt steps, file diffs and verdict to execution details and chief thread', async () => {
    const def = createWorkflowBuilder('think-done', 'Think done')
      .addWorkflowInput({ name: 'request', type: 'string', required: true })
      .addAgent({
        id: 'review',
        name: 'Review code',
        role: 'reviewer',
        agentRef: 'critic',
        goal: 'Review',
        producesAssessment: true,
        inputs: [{ name: 'request', type: 'string', required: true }],
      })
      .connectData({ fromNodeId: '$input', fromPort: 'request', toNodeId: 'review', toPort: 'request' })
      .setChief({ maxLevel: 'advise' })
      .buildDefinition();

    let now = 1000;
    const clock = { nowMs: () => now };
    const runtime = createWorkflowRuntime({
      clock,
      idGenerator: new SequentialIdGenerator(),
      agentRegistry: new InMemoryAgentRegistry([{ id: 'critic', name: 'Critic', charter: 'Reviews.' }]),
      chief: {
        async review() {
          now += 3200;
          return {
            rationale: 'Checked the review findings and added guidance',
            reply: 'Everything passed cleanly.',
            commands: [],
          };
        },
      },
      executor: {
        async executeAgent() {
          now += 5400;
          return {
            status: 'COMPLETED',
            assessment: {
              verdict: 'PASS',
              summary: 'All criteria hold',
              findings: [],
            },
            receipt: {
              durationMs: 5400,
              steps: [
                {
                  id: 'step-search',
                  kind: 'search',
                  status: 'done',
                  label: 'Searched the codebase',
                  pills: [{ label: 'router.ts', badge: 'TS' }],
                },
                {
                  id: 'step-read',
                  kind: 'read',
                  status: 'done',
                  label: 'Read 3 files',
                  pills: [
                    { label: 'router.ts', badge: 'TS' },
                    { label: 'auth.ts', badge: 'TS' },
                    { label: 'Button.tsx', badge: 'TSX' },
                  ],
                },
              ],
            },
            changes: {
              diff: '--- a/src/router.ts\n+++ b/src/router.ts',
              files: [{ path: 'src/router.ts', status: 'M' }],
            },
          };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });

    const started = await runtime.start({ definition: def, inputs: { request: 'check auth' } });
    let run = await runtime.runUntilSettled(started.runId);
    const msg = await runtime.postChiefMessage({ runId: run.runId, text: 'How did it go?', authorId: 'user' });
    run = await runtime.answerChiefMessage({ runId: run.runId, messageId: msg.messageId });

    // The card stays compact; the timeline lives in the step's execution details panel.
    const canvas = buildCanvasModel({ definition: def, run });
    expect('thinking' in canvas.nodes.find((n) => n.id === 'review')!.data).toBe(false);
    const reviewCard = buildTraceModel({ run, nowMs: now }).spans.find((span) => span.nodeId === 'review')!;
    expect(reviewCard.thinking).toBeDefined();
    expect(reviewCard.thinking?.state).toBe('done');
    expect(reviewCard.thinking?.headerLabel).toBe('Thought for 5s');
    expect(reviewCard.thinking?.steps.map((s) => s.label)).toEqual([
      'Searched the codebase',
      'Read 3 files',
      'Updated 1 file',
      'Verdict: PASS',
    ]);
    expect(reviewCard.thinking?.summary).toContain('PASS');

    const thread = buildChiefThread(run, (id) => id);
    const chiefReply = thread.items.find((i) => i.kind === 'chief');
    expect(chiefReply && chiefReply.kind === 'chief' ? chiefReply.thinking : undefined).toMatchObject({
      state: 'done',
      headerLabel: 'Thought for 3s',
    });

    const liveChief = buildChiefThinkingTrace({
      running: true,
      live: {
        runId: run.runId,
        scopeKey: '$root',
        nodeId: '$chief',
        attemptId: 'chief_1',
        startedAtMs: 2000,
        steps: [{ id: 'c1', kind: 'think', status: 'running', label: 'Checking scope status' }],
      },
    });
    expect(liveChief.state).toBe('running');
    expect(liveChief.steps[0]?.label).toBe('Checking scope status');
  });
});
