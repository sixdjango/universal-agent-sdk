import { createWorkflowBuilder, type EdgeCondition } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { type AgentExecutionRequest, type AgentExecutionResult, createWorkflowRuntime, evaluateEdgeCondition } from '../src/index';

/** Scope state with node outputs and verdicts, as the scheduler sees them. */
function scope(nodes: Record<string, { outputs?: Record<string, unknown>; verdict?: string }>) {
  return {
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, n]) => [
        id,
        {
          status: 'SUCCEEDED',
          outputs: Object.fromEntries(Object.entries(n.outputs ?? {}).map(([k, value]) => [k, { value }])),
          ...(n.verdict ? { latestVerdict: n.verdict } : {}),
        },
      ])
    ),
  } as unknown as Parameters<typeof evaluateEdgeCondition>[2];
}

describe('edge conditions', () => {
  const state = scope({
    audit: { outputs: { score: 82, files: ['a.ts', 'b.ts', 'c.ts'], mode: 'fast', note: 'ok' }, verdict: 'PASS' },
    coverage: { outputs: { percent: 64 }, verdict: 'NEEDS_FIX' },
  });
  const holds = (condition: EdgeCondition) => evaluateEdgeCondition(condition, 'audit', state);

  it('compares numbers by size, lists and text by length, and anything by equality', () => {
    expect(holds({ kind: 'port_compare', port: 'score', op: '>=', value: 80 })).toBe(true);
    expect(holds({ kind: 'port_compare', port: 'score', op: '<', value: 80 })).toBe(false);
    expect(holds({ kind: 'port_compare', port: 'files', op: '>', value: 2, measure: 'length' })).toBe(true);
    expect(holds({ kind: 'port_compare', port: 'note', op: '==', value: 2, measure: 'length' })).toBe(true);
    expect(holds({ kind: 'port_compare', port: 'mode', op: '!=', value: 'slow' })).toBe(true);
    // Ordering text, or a missing output, never holds.
    expect(holds({ kind: 'port_compare', port: 'mode', op: '>', value: 1 })).toBe(false);
    expect(holds({ kind: 'port_compare', port: 'missing', op: '<', value: 1 })).toBe(false);
    expect(holds({ kind: 'port_compare', port: 'percent', op: '<', value: 80, sourceNodeId: 'coverage' })).toBe(true);
  });

  it('combines conditions with all / any, each reading its own step or the edge\'s', () => {
    const passedAndCovered: EdgeCondition = {
      kind: 'all',
      conditions: [
        { kind: 'verdict_is', verdict: 'PASS' },
        { kind: 'port_compare', port: 'percent', op: '>=', value: 80, sourceNodeId: 'coverage' },
      ],
    };
    expect(holds(passedAndCovered)).toBe(false);
    expect(holds({ kind: 'any', conditions: passedAndCovered.kind === 'all' ? passedAndCovered.conditions : [] })).toBe(true);
    expect(holds({ kind: 'any', conditions: [{ kind: 'verdict_is', verdict: 'FAIL' }, { kind: 'all', conditions: [{ kind: 'port_truthy', port: 'note' }, { kind: 'port_compare', port: 'score', op: '>', value: 50 }] }] })).toBe(true);
  });

  it('routes a run by score: the high branch runs, the low one and the otherwise branch are skipped', async () => {
    const ran: string[] = [];
    const runtime = createWorkflowRuntime({
      executor: {
        async executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
          ran.push(req.node.id);
          return req.node.id === 'score' ? { status: 'COMPLETED', outputs: { score: 91, issues: [] } } : { status: 'COMPLETED' };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, role: 'worker', goal: id, ...extra });
    const flow = createWorkflowBuilder('route')
      .addAgent(step('score', { outputs: [{ name: 'score', type: 'number', required: true }, { name: 'issues', type: 'array', required: true }] }))
      .addAgent(step('ship'))
      .addAgent(step('polish'))
      .addAgent(step('triage'))
      .connectControl('score', 'ship', { kind: 'all', conditions: [{ kind: 'port_compare', port: 'score', op: '>=', value: 90 }, { kind: 'port_compare', port: 'issues', op: '==', value: 0, measure: 'length' }] })
      .connectControl('score', 'polish', { kind: 'port_compare', port: 'score', op: '<', value: 90 })
      .connectControl('score', 'triage', { kind: 'otherwise' })
      .buildDefinition();
    const { runId } = await runtime.start({ definition: flow });
    const done = await runtime.runUntilSettled(runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(ran.sort()).toEqual(['score', 'ship']);
    expect(done.scopes.$root!.nodes.polish!.status).toBe('SKIPPED');
    expect(done.scopes.$root!.nodes.triage!.status).toBe('SKIPPED');
  });
});
