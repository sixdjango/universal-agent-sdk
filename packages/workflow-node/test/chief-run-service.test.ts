import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, type AgentExecutionRequest, type AgentExecutionResult, type ChiefSupervisor } from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { hostSchema, openWorkflowDatabase, RandomIdGenerator, resolveWorkflowStoragePaths, RunService, SqliteArtifactStore, SqliteRuntimeStore, WorkflowHost } from '../src/index';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const definition = () => createWorkflowBuilder('chief-driver').setChief({ triggers: [] })
  .addWorkflowOutput({ name: 'result', type: 'string', required: true })
  .addAgent({ id: 'author', name: 'Author', role: 'author', goal: 'Produce', outputs: [{ name: 'draft', type: 'string', required: true }] })
  .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Verify', producesAssessment: true,
    inputs: [{ name: 'draft', type: 'string', required: true }], outputs: [{ name: 'result', type: 'string', required: true }] })
  .connectData({ fromNodeId: 'author', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
  .connectData({ fromNodeId: 'review', fromPort: 'result', toNodeId: '$output', toPort: 'result' }).buildDefinition();

describe('chief uses the SDK run driver', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

  function open(chief: ChiefSupervisor, executeAgent: (request: AgentExecutionRequest) => Promise<AgentExecutionResult>) {
    const home = mkdtempSync(join(tmpdir(), 'ua-chief-driver-'));
    const paths = resolveWorkflowStoragePaths(home);
    const db = openWorkflowDatabase(paths.databasePath);
    cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => db.$client.close());
    const host = (ownerId: string) => {
      const runtime = createWorkflowRuntime({
        store: new SqliteRuntimeStore({ db }), artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
        idGenerator: new RandomIdGenerator(), chief,
        executor: { executeAgent, async executeScript() { throw new Error('unused'); } },
      });
      const service = new RunService({ runtime, db, ownerId, leaseTtlMs: 60, logger: { error() {} } });
      cleanup.push(() => service.close());
      return service;
    };
    return { db, a: host('A'), b: host('B') };
  }
  async function settled(service: RunService, runId: string) {
    for (let i = 0; i < 300; i++) {
      if (!service.isActive(runId)) return service.get(runId);
      await sleep(10);
    }
    throw new Error('run did not settle');
  }

  it('answers a message during execution at once, holding its rerun until execution settles under the same lease', async () => {
    const started = deferred();
    const release = deferred();
    const answered = deferred();
    let authorCalls = 0;
    let reviewCalls = 0;
    let chiefCalls = 0;
    const { a, b } = open({ async review(input) {
      chiefCalls++;
      // Asked while the author is still working, and answers right away.
      expect(input.state.status).toBe('RUNNING');
      expect(authorCalls).toBe(1);
      expect(input.state.scopes.$root!.nodes.author!.status).not.toBe('SUCCEEDED');
      answered.resolve();
      return { rationale: 'Repair the draft', reply: 'I will have the author redo it once it finishes', commands: [
        { kind: 'inject_guidance', scopeKey: '$root', nodeId: 'author', text: 'Fix the calculation' },
        { kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'author' },
      ] };
    } }, async req => {
      if (req.node.id === 'author') {
        authorCalls++;
        if (authorCalls === 1) { started.resolve(); await release.promise; }
        else expect(req.renderedPrompt).toContain('Fix the calculation');
        return { status: 'COMPLETED', outputs: { draft: `v${authorCalls}` } };
      }
      reviewCalls++;
      return { status: 'COMPLETED', outputs: { result: req.inputs.draft }, assessment: { verdict: 'PASS', summary: 'Verified' } };
    });
    // Ensure a failed assertion cannot leave the test's worker running forever.
    cleanup.push(() => release.resolve());
    const { runId } = await a.start(definition(), {});
    await started.promise;
    const { messageId } = await a.messageChief({ runId, text: 'Repair', authorId: 'owner' });
    expect((await a.get(runId)).events).toContainEqual(expect.objectContaining({ type: 'chief.user_message', messageId }));
    await expect(b.messageChief({ runId, text: 'Race a second repair', authorId: 'owner' })).rejects.toMatchObject({ code: 'conflict' });
    await answered.promise;
    // The reply and its guidance land while the author is still working; the rerun waits.
    for (let i = 0; i < 100 && !(await a.get(runId)).events.some(e => e.type === 'chief.intervened'); i++) await sleep(5);
    const midway = await a.get(runId);
    expect(midway.scopes.$root!.nodes.author!.status).not.toBe('SUCCEEDED');
    expect(midway.events.filter(e => e.type === 'chief.intervened')).toHaveLength(1);
    expect(authorCalls).toBe(1);
    release.resolve();
    const done = await settled(a, runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.result).toBe('v2');
    expect([authorCalls, reviewCalls, chiefCalls]).toEqual([2, 2, 1]);
    expect(Object.values(done.assessments).map(a => a.stale)).toEqual([true, false]);
    expect(done.events.filter(e => e.type === 'chief.user_message')).toHaveLength(1);
    const replies = done.events.filter(e => e.type === 'chief.intervened');
    expect(replies.map(e => 'inReplyTo' in e && e.inReplyTo)).toEqual([messageId, messageId]);
    expect(a.leaseHolder(runId)).toBeNull();
  });

  it('stops a run on request: the executing step is aborted and the driver lets go of the run', async () => {
    const started = deferred();
    let aborted = false;
    const { a } = open({ async review() { return { rationale: '', commands: [] }; } }, async req => {
      started.resolve();
      await new Promise<void>(resolve => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      aborted = req.signal?.aborted ?? false;
      return { status: 'COMPLETED', outputs: { draft: 'late' } };
    });
    const { runId } = await a.start(definition(), {});
    await started.promise;
    expect((await a.cancel(runId)).status).toBe('CANCELLED');
    const done = await settled(a, runId);
    expect(aborted).toBe(true);
    expect(done.status).toBe('CANCELLED');
    expect(done.scopes.$root!.nodes.author!.status).not.toBe('SUCCEEDED');
    expect(a.leaseHolder(runId)).toBeNull();
    expect((await a.cancel(runId)).revision).toBe(done.revision);
  });

  it('holds the lease while an idle run’s chief thinks and rejects its late decision after lease loss', async () => {
    const thinking = deferred();
    const { db, a, b } = open({ async review(input) {
      thinking.resolve();
      await new Promise<void>(resolve => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      // A custom supervisor may ignore cancellation and still return a decision.
      return { rationale: 'late repair', commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'author' }] };
    } }, async req => req.node.id === 'author'
      ? { status: 'COMPLETED', outputs: { draft: 'original' } }
      : { status: 'COMPLETED', outputs: { result: req.inputs.draft }, assessment: { verdict: 'PASS', summary: 'Verified' } });
    const { runId } = await a.start(definition(), {});
    await settled(a, runId);
    await a.messageChief({ runId, text: 'Repair', authorId: 'owner' });
    await thinking.promise;
    expect(a.leaseHolder(runId)).toBe('A');
    expect(a.isChiefAnswering(runId)).toBe(true);
    await expect(b.messageChief({ runId, text: 'Another repair', authorId: 'owner' })).rejects.toMatchObject({ code: 'conflict' });
    db.update(hostSchema.runLeases).set({ ownerId: 'B' }).run();
    const done = await settled(a, runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.result).toBe('original');
    expect(done.events.filter(e => e.type === 'chief.intervened')).toHaveLength(0);
    expect(a.isChiefAnswering(runId)).toBe(false);
  });

  it('lets an embedding host defer execution after a chief reply and explicitly recover it later', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ua-chief-manual-'));
    const paths = resolveWorkflowStoragePaths(home);
    const db = openWorkflowDatabase(paths.databasePath);
    cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => db.$client.close());
    let authorCalls = 0;
    const runtime = createWorkflowRuntime({
      store: new SqliteRuntimeStore({ db }), artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
      chief: { async review() { return { rationale: 'Repair', commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'author' }] }; } },
      executor: { async executeAgent(req) { return req.node.id === 'author'
        ? { status: 'COMPLETED', outputs: { draft: `v${++authorCalls}` } }
        : { status: 'COMPLETED', outputs: { result: req.inputs.draft }, assessment: { verdict: 'PASS', summary: 'Verified' } };
      }, async executeScript() { throw new Error('unused'); } },
    });
    const host = await WorkflowHost.open({ runtime, db, workdir: home, worktreesDir: paths.worktreesDir,
      runOptions: { ownerId: 'embedded-host', leaseTtlMs: 60, autoContinueAfterChief: false },
    });
    cleanup.push(() => host.close());
    expect(host.runs.ownerId).toBe('embedded-host');
    const { runId } = await host.runs.start(definition(), {});
    await settled(host.runs, runId);
    const { messageId } = await host.runs.messageChief({ runId, text: 'Repair', authorId: 'host' });
    const pending = await settled(host.runs, runId);
    expect(pending.status).toBe('RUNNING');
    expect(authorCalls).toBe(1);
    expect(host.runs.leaseHolder(runId)).toBeNull();
    expect(pending.events).toContainEqual(expect.objectContaining({ type: 'chief.intervened', inReplyTo: messageId }));
    expect(host.runs.resumeInterrupted({ watch: false })).toEqual([runId]);
    const repaired = await settled(host.runs, runId);
    expect(repaired.status).toBe('SUCCEEDED');
    expect(repaired.outputs.result).toBe('v2');
    expect(authorCalls).toBe(2);
  });
});
