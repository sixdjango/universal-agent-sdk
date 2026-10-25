import { createWorkflowBuilder, type ChiefCommand } from '@universal-agent/workflow-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactQuotaExceededError, createWorkflowRuntime, InMemoryArtifactStore,
  type ChiefReviewInput, type ChiefRuntimeOptions, type ChiefSupervisor, type WorkflowRuntime,
} from '../src/index';

const unused = async () => { throw new Error('unused'); };
async function ask(runtime: WorkflowRuntime, runId: string) {
  const { messageId } = await runtime.postChiefMessage({ runId, text: 'Diagnose', authorId: 'host' });
  return runtime.answerChiefMessage({ runId, messageId });
}

describe('chief host configuration', () => {
  it.each(['automatic', 'chat'] as const)('enforces the host command allowlist for %s decisions', async mode => {
    const inputs: ChiefReviewInput[] = [];
    let calls = 0;
    const allowed: ChiefCommand['kind'][] = ['report'];
    const runtime = createWorkflowRuntime({
      chiefOptions: { allowedCommands: allowed },
      chief: { async review(input) {
        inputs.push(input);
        return { rationale: 'Try a repair', commands: [
          { kind: 'report', summary: 'Failed' },
          { kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' },
        ] };
      } },
      executor: { async executeAgent() { calls++; throw new Error('broken'); }, executeScript: unused },
    });
    // Changing a caller-owned array cannot silently change an existing runtime's policy.
    allowed.push('retry_node');
    const definition = createWorkflowBuilder('host-commands')
      .setChief({ triggers: mode === 'automatic' ? ['node.failed'] : [] })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', goal: 'Work', maxTechnicalRetries: 0 }).buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const answered = mode === 'chat' ? await ask(runtime, done.runId) : done;
    expect(calls).toBe(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].allowedCommands).toEqual(['report']);
    expect(answered.status).toBe('FAILED');
    expect(answered.events.find(e => e.type === 'chief.intervened')).toMatchObject({
      applied: [{ kind: 'report' }], rejected: [{ command: { kind: 'retry_node' }, reason: expect.stringContaining('disabled by the host') }],
    });
    expect(answered.definition).toEqual(definition);
  });

  it.each([{ allowedCommands: ['report', 'rerun_from_node'] }, { allowedCommands: [] }] as { allowedCommands: ChiefCommand['kind'][] }[])(
    'intersects host commands $allowedCommands with the workflow level', async ({ allowedCommands }) => {
    let advertised: readonly string[] | undefined;
    const runtime = createWorkflowRuntime({
      chiefOptions: { allowedCommands },
      chief: { async review(input) {
        advertised = input.allowedCommands;
        return { rationale: 'Try to reopen', commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'worker' }] };
      } },
      executor: { async executeAgent() { return { status: 'COMPLETED' }; }, executeScript: unused },
    });
    const definition = createWorkflowBuilder('host-level').setChief({ triggers: [], maxLevel: 'observe' })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', goal: 'Work' }).buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const answered = await ask(runtime, done.runId);
    expect(advertised).toEqual(allowedCommands.includes('report') ? ['report'] : []);
    expect(answered.status).toBe('SUCCEEDED');
    expect(answered.events.find(e => e.type === 'chief.intervened')).toMatchObject({ applied: [], rejected: [{ command: { kind: 'rerun_from_node' } }] });
  });

  async function diagnostics(chief: ChiefSupervisor, context: ChiefRuntimeOptions['context']) {
    const artifacts = new InMemoryArtifactStore();
    const runtime = createWorkflowRuntime({ artifacts, chief, chiefOptions: { context },
      executor: { async executeAgent() { return { status: 'COMPLETED', artifacts: {
        report: { content: 'r'.repeat(100) }, secret: { content: 'private' },
      } }; }, executeScript: unused },
    });
    const definition = createWorkflowBuilder('host-diagnostics').setChief({ triggers: [] })
      .addAgent({ id: 'writer', name: 'Writer', role: 'writer', goal: 'Write', outputs: [
        { name: 'report', type: 'artifact', required: true }, { name: 'secret', type: 'artifact', required: true },
      ] }).buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    return { runtime, done };
  }

  it('filters diagnostic artifacts and enforces explicit page and cumulative byte settings', async () => {
    let context!: NonNullable<ChiefReviewInput['context']>;
    const includeArtifact = vi.fn<NonNullable<NonNullable<ChiefRuntimeOptions['context']>['includeArtifact']>>(async ({ artifact }) => artifact.portName === 'report');
    const { runtime, done } = await diagnostics({ async review(input) {
      context = input.context!;
      const id = context.manifest.authorizedArtifactIds[0];
      await context.artifactReader.readPage(id, { maxBytes: 100 });
      await context.artifactReader.readPage(id, { offsetBytes: 10, maxBytes: 100 });
      return { rationale: 'Read within host quota', commands: [] };
    } }, { pageReadBytes: 10, stageReadQuotaBytes: 14, includeArtifact });
    const answered = await ask(runtime, done.runId);
    expect(includeArtifact).toHaveBeenCalledTimes(2);
    expect(includeArtifact.mock.calls[0][0]).toMatchObject({ runId: done.runId, source: { scopeKey: '$root', nodeId: 'writer' } });
    expect(context.manifest.entries).toHaveLength(1);
    expect(context.manifest.entries[0].sourcePort).toBe('report');
    expect(context.artifactReader.getReceipts().map(receipt => receipt.readBytes)).toEqual([10, 4]);
    expect(context.artifactReader.getRemainingQuotaBytes()).toBe(0);
    await expect(context.artifactReader.readPage(context.manifest.authorizedArtifactIds[0])).rejects.toBeInstanceOf(ArtifactQuotaExceededError);
    await expect(context.artifactReader.readPage(done.scopes.$root!.nodes.writer!.outputs.secret!.artifactId!)).rejects.toThrow('not authorized');
    expect(answered.manifests[context.manifest.manifestId]).toMatchObject({ pageReadBytes: 10, stageReadQuotaBytes: 14 });
    expect(answered.readReceipts.map(receipt => receipt.readBytes)).toEqual([10, 4]);
  });

  it('disables diagnostic artifact access without disabling chief replies', async () => {
    let context!: NonNullable<ChiefReviewInput['context']>;
    const includeArtifact = vi.fn(() => true);
    const { runtime, done } = await diagnostics({ async review(input) {
      context = input.context!;
      return { rationale: 'Explain using run state', reply: 'Ready', commands: [] };
    } }, { enabled: false, includeArtifact });
    const answered = await ask(runtime, done.runId);
    expect(context.manifest.entries).toEqual([]);
    expect(includeArtifact).not.toHaveBeenCalled();
    await expect(context.artifactReader.readPage(done.scopes.$root!.nodes.writer!.outputs.report!.artifactId!)).rejects.toThrow('not authorized');
    expect(answered.events.find(e => e.type === 'chief.intervened')).toMatchObject({ reply: 'Ready' });
  });

  it('fails the review closed when the host artifact filter fails', async () => {
    const review = vi.fn<ChiefSupervisor['review']>();
    const { runtime, done } = await diagnostics({ review }, { includeArtifact: async () => { throw new Error('host access check unavailable'); } });
    const answered = await ask(runtime, done.runId);
    expect(review).not.toHaveBeenCalled();
    expect(answered.events.find(e => e.type === 'chief.intervened')).toMatchObject({ applied: [], rationale: expect.stringContaining('host access check unavailable') });
  });

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid read settings (%s) at construction', value => {
    for (const key of ['pageReadBytes', 'stageReadQuotaBytes'] as const) {
      expect(() => createWorkflowRuntime({ executor: { executeAgent: unused, executeScript: unused }, chiefOptions: { context: { [key]: value } } })).toThrow(`chiefOptions.context.${key}`);
    }
  });
});
