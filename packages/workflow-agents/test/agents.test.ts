import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  type AgentExecutionRequest,
  type AgentExecutionResult,
  createWorkflowRuntime,
  foldRunLog,
} from '@universal-agent/workflow-runtime';
import {
  openWorkflowDatabase,
  resolveWorkflowStoragePaths,
  SqliteArtifactStore,
  SqliteRuntimeStore,
  type WorkflowDatabase,
  workflowSchema,
} from '@universal-agent/workflow-node';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  AgentChiefSupervisor,
  createAgentWorkflowRuntime,
  parseChiefDecision,
  SqliteAgentRegistry,
} from '../src/index';

describe('@universal-agent/workflow-agents', () => {
  const tempDirs: string[] = [];
  const dbs: WorkflowDatabase[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.$client.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function openSharedDb() {
    const home = mkdtempSync(join(tmpdir(), 'ua-wf-agents-'));
    tempDirs.push(home);
    const paths = resolveWorkflowStoragePaths(home);
    const db = openWorkflowDatabase(paths.databasePath);
    dbs.push(db);
    return { db, paths };
  }

  it('versions agent profiles immutably in the shared workflow database', async () => {
    const { db, paths } = openSharedDb();
    const registry = new SqliteAgentRegistry({ db });

    const v1 = registry.register({ id: 'reviewer', name: 'Reviewer', charter: 'Finds bugs.' });
    expect(v1.created).toBe(true);
    expect(registry.register({ id: 'reviewer', name: 'Reviewer', charter: 'Finds bugs.' }).created).toBe(false);
    expect(() =>
      registry.register({ id: 'reviewer', name: 'Reviewer', charter: 'Changed silently.' })
    ).toThrow(/bump its version/);
    registry.register({ id: 'reviewer', version: '2', name: 'Reviewer', charter: 'Finds bugs and risks.' });

    expect((await registry.resolve('reviewer'))?.version).toBe('2');
    expect((await registry.resolve('reviewer@1'))?.charter).toBe('Finds bugs.');
    expect(await registry.resolve('reviewer@9')).toBeNull();
    expect(await registry.resolve('nobody')).toBeNull();
    expect(registry.listVersions('reviewer').map((v) => v.version)).toEqual(['1', '2']);
    expect(registry.listAgents()).toEqual([{ agentId: 'reviewer', name: 'Reviewer', latestVersion: '2' }]);

    // Reopening runs both packages' migrations again without conflict.
    const reopened = openWorkflowDatabase(paths.databasePath);
    dbs.push(reopened);
    expect((await new SqliteAgentRegistry({ db: reopened }).resolve('reviewer@1'))?.version).toBe('1');
  });

  it('runs an LLM chief that swaps agents, with interventions and attempt agents queryable in SQLite', async () => {
    const { db, paths } = openSharedDb();
    const registry = new SqliteAgentRegistry({ db });
    registry.register({ id: 'junior', name: 'Junior', charter: 'Learning.' });
    registry.register({ id: 'senior', name: 'Senior', charter: 'Experienced.' });
    registry.register({ id: 'lead', name: 'Lead', charter: 'Keeps runs on track.' });

    let chiefPrompt = '';
    const executeAgent = async (req: AgentExecutionRequest): Promise<AgentExecutionResult> => {
      if (req.node.id === '$chief') {
        chiefPrompt = req.renderedPrompt;
        expect(req.node.writeScopes).toEqual([]);
        return {
          status: 'COMPLETED',
          outputs: {
            decision:
              'Thinking...\n```ua-chief-decision\n{"rationale":"swap","commands":[{"kind":"swap_agent","nodeId":"worker","agentRef":"senior"},{"kind":"retry_node","scopeKey":"$root","nodeId":"worker"}]}\n```',
          },
        };
      }
      if (req.agent?.agentId === 'junior') throw new Error('junior got stuck');
      return { status: 'COMPLETED', outputs: { result: `by ${req.agent?.agentId}` } };
    };

    const runtime = createWorkflowRuntime({
      store: new SqliteRuntimeStore({ db }),
      artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
      agentRegistry: registry,
      chief: new AgentChiefSupervisor(),
      executor: {
        executeAgent,
        async executeScript() {
          throw new Error('unused');
        },
      },
    });

    const definition = createWorkflowBuilder('chief-sqlite')
      .addWorkflowOutput({ name: 'result', type: 'string', required: true })
      .addAgent({
        id: 'worker',
        name: 'Worker',
        role: 'worker',
        agentRef: 'junior',
        goal: 'Do the task',
        outputs: [{ name: 'result', type: 'string', required: true }],
      })
      .connectData({ fromNodeId: 'worker', fromPort: 'result', toNodeId: '$output', toPort: 'result' })
      .setChief({ agentRef: 'lead' })
      .buildDefinition();

    const started = await runtime.start({ runId: 'run-chief', definition });
    const done = await runtime.runUntilSettled(started.runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.result).toBe('by senior');
    expect(chiefPrompt).toContain('# You are Lead, chief agent of this workflow run');
    expect(chiefPrompt).toContain('junior got stuck');
    expect(chiefPrompt).toContain('never WHAT counts as done');

    const interventions = db
      .select()
      .from(workflowSchema.chiefInterventions)
      .where(eq(workflowSchema.chiefInterventions.runId, 'run-chief'))
      .all();
    expect(interventions).toHaveLength(1);
    expect(interventions[0]).toMatchObject({ trigger: 'node.failed', nodeId: 'worker', rationale: 'swap' });

    const attempts = db
      .select({ agentId: workflowSchema.nodeAttempts.agentId, status: workflowSchema.nodeAttempts.status })
      .from(workflowSchema.nodeAttempts)
      .where(eq(workflowSchema.nodeAttempts.runId, 'run-chief'))
      .all();
    expect(attempts).toEqual(
      expect.arrayContaining([
        { agentId: 'junior', status: 'FAILED' },
        { agentId: 'senior', status: 'SUCCEEDED' },
      ])
    );
    expect(foldRunLog(await runtime.store.readLog('run-chief'))).toEqual(done);
  });

  it('turns unparseable or out-of-vocabulary chief replies into no-op decisions', () => {
    expect(parseChiefDecision('no json here').commands).toEqual([]);
    // There is no command that can change verdicts or acceptance criteria.
    expect(parseChiefDecision({ commands: [{ kind: 'set_verdict', verdict: 'PASS' }] }).commands).toEqual([]);
    expect(
      parseChiefDecision('```json\n{"rationale":"r","commands":[{"kind":"report","summary":"ok"}]}\n```')
    ).toEqual({ rationale: 'r', commands: [{ kind: 'report', summary: 'ok' }] });
  });

  it('createAgentWorkflowRuntime keeps runs and agents in the workflow-node database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ua-wf-agents-home-'));
    tempDirs.push(home);
    const agents = [{ id: 'planner', name: 'Planner', charter: 'Breaks work down.' }];

    const first = createAgentWorkflowRuntime({ workdir: home, homeDir: home, agents });
    dbs.push(first.db);
    expect(existsSync(resolveWorkflowStoragePaths(home).databasePath)).toBe(true);
    expect(first.runtime.agentRegistry).toBe(first.registry);

    // A second host process registering the same profiles is a no-op.
    const second = createAgentWorkflowRuntime({ workdir: home, homeDir: home, agents, chief: false });
    dbs.push(second.db);
    expect(second.registry.listVersions('planner')).toHaveLength(1);
    expect((await second.registry.resolve('planner'))?.charter).toBe('Breaks work down.');
  });

  it('preserves host chief controls through the Agents and Node factories with the default supervisor', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ua-embedded-chief-'));
    tempDirs.push(home);
    const requests: AgentExecutionRequest[] = [];
    const { runtime, db } = createAgentWorkflowRuntime({ workdir: home, homeDir: home,
      agents: [{ id: 'embedded', name: 'Embedded', charter: 'Follow host rules', runtime: { adapter: 'host-test' } }],
      adapters: { 'host-test': { async executeAgent(request) {
        requests.push(request);
        return request.node.id === '$chief'
          ? { status: 'COMPLETED', outputs: { decision: { rationale: 'Check host controls', commands: [
            { kind: 'report', summary: 'Reviewed' }, { kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'worker' },
          ] } } }
          : { status: 'COMPLETED', artifacts: { report: { content: 'host report' } } };
      } } },
      chiefOptions: { allowedCommands: ['report'], context: { pageReadBytes: 32, stageReadQuotaBytes: 40 } },
    });
    dbs.push(db);
    const definition = createWorkflowBuilder('embedded-chief-controls').setChief({ agentRef: 'embedded', triggers: [] })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', agentRef: 'embedded', goal: 'Write', outputs: [{ name: 'report', type: 'artifact', required: true }] })
      .buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const { messageId } = await runtime.postChiefMessage({ runId: done.runId, authorId: 'host', text: 'Inspect' });
    const answered = await runtime.answerChiefMessage({ runId: done.runId, messageId });
    const chief = requests.find(request => request.node.id === '$chief')!;
    expect(chief.manifest).toMatchObject({ pageReadBytes: 32, stageReadQuotaBytes: 40 });
    expect(chief.manifest.authorizedArtifactIds).toHaveLength(1);
    const commandsSection = chief.renderedPrompt.split('## Allowed Commands')[1].split('## Rules')[0];
    expect(commandsSection).toContain('"kind":"report"');
    expect(commandsSection).not.toContain('"kind":"rerun_from_node"');
    expect(answered.events.find(event => event.type === 'chief.intervened')).toMatchObject({
      applied: [{ kind: 'report' }], rejected: [{ command: { kind: 'rerun_from_node' }, reason: expect.stringContaining('disabled by the host') }],
    });
    expect(answered.status).toBe('SUCCEEDED');
  });
});
