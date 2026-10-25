import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  CoordinatorFenceError,
  createWorkflowRuntime,
  DeterministicClock,
  foldRunLog,
  RevisionConflictError,
  SequentialIdGenerator,
} from '@universal-agent/workflow-runtime';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openWorkflowDatabase,
  resolveUniversalAgentHome,
  resolveWorkflowStoragePaths,
  SqliteArtifactStore,
  SqliteRuntimeStore,
  type WorkflowDatabase,
  workflowSchema,
} from '../src/index';

function buildTwoStepFlow() {
  return createWorkflowBuilder('sqlite-two-step', 'SQLite two step')
    .addWorkflowInput({ name: 'topic', type: 'string', required: false })
    .addWorkflowOutput({ name: 'summary', type: 'string', required: true })
    .addAgent({
      id: 'draft',
      name: 'Draft',
      role: 'author',
      goal: 'Draft notes',
      inputs: [{ name: 'topic', type: 'string', required: false }],
      outputs: [{ name: 'notes', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'summarize',
      name: 'Summarize',
      role: 'reviewer',
      goal: 'Summarize notes',
      inputs: [{ name: 'notes', type: 'artifact', required: true }],
      outputs: [{ name: 'summary', type: 'string', required: true }],
    })
    .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'draft', toPort: 'topic', required: false })
    .connectData({ fromNodeId: 'draft', fromPort: 'notes', toNodeId: 'summarize', toPort: 'notes', withControl: true })
    .connectData({ fromNodeId: 'summarize', fromPort: 'summary', toNodeId: '$output', toPort: 'summary' })
    .buildDefinition();
}

