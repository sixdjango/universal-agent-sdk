import { ChiefPolicySchema, createBoundedFixLoopFlow, createWorkflowBuilder, resolveSubflows } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, InMemoryArtifactStore, type AgentExecutionRequest } from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { AgentChiefSupervisor } from '../src/llm-chief';

describe('chief diagnoses artifacts and delegates repairs', () => {
  it('exposes exact command targets for a loop inside a parallel sub-flow without joining scopeKey and nodeId', async () => {
    const child = createBoundedFixLoopFlow({ id: 'child', authorGoal: 'Add', acceptanceCriteria: ['Adds'], maxRounds: 1 });
    const parent = createWorkflowBuilder('parallel-chief').setChief({ maxInterventionsPerRun: 1 })
      .addWorkflowInput({ name: 'specifications', type: 'array', required: true })
      .addSubflow({ id: 'repair', name: 'Repair', workflowId: child.id, inputs: child.inputs, outputs: child.outputs,
        parallel: { itemsPort: 'specification', maxConcurrency: 2, failurePolicy: 'settle_all' } })
      .connectData({ fromNodeId: '$input', fromPort: 'specifications', toNodeId: 'repair', toPort: 'specification' }).buildDefinition();
    const calls = new Map<string, number>();
    const affectedScope = '$root/repair[0]/repair:round_0/fix_loop:round_0';
    const siblingScope = '$root/repair[1]/repair:round_0/fix_loop:round_0';
    const runtime = createWorkflowRuntime({ chief: new AgentChiefSupervisor(), executor: {
      async executeAgent(req) {
        if (req.node.id === '$chief') {
          const assessments = req.renderedPrompt.split('## Recent Assessments\n')[1]!.split('\n\n')[0]!;
          const assessmentTarget = JSON.parse(assessments.match(/target=(\{[^\n]+?\}): FAIL/)![1]!);
          expect(assessmentTarget).toEqual({ scopeKey: affectedScope, nodeId: 'reviewer' });
          const targets = [...req.renderedPrompt.matchAll(/target=(\{[^\n]+?\})/g)].map(match => JSON.parse(match[1]!));
          const producer = targets.find(target => target.scopeKey === assessmentTarget.scopeKey && target.nodeId === 'author');
          expect(producer).toEqual({ scopeKey: affectedScope, nodeId: 'author' });
          expect(targets).toContainEqual({ scopeKey: siblingScope, nodeId: 'author' });
          expect(req.renderedPrompt).not.toContain(`${affectedScope}/reviewer:`);
          return { status: 'COMPLETED', outputs: { decision: { rationale: 'Repair only the failed item', commands: [
            { kind: 'inject_guidance', ...producer, text: 'Use addition.' },
            { kind: 'rerun_from_node', ...producer },
          ] } } };
        }
        if (req.node.id === 'author') {
          calls.set(req.scopeKey, (calls.get(req.scopeKey) ?? 0) + 1);
          return { status: 'COMPLETED', artifacts: { candidate: { content: req.scopeKey === affectedScope && calls.get(req.scopeKey) === 1 ? 'subtract' : 'add' } } };
        }
        return { status: 'COMPLETED', assessment: { verdict: req.scopeKey === affectedScope && calls.get(req.scopeKey) === 1 ? 'FAIL' : 'PASS', summary: 'Check addition' } };
      },
      async executeScript() { throw new Error('unused'); },
    } });
    const definition = await resolveSubflows(parent, async () => child);
    const done = await runtime.runUntilSettled((await runtime.start({ definition, inputs: { specifications: ['alpha', 'beta'] } })).runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(calls.get(affectedScope)).toBe(2);
    expect(calls.get(siblingScope)).toBe(1);
    expect(done.events.find(event => event.type === 'chief.intervened')).toMatchObject({ rejected: [], applied: [
      { kind: 'inject_guidance', scopeKey: affectedScope, nodeId: 'author' },
      { kind: 'rerun_from_node', scopeKey: affectedScope, nodeId: 'author' },
    ] });
  });

  it('reads this run’s artifact, guides its producer, and reruns the independent reviewer', async () => {
    const artifacts = new InMemoryArtifactStore();
    const foreign = await artifacts.put({ content: 'another run', producerRunId: 'foreign', producerNodeId: 'author', producerAttemptId: 'foreign', portName: 'candidate' });
    const original = 'Incorrect calculation\n'.repeat(8000) + 'BUG: subtract instead of add';
    const requests: AgentExecutionRequest[] = [];
    const flow = createBoundedFixLoopFlow({ id: 'chief-repair', authorGoal: 'Implement addition', acceptanceCriteria: ['Adds correctly'], maxRounds: 1 });
    flow.chief = ChiefPolicySchema.parse({ maxInterventionsPerRun: 2 });
    let authorCalls = 0;
    let reviewCalls = 0;
    const runtime = createWorkflowRuntime({
      artifacts, chief: new AgentChiefSupervisor(),
      executor: {
        async executeAgent(req) {
          requests.push(req);
          if (req.node.id === '$chief') {
            expect(req.node.writeScopes).toEqual([]);
            const candidate = req.manifest.entries.find(entry => entry.sourceNodeId === 'author' && entry.sourcePort === 'candidate')!.artifactRef!;
            expect(req.renderedPrompt).toContain(candidate.artifactId);
            expect(req.artifactReader.getRemainingQuotaBytes()).toBeNull();
            await expect(req.artifactReader.readPage(foreign.artifactId)).rejects.toThrow('not authorized');
            let text = '';
            let offsetBytes = 0;
            while (true) {
              const page = await req.artifactReader.readPage(candidate.artifactId, { offsetBytes });
              text += page.content;
              if (!page.hasMore) break;
              offsetBytes = page.nextOffsetBytes!;
            }
            expect(text).toBe(original);
            return { status: 'COMPLETED', outputs: { decision: { rationale: 'The artifact subtracts; ask its producer to repair and verify again', commands: [
              { kind: 'inject_guidance', scopeKey: '$root/fix_loop:round_0', nodeId: 'author', text: 'Replace subtraction with addition.' },
              { kind: 'rerun_from_node', scopeKey: '$root/fix_loop:round_0', nodeId: 'author' },
            ] } } };
          }
          if (req.node.id === 'author') {
            authorCalls++;
            if (authorCalls === 2) expect(req.renderedPrompt).toContain('Replace subtraction with addition.');
            return { status: 'COMPLETED', artifacts: { candidate: { content: authorCalls === 1 ? original : 'return a + b;' } } };
          }
          reviewCalls++;
          return { status: 'COMPLETED', assessment: { verdict: reviewCalls === 1 ? 'FAIL' : 'PASS', summary: reviewCalls === 1 ? 'Subtraction is wrong' : 'Addition verified' } };
        },
        async executeScript() { throw new Error('unused'); },
      },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition: flow, inputs: { specification: 'Add two numbers' } })).runId);
    expect(done.status, JSON.stringify(done.events.filter(event => event.type === 'chief.intervened'))).toBe('SUCCEEDED');
    expect(authorCalls).toBe(2);
    expect(reviewCalls).toBe(2);
    expect(requests.filter(req => req.node.id === '$chief')).toHaveLength(1);
    const authorAttempts = Object.values(done.attempts).filter(attempt => attempt.nodeId === 'author');
    expect(authorAttempts).toHaveLength(2);
    expect(await artifacts.readText(authorAttempts[0].producedArtifactIds[0])).toBe(original);
    expect(await artifacts.readText(authorAttempts[1].producedArtifactIds[0])).toBe('return a + b;');
    expect(Object.values(done.assessments).map(item => [item.verdict, item.stale])).toEqual([['FAIL', true], ['PASS', false]]);
    const chiefManifest = Object.values(done.manifests).find(manifest => manifest.nodeId === '$chief')!;
    expect(chiefManifest.authorizedArtifactIds).not.toContain(foreign.artifactId);
    expect(done.readReceipts.filter(receipt => receipt.attemptId === chiefManifest.attemptId).length).toBeGreaterThan(16);
    expect(done.definition).toEqual(flow);
  });

  it('does not apply a decision from an incomplete chief turn', async () => {
    const definition = createWorkflowBuilder('incomplete-chief')
      .setChief({ maxInterventionsPerRun: 1 })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', goal: 'Work', maxTechnicalRetries: 0 })
      .buildDefinition();
    let workerCalls = 0;
    const runtime = createWorkflowRuntime({
      chief: new AgentChiefSupervisor(),
      executor: {
        async executeAgent(req) {
          if (req.node.id !== '$chief') { workerCalls++; throw new Error('broken'); }
          return { status: 'WAIT_REQUESTED', waitRequest: { prompt: 'unfinished decision' }, outputs: {
            decision: { rationale: 'partial retry', commands: [{ kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' }] },
          } };
        },
        async executeScript() { throw new Error('unused'); },
      },
    });
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('FAILED');
    expect(workerCalls).toBe(1);
    expect(done.events.find(event => event.type === 'chief.intervened')).toMatchObject({
      applied: [], rationale: expect.stringContaining('did not complete'),
    });
  });
});
