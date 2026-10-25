import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { type AgentExecutionRequest, type AgentExecutionResult, createWorkflowRuntime, type OpenFinding } from '../src/index';

describe('open findings', () => {
  it("keeps what the last round of each review left and what steps logged, most severe first, for any step to read", async () => {
    let reviews = 0;
    let seenByLastStep: OpenFinding[] = [];
    const runtime = createWorkflowRuntime({
      executor: {
        async executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
          if (req.node.id === 'write') {
            // A compromise the writer knowingly leaves for a person.
            await req.data!.append('issues', { severity: 'major', message: 'Uses a system font instead of Helvetica Neue', file: 'app/styles.css', why: 'font not available' }, { shared: true });
            return { status: 'COMPLETED', outputs: { draft: 'v' } };
          }
          if (req.node.id === 'review') {
            reviews += 1;
            return reviews === 1
              ? { status: 'COMPLETED', assessment: { verdict: 'NEEDS_FIX', summary: 'Wrong colours', findings: [{ id: 'a', severity: 'major', message: 'Header colour is off' }] } }
              : { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'Good enough', findings: [{ id: 'b', severity: 'minor', message: 'Card radius 16px, design has 14px', filePath: 'app/styles.css', line: 12 }] } };
          }
          seenByLastStep = (await req.data!.findings?.()) ?? [];
          return { status: 'COMPLETED' };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const definition = createWorkflowBuilder('handoff')
      .addAgent({ id: 'write', name: 'Write', role: 'writer', goal: 'Write', outputs: [{ name: 'draft', type: 'string', required: true }] })
      .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Review', producesAssessment: true, inputs: [{ name: 'draft', type: 'string', required: true }] })
      .addAgent({ id: 'handoff', name: 'Hand off', role: 'writer', goal: 'Hand off' })
      .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
      .loopBack('review', 'write', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2 })
      .connectControl('review', 'handoff')
      .buildDefinition();
    const { runId } = await runtime.start({ definition });
    const done = await runtime.runUntilSettled(runId);
    expect(done.status).toBe('SUCCEEDED');

    const findings = await runtime.getOpenFindings(runId);
    // Round 1's "header colour" was fixed in round 2; the compromise the writer logged in both rounds counts once.
    expect(findings.map((f) => [f.source, f.severity, f.message])).toEqual([
      ['issue', 'major', 'Uses a system font instead of Helvetica Neue'],
      ['assessment', 'minor', 'Card radius 16px, design has 14px'],
    ]);
    expect(findings[0]).toMatchObject({ nodeId: 'write', filePath: 'app/styles.css', details: { why: 'font not available' } });
    expect(findings[0]!.scopeKey).toMatch(/round_1$/);
    expect(findings[1]).toMatchObject({ nodeId: 'review', verdict: 'PASS', filePath: 'app/styles.css', line: 12 });
    expect(findings[1]!.scopeKey).toMatch(/round_1$/);
    expect(seenByLastStep).toEqual(findings);
  });
});