describe('@universal-agent/workflow-node: SQLite RuntimeStore & ArtifactStore', () => {
  const tempDirs: string[] = [];
  const openDbs: WorkflowDatabase[] = [];

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.$client.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function openTempDb(): { db: WorkflowDatabase; paths: ReturnType<typeof resolveWorkflowStoragePaths> } {
    const home = mkdtempSync(join(tmpdir(), 'ua-wf-sqlite-'));
    tempDirs.push(home);
    const paths = resolveWorkflowStoragePaths(home);
    const db = openWorkflowDatabase(paths.databasePath);
    openDbs.push(db);
    return { db, paths };
  }

  it('resolves the home dir from options, then UNIVERSAL_AGENT_HOME, then ~/.universal-agent', () => {
    expect(resolveUniversalAgentHome({ homeDir: '/x', env: { UNIVERSAL_AGENT_HOME: '/y' } })).toBe('/x');
    expect(resolveUniversalAgentHome({ env: { UNIVERSAL_AGENT_HOME: '/y' } })).toBe('/y');
    expect(resolveUniversalAgentHome({ env: { UNIVERSAL_AGENT_HOME: '  ' } })).toBe(
      join(homedir(), '.universal-agent')
    );
    expect(resolveWorkflowStoragePaths('/y').databasePath).toBe(join('/y', 'workflow', 'workflow.db'));
  });

  it('persists a run as an append-only log whose fold equals the live state, with projections', async () => {
    const { db, paths } = openTempDb();
    const clock = new DeterministicClock();
    const store = new SqliteRuntimeStore({ db, clock, snapshotInterval: 3 });
    const artifacts = new SqliteArtifactStore({ db, blobsDir: paths.blobsDir, clock });
    const runtime = createWorkflowRuntime({
      store,
      artifacts,
      clock,
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'draft') {
            return {
              status: 'COMPLETED',
              artifacts: { notes: { content: `# Notes\n${String(req.inputs.topic)}` } },
            };
          }
          return { status: 'COMPLETED', outputs: { summary: 'short summary' } };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });

    const started = await runtime.start({
      runId: 'run-sqlite',
      definition: buildTwoStepFlow(),
      inputs: { topic: 'sqlite' },
    });
    const done = await runtime.runUntilSettled(started.runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.summary).toBe('short summary');

    // A fresh store (cold cache) rebuilds the same state from snapshot + log tail
    const coldStore = new SqliteRuntimeStore({ db });
    expect(await coldStore.getRun('run-sqlite')).toEqual(done);
    const log = await coldStore.readLog('run-sqlite');
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(foldRunLog(log)).toEqual(done);
    const snapshot = db.select().from(workflowSchema.runSnapshots).get();
    expect(snapshot?.seq).toBeGreaterThan(1);

    // Contract + projections
    const nodes = db.select().from(workflowSchema.definitionNodes).all();
    expect(nodes.map((n) => n.nodeId).sort()).toEqual(['draft', 'summarize']);
    const states = db
      .select()
      .from(workflowSchema.nodeStates)
      .where(eq(workflowSchema.nodeStates.runId, 'run-sqlite'))
      .all();
    expect(states.every((s) => s.status === 'SUCCEEDED')).toBe(true);
    const delivery = db
      .select()
      .from(workflowSchema.edgeDeliveries)
      .where(eq(workflowSchema.edgeDeliveries.toNodeId, 'summarize'))
      .get();
    expect(delivery?.fromNodeId).toBe('draft');
    expect(delivery?.artifactId).toBe(done.scopes.$root!.nodes.draft!.outputs.notes!.artifactId);
  });

  it('records a loop\'s way back, with its round limit, among the contract edges', async () => {
    const { db } = openTempDb();
    const definition = createWorkflowBuilder('sqlite-loop', 'SQLite loop')
      .addAgent({ id: 'draft', name: 'Draft', role: 'author', goal: 'Draft', inputs: [], outputs: [] })
      .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Review', producesAssessment: true, inputs: [], outputs: [] })
      .connectControl('draft', 'review')
      .buildDefinition();
    definition.graph.controlEdges.push({
      id: 'back',
      fromNodeId: 'review',
      toNodeId: 'draft',
      when: { kind: 'verdict_is', verdict: 'NEEDS_FIX' },
      loop: { maxRounds: 4, onExhausted: 'gate' },
    });
    const runtime = createWorkflowRuntime({
      store: new SqliteRuntimeStore({ db }),
      executor: {
        async executeAgent() {
          return { status: 'COMPLETED', outputs: {} };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    await runtime.start({ runId: 'run-loop', definition, inputs: {} });

    const edges = db.select().from(workflowSchema.definitionEdges).all();
    expect(edges.find((e) => e.edgeId === 'back')).toMatchObject({
      edgeKind: 'control',
      condition: { kind: 'verdict_is', verdict: 'NEEDS_FIX' },
      loop: { maxRounds: 4, onExhausted: 'gate' },
    });
    expect(edges.find((e) => e.edgeId === 'ctrl_draft_to_review')?.loop).toBeNull();
  });

  it('fences stale coordinators and stale seqs across independent connections', async () => {
    const { db, paths } = openTempDb();
    const otherProcessDb = openWorkflowDatabase(paths.databasePath);
    openDbs.push(otherProcessDb);
    const storeA = new SqliteRuntimeStore({ db });
    const storeB = new SqliteRuntimeStore({ db: otherProcessDb });

    const runtime = createWorkflowRuntime({
      store: storeA,
      executor: {
        async executeAgent() {
          return { status: 'COMPLETED', outputs: {} };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const started = await runtime.start({ runId: 'run-fence', definition: buildTwoStepFlow() });

    const leased = await storeB.acquireCoordinatorEpoch('run-fence');
    const patch = [{ kind: 'run.patched', status: 'RUNNING' }] as const;

    // storeA's cached view is stale: old epoch must be fenced out
    await expect(
      storeA.appendMutations({
        runId: 'run-fence',
        expectedSeq: leased.state.revision,
        coordinatorEpoch: started.coordinatorEpoch,
        mutations: patch,
      })
    ).rejects.toBeInstanceOf(CoordinatorFenceError);

    await expect(
      storeA.appendMutations({
        runId: 'run-fence',
        expectedSeq: started.revision,
        coordinatorEpoch: leased.epoch,
        mutations: patch,
      })
    ).rejects.toBeInstanceOf(RevisionConflictError);

    const appended = await storeA.appendMutations({
      runId: 'run-fence',
      expectedSeq: leased.state.revision,
      coordinatorEpoch: leased.epoch,
      mutations: patch,
    });
    expect(appended.revision).toBe(leased.state.revision + 1);
    expect(await storeB.getRun('run-fence')).toEqual(appended);
  });

  it('deduplicates artifact bytes by sha256 and spills large blobs to files', async () => {
    const { db, paths } = openTempDb();
    const store = new SqliteArtifactStore({ db, blobsDir: paths.blobsDir, inlineBlobMaxBytes: 16 });
    const base = {
      producerRunId: 'r',
      producerNodeId: 'n',
      producerAttemptId: 'a',
      portName: 'p',
    };

    const small1 = await store.put({ ...base, content: 'tiny' });
    const small2 = await store.put({ ...base, content: 'tiny' });
    expect(small1.artifactId).not.toBe(small2.artifactId);
    expect(small1.sha256).toBe(small2.sha256);
    expect(db.select().from(workflowSchema.artifactBlobs).all()).toHaveLength(1);

    const large = await store.put({ ...base, content: '# Intro\nhello 世界\n# Next\nmore text here' });
    const meta = await store.getMeta(large.artifactId);
    expect(meta?.uri?.startsWith('file://')).toBe(true);
    expect(existsSync(join(paths.blobsDir, large.sha256.slice(0, 2), large.sha256))).toBe(true);
    expect(meta?.sections).toEqual(['Intro', 'Next']);

    const section = await store.readSlice(large.artifactId, { section: 'Intro' });
    expect(section.content).toBe('# Intro\nhello 世界');
    expect(await store.readText(small1.artifactId)).toBe('tiny');
  });
});
