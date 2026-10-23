import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel } from '../src/model/canvas';
import { describeRuntime, effectiveRuntime } from '../src/model/runtime';

const claudeAgent = { agentType: 'claude', modelId: 'sonnet', effort: 'medium', adapter: 'acp' };

describe('client / model / effort per step', () => {
  it('layers step overrides over the agent runtime, dropping the agent model on another client', () => {
    expect(effectiveRuntime({}, claudeAgent)).toEqual({ agentType: 'claude', modelId: 'sonnet', effort: 'medium' });
    expect(effectiveRuntime({ effort: 'high' }, claudeAgent)).toEqual({ agentType: 'claude', modelId: 'sonnet', effort: 'high' });
    expect(effectiveRuntime({ agentType: 'codex' }, claudeAgent)).toEqual({ agentType: 'codex', effort: 'medium' });
    expect(describeRuntime({ agentType: 'codex', modelId: 'gpt-5.5', effort: 'xhigh' })).toBe('codex · gpt-5.5 · xhigh');
    expect(describeRuntime({})).toBeUndefined();
  });

  it('shows what a step runs on, from its design and from the attempt that ran', () => {
    const definition = createWorkflowBuilder('rt')
      .addAgent({ id: 'write', name: 'Write', role: 'writer', agentRef: 'writer', goal: 'Write', modelId: 'opus[1m]', effort: 'max' })
      .buildDefinition();
    const design = buildCanvasModel({ definition, agentNames: { writer: 'Writer' }, agentRuntimes: { writer: claudeAgent } });
    const card = design.nodes.find((n) => n.id === 'write')!.data;
    expect(card.rows.find((r) => r.id === 'runtime')?.value).toBe('claude · opus[1m] · max');
    expect(card.runtimeChoice).toEqual({ modelId: 'opus[1m]', effort: 'max' });

    const run = {
      runId: 'r',
      definition,
      definitionDigest: 'sha256:x',
      status: 'SUCCEEDED',
      revision: 3,
      coordinatorEpoch: 1,
      inputs: {},
      outputs: {},
      scopes: {
        $root: {
          scopeKey: '$root',
          scopePath: '$root',
          status: 'SUCCEEDED',
          inputs: {},
          outputs: {},
          nodes: { write: { nodeId: 'write', status: 'SUCCEEDED', retryCount: 0, outputs: {}, latestAttemptId: 'a1' } },
        },
      },
      attempts: {
        a1: {
          attemptId: 'a1',
          invocationId: 'i',
          runId: 'r',
          scopeKey: '$root',
          nodeId: 'write',
          retryIndex: 0,
          roundIndex: 0,
          phase: 'publish',
          status: 'SUCCEEDED',
          producedArtifactIds: [],
          receipt: { attemptId: 'a1', durationMs: 1, agentType: 'claude', modelId: 'haiku', effort: 'low' },
          startedAtMs: 1,
        },
      },
      manifests: {},
      assessments: {},
      waitRequests: {},
      readReceipts: [],
      events: [],
      pinnedAgents: {},
      chief: { interventionCount: 0, processedEventCount: 0, guidance: [], agentOverrides: [], loopExtensions: {}, budgetTriggered: false },
      createdAtMs: 1,
      updatedAtMs: 1,
    } as unknown as WorkflowRunState;
    const ran = buildCanvasModel({ definition, run, agentRuntimes: { writer: claudeAgent } });
    expect(ran.nodes.find((n) => n.id === 'write')!.data.rows.find((r) => r.id === 'runtime')?.value).toBe('claude · haiku · low');
  });
});
