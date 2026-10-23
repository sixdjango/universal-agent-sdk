import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime } from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hostSchema,
  openWorkflowDatabase,
  RandomIdGenerator,
  resolveWorkflowStoragePaths,
  RunService,
  SqliteArtifactStore,
  SqliteRuntimeStore,
  type WorkflowDatabase,
  WorkflowHostError,
} from '../src/index';

const definition = createWorkflowBuilder('slow').addAgent({ id: 'work', name: 'Work', role: 'author', goal: 'x' }).buildDefinition();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('run leases across processes', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  function setup() {
    const home = mkdtempSync(join(tmpdir(), 'ua-lease-'));
    const paths = resolveWorkflowStoragePaths(home);
    const db = openWorkflowDatabase(paths.databasePath);
    cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => db.$client.close());
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    /** One "process": its own runtime (store cache, executor) and run service on the shared file. */
    const process = (name: string, leaseTtlMs = 200) => {
      const runtime = createWorkflowRuntime({
        store: new SqliteRuntimeStore({ db }),
        artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
        idGenerator: new RandomIdGenerator(),
        executor: {
          async executeAgent(req) {
            calls.push(name);
            await Promise.race([gate, new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))))]);
            return { status: 'COMPLETED' };
          },
          async executeScript() {
            throw new Error('unused');
          },
        },
      });
      const service = new RunService({ runtime, db, ownerId: name, leaseTtlMs, logger: { error() {} } });
      cleanup.push(() => service.close());
      return { runtime, service };
    };
    return { db, process, calls, release: () => release() };
  }

  const settled = async (service: RunService, runId: string) => {
    for (let i = 0; i < 300; i++) {
      const run = await service.get(runId);
      if (run.status !== 'RUNNING' && !service.isActive(runId)) return run;
      await sleep(10);
    }
    throw new Error('never settled');
  };
  const leases = (db: WorkflowDatabase) => db.select().from(hostSchema.runLeases).all();

  it('leaves a run alone while another process drives it, then releases on completion', async () => {
    const { db, process, calls, release } = setup();
    const a = process('A');
    const b = process('B');
    const { runId } = await a.service.start(definition, {});
    await sleep(50);
    expect(a.service.leaseHolder(runId)).toBe('A');

    // B starting up must not take over a run A is actively driving, even past A's lease period.
    expect(b.service.resumeInterrupted({ watch: false })).toEqual([]);
    await sleep(400);
    expect(b.service.resumeInterrupted({ watch: false })).toEqual([]);
    expect(calls).toEqual(['A']);

    release();
    expect((await settled(a.service, runId)).status).toBe('SUCCEEDED');
    expect(leases(db)).toEqual([]);
  });

  it('takes over a run whose driver died once its lease expires', async () => {
    const { db, process, calls, release } = setup();
    const b = process('B');
    const a = process('A');
    const { runId } = await a.runtime.start({ definition });
    // A "crashed" mid-run: the run is RUNNING and A's lease is still live for a moment.
    db.insert(hostSchema.runLeases).values({ runId, ownerId: 'A', expiresAtMs: Date.now() + 300 }).run();

    expect(b.service.resumeInterrupted()).toEqual([]);
    await expect(
      (async () => b.service.rerunFromNode({ runId, nodeId: 'work' }))()
    ).rejects.toBeInstanceOf(WorkflowHostError);

    // The sweep keeps watching and picks the run up after the lease runs out.
    for (let i = 0; i < 100 && b.service.leaseHolder(runId) !== 'B'; i++) await sleep(20);
    expect(b.service.leaseHolder(runId)).toBe('B');
    release();
    expect((await settled(b.service, runId)).status).toBe('SUCCEEDED');
    expect(calls).toEqual(['B']);
  });

  it('stops a driver that lost its lease instead of running alongside the new owner', async () => {
    const { db, process } = setup();
    const a = process('A', 600);
    const { runId } = await a.service.start(definition, {});
    await sleep(50);
    // Simulate another process having taken over (e.g. A was suspended past its lease).
    db.update(hostSchema.runLeases).set({ ownerId: 'B' }).run();
    for (let i = 0; i < 300 && a.service.isActive(runId); i++) await sleep(20);
    expect(a.service.isActive(runId)).toBe(false);
  });
});
