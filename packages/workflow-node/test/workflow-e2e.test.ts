import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBoundedFixLoopFlow,
  createHumanDecisionGateFlow,
  createWorkflowBuilder,
} from '@universal-agent/workflow-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { foldRunLog } from '@universal-agent/workflow-runtime';
import { eq } from 'drizzle-orm';
import { createNodeWorkflowRuntime, createNodeConversationService, listWorkflowConversations, openWorkflowDatabase, workflowSchema } from '../src/index';

describe('@universal-agent/workflow-node: End-to-End Multi-Agent & Script Workflow Tests', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  function createMockAcpAgentScript(workdir: string): string {
    const scriptPath = join(workdir, 'mock-workflow-acp-agent.mjs');
    writeFileSync(
      scriptPath,
      `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const role = process.env.MOCK_AGENT_ROLE || 'worker';
const targetWorkdir = process.env.MOCK_TARGET_WORKDIR || process.cwd();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {}, resume: {}, fork: {} },
        },
      },
    });
    return;
  }

  if (msg.method === 'session/new' || msg.method === 'session/load') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'acp-' + role + '-' + Date.now(),
        configOptions: [],
      },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const promptBlocks = msg.params.prompt || [];
    const promptText = promptBlocks.map((b) => b.text || '').join('\\n');

    let replyText = '';

    if (role === 'author') {
      const isFixRound = promptText.includes('Prior Loop Round Feedback') || promptText.includes('Fix multiply');
      const code = isFixRound
        ? 'export function multiply(a, b) { return a * b; }\\n'
        : 'export function multiply(a, b) { return a + b; }\\n';
      writeFileSync(join(targetWorkdir, 'calculator.mjs'), code, 'utf8');

      const envelope = {
        artifacts: {
          candidate: {
            content: code,
            mediaType: 'text/javascript',
            summary: isFixRound ? 'Fixed multiply(a, b) using *' : 'Initial multiply(a, b)',
          },
        },
      };
      replyText = '\`\`\`ua-workflow-result\\n' + JSON.stringify(envelope, null, 2) + '\\n\`\`\`';
    } else if (role === 'reviewer') {
      const testPassed = promptText.includes('"exitCode": 0');
      const envelope = {
        assessment: {
          verdict: testPassed ? 'PASS' : 'NEEDS_FIX',
          summary: testPassed
            ? 'Independent review passed: unit tests exited with 0 and implementation is correct.'
            : 'Independent review failed: unit tests exited with non-zero code.',
          findings: testPassed
            ? []
            : [
                {
                  id: 'multiply-bug',
                  severity: 'critical',
                  message: 'Fix multiply to use a * b instead of a + b',
                  filePath: 'calculator.mjs',
                },
              ],
        },
      };
      replyText = '\`\`\`ua-workflow-result\\n' + JSON.stringify(envelope, null, 2) + '\\n\`\`\`';
    } else if (role === 'approver') {
      const envelope = { assessment: { verdict: 'PASS', summary: 'Integration verified.', findings: [] } };
      replyText = '\`\`\`ua-workflow-result\\n' + JSON.stringify(envelope, null, 2) + '\\n\`\`\`';
    } else if (role === 'lazy-reviewer') {
      // Plain prose, no structured block: must never be read as a PASS.
      replyText = 'Looks good to me, no NEEDS_FIX items and nothing would FAIL.';
    } else if (role === 'planner') {
      replyText = '# Migration Proposal\\n1. Back up database\\n2. Run schema migration';
    } else if (role === 'executor') {
      replyText = 'Executed approved migration plan successfully.';
    } else {
      replyText = 'Completed task for role ' + role;
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: replyText },
        },
      },
    });

    if (process.env.MOCK_DISCONNECT_AFTER_CHUNK === '1') {
      // Flush the partial message, then close the transport without a prompt response.
      process.stdout.end(() => process.exit(0));
      return;
    }

    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { stopReason: process.env.MOCK_STOP_REASON || 'end_turn' },
    });
    return;
  }

  if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`,
      'utf8'
    );
    return scriptPath;
  }

  it(
    'runs an end-to-end boundedFixLoop with real ACP Agent sessions, real Script verification, and the SQLite RuntimeStore',
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), 'ua-wf-e2e-work-'));
      const storageDir = mkdtempSync(join(tmpdir(), 'ua-wf-e2e-store-'));
      tempDirs.push(workdir, storageDir);

      const agentScript = createMockAcpAgentScript(workdir);

      // Write real verification test script that imports calculator.mjs and checks multiply(3, 4) === 12
      const testScriptPath = join(workdir, 'verify-calculator.mjs');
      writeFileSync(
        testScriptPath,
        `
import { multiply } from './calculator.mjs';
const actual = multiply(3, 4);
if (actual !== 12) {
  console.error('Test failed: expected multiply(3, 4) === 12, got ' + actual);
  process.exit(1);
}
console.log('Test passed: multiply(3, 4) === 12');
process.exit(0);
`,
        'utf8'
      );

      const flow = createBoundedFixLoopFlow({
        id: 'e2e-calc-fix-loop',
        maxRounds: 3,
        authorGoal: 'Implement multiply(a, b) in calculator.mjs',
        acceptanceCriteria: ['multiply(3, 4) returns 12', 'verify-calculator.mjs exits with 0'],
        verifyScript: {
          command: process.execPath,
          args: [testScriptPath],
        },
      });

      const runtime = createNodeWorkflowRuntime({
        workdir,
        homeDir: storageDir,
        roleBindings: {
          author: {
            target: {
              cliType: 'custom',
              agentType: 'mock-author-acp',
              command: process.execPath,
              args: [agentScript],
            },
            env: {
              MOCK_AGENT_ROLE: 'author',
              MOCK_TARGET_WORKDIR: workdir,
            },
          },
          reviewer: {
            target: {
              cliType: 'custom',
              agentType: 'mock-reviewer-acp',
              command: process.execPath,
              args: [agentScript],
            },
            env: {
              MOCK_AGENT_ROLE: 'reviewer',
              MOCK_TARGET_WORKDIR: workdir,
            },
          },
        },
      });

      const initial = await runtime.start({
        runId: 'run-e2e-fixloop',
        definition: flow,
        inputs: {
          specification: 'Create calculator.mjs exporting multiply(a, b)',
        },
      });

      const finalState = await runtime.runUntilSettled(initial.runId);

      // 1. Workflow must succeed after Round 0 (fail) -> Round 1 (fix & pass)!
      expect(finalState.status).toBe('SUCCEEDED');
      expect(finalState.scopes['$root/fix_loop:round_0']?.status).toBe('SUCCEEDED');
      expect(finalState.scopes['$root/fix_loop:round_1']?.status).toBe('SUCCEEDED');

      // 2. Verify calculator.mjs on disk was updated by Round 1 to `a * b`
      const finalCalcCode = readFileSync(join(workdir, 'calculator.mjs'), 'utf8');
      expect(finalCalcCode).toContain('a * b');

      // 3. Verify the SQLite run log and projections under <homeDir>/workflow/workflow.db
      const databasePath = join(storageDir, 'workflow', 'workflow.db');
      expect(existsSync(databasePath)).toBe(true);

      const log = await runtime.store.readLog('run-e2e-fixloop');
      expect(foldRunLog(log)).toEqual(finalState);
      const eventLines = log.flatMap((entry) =>
        entry.mutation.kind === 'event.emitted' ? [entry.mutation.event] : []
      );
      expect(eventLines[0]?.type).toBe('run.started');
      expect(eventLines.some((e) => e.type === 'loop.round.advanced')).toBe(true);
      expect(eventLines[eventLines.length - 1]?.type).toBe('run.finished');

      const db = openWorkflowDatabase(databasePath);
      try {
        // A new reader can find native Flow transcripts without any live session or server.
        const conversations = createNodeConversationService({ db });
        const records = await listWorkflowConversations(conversations.store, { runId: initial.runId });
        expect(records).toHaveLength(4);
        for (const roundIndex of [0, 1]) {
          const round = await listWorkflowConversations(conversations.store, { runId: initial.runId, roundIndex });
          expect(round).toHaveLength(2);
          expect(round.every(record => record.source?.identifiers.scopeKey === `$root/fix_loop:round_${roundIndex}`)).toBe(true);
        }
        for (const record of records) {
          const [turn] = (await conversations.store.listTurns(record.id)).items;
          expect(turn.status).toBe('completed');
          expect(await conversations.getMessages(record.id, turn.id)).toContainEqual(expect.objectContaining({ role: 'assistant', kind: 'content' }));
        }
        const contractEdges = db
          .select()
          .from(workflowSchema.definitionEdges)
          .where(eq(workflowSchema.definitionEdges.definitionDigest, finalState.definitionDigest))
          .all();
        expect(contractEdges.some((e) => e.edgeKind === 'data')).toBe(true);
        expect(contractEdges.some((e) => e.scopePath === '$root/fix_loop')).toBe(true);

        const runRow = db
          .select()
          .from(workflowSchema.runs)
          .where(eq(workflowSchema.runs.runId, 'run-e2e-fixloop'))
          .get();
        expect(runRow?.status).toBe('SUCCEEDED');
        expect(runRow?.seq).toBe(finalState.revision);

        const deliveries = db
          .select()
          .from(workflowSchema.edgeDeliveries)
          .where(eq(workflowSchema.edgeDeliveries.runId, 'run-e2e-fixloop'))
          .all();
        expect(deliveries.some((d) => d.toNodeId === 'reviewer')).toBe(true);

        const producedArtifacts = db
          .select()
          .from(workflowSchema.artifacts)
          .where(eq(workflowSchema.artifacts.producerRunId, 'run-e2e-fixloop'))
          .all();
        expect(producedArtifacts.length).toBeGreaterThan(0);
        const firstArtifact = producedArtifacts[0]!;
        expect(await runtime.artifacts.readText(firstArtifact.artifactId)).toBeTypeOf('string');
      } finally {
        db.$client.close();
      }

      // 4. Verify real ACP session receipts were recorded on agent attempts
      const attempts = Object.values(finalState.attempts);
      const agentAttempts = attempts.filter((a) => a.nodeId === 'author' || a.nodeId === 'reviewer');
      expect(agentAttempts.length).toBe(4); // 2 rounds * (author + reviewer)
      for (const att of agentAttempts) {
        expect(att.receipt?.acpSessionId).toMatch(/^acp-(author|reviewer)-/);
      }
    },
    30_000
  );

  it(
    'persists WAITING state at a GateNode, survives runtime reload, and resumes to SUCCEEDED after respond()',
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), 'ua-wf-gate-work-'));
      const storageDir = mkdtempSync(join(tmpdir(), 'ua-wf-gate-store-'));
      tempDirs.push(workdir, storageDir);

      const agentScript = createMockAcpAgentScript(workdir);
      const gateFlow = createHumanDecisionGateFlow({
        id: 'e2e-gate-resume',
        plannerGoal: 'Draft database migration plan',
        gatePrompt: 'Approve production database migration?',
        executorGoal: 'Execute approved database migration',
      });

      const makeRuntime = () =>
        createNodeWorkflowRuntime({
          workdir,
          homeDir: storageDir,
          roleBindings: {
            planner: {
              target: {
                cliType: 'custom',
                agentType: 'mock-planner-acp',
                command: process.execPath,
                args: [agentScript],
              },
              env: { MOCK_AGENT_ROLE: 'planner' },
            },
            executor: {
              target: {
                cliType: 'custom',
                agentType: 'mock-executor-acp',
                command: process.execPath,
                args: [agentScript],
              },
              env: { MOCK_AGENT_ROLE: 'executor' },
            },
          },
        });

      // Runtime Instance #1: starts run and pauses at GateNode
      const runtime1 = makeRuntime();
      const started = await runtime1.start({
        runId: 'run-gate-persist',
        definition: gateFlow,
        inputs: { request: 'Migrate users table' },
      });
      const paused = await runtime1.runUntilSettled(started.runId);
      expect(paused.status).toBe('WAITING');

      const pendingWait = Object.values(paused.waitRequests)[0]!;
      expect(pendingWait.status).toBe('PENDING');
      expect(pendingWait.prompt).toBe('Approve production database migration?');

      // Simulate process restart: a brand-new Runtime Instance #2 opens the same SQLite database
      const runtime2 = makeRuntime();
      const reloaded = await runtime2.store.getRun('run-gate-persist');
      expect(reloaded?.status).toBe('WAITING');

      // Respond with approval on Runtime Instance #2 -> automatically resumes and executes `executor` agent!
      const completed = await runtime2.respond({
        runId: 'run-gate-persist',
        requestId: pendingWait.requestId,
        answer: 'approve',
        responderId: 'admin@example.com',
      });

      expect(completed.status).toBe('SUCCEEDED');
      expect(completed.outputs.executionResult).toContain(
        'Executed approved migration plan successfully.'
      );
    },
    30_000
  );

  it(
    'performs partial subgraph invalidation and rerun (rerunFromNode) across real ACP Agent processes on disk without re-executing unrelated branches',
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), 'ua-wf-rerun-work-'));
      const storageDir = mkdtempSync(join(tmpdir(), 'ua-wf-rerun-store-'));
      tempDirs.push(workdir, storageDir);

      const agentScript = createMockAcpAgentScript(workdir);

      const diamondFlow = createWorkflowBuilder('e2e-diamond-rerun', 'Diamond Partial Rerun')
        .addWorkflowInput({ name: 'spec', type: 'string', required: true })
        .addWorkflowOutput({ name: 'reviewVerdict', type: 'assessment', required: true })
        .addAgent({
          id: 'backend_author',
          name: 'Backend Author',
          role: 'backend',
          goal: 'Implement backend API',
          inputs: [{ name: 'spec', type: 'string', required: true }],
          outputs: [{ name: 'backendCode', type: 'artifact', required: true }],
        })
        .addAgent({
          id: 'frontend_author',
          name: 'Frontend Author',
          role: 'frontend',
          goal: 'Implement frontend UI',
          inputs: [{ name: 'spec', type: 'string', required: true }],
          outputs: [{ name: 'frontendCode', type: 'artifact', required: true }],
        })
        .addAgent({
          id: 'integration_reviewer',
          name: 'Integration Reviewer',
          role: 'reviewer',
          goal: 'Audit backend and frontend integration',
          producesAssessment: true,
          inputs: [
            { name: 'backendCode', type: 'artifact', required: true },
            { name: 'frontendCode', type: 'artifact', required: true },
          ],
          outputs: [{ name: 'reviewVerdict', type: 'assessment', required: true }],
        })
        .connectData({
          fromNodeId: '$input',
          fromPort: 'spec',
          toNodeId: 'backend_author',
          toPort: 'spec',
        })
        .connectData({
          fromNodeId: '$input',
          fromPort: 'spec',
          toNodeId: 'frontend_author',
          toPort: 'spec',
        })
        .connectData({
          fromNodeId: 'backend_author',
          fromPort: 'backendCode',
          toNodeId: 'integration_reviewer',
          toPort: 'backendCode',
          withControl: true,
        })
        .connectData({
          fromNodeId: 'frontend_author',
          fromPort: 'frontendCode',
          toNodeId: 'integration_reviewer',
          toPort: 'frontendCode',
          withControl: true,
        })
        .connectData({
          fromNodeId: 'integration_reviewer',
          fromPort: 'reviewVerdict',
          toNodeId: '$output',
          toPort: 'reviewVerdict',
        })
        .buildDefinition();

      const makeRuntime = () =>
        createNodeWorkflowRuntime({
          workdir,
          homeDir: storageDir,
          defaultTarget: {
            target: {
              cliType: 'custom',
              agentType: 'mock-generic-acp',
              command: process.execPath,
              args: [agentScript],
            },
          },
          roleBindings: {
            // Reviewers must return a structured verdict; prose is no longer read as PASS.
            reviewer: {
              target: {
                cliType: 'custom',
                agentType: 'mock-approver-acp',
                command: process.execPath,
                args: [agentScript],
              },
              env: { MOCK_AGENT_ROLE: 'approver' },
            },
          },
        });

      const rt1 = makeRuntime();
      const started = await rt1.start({
        runId: 'run-diamond-e2e',
        definition: diamondFlow,
        inputs: { spec: 'Fullstack feature' },
      });
      const firstDone = await rt1.runUntilSettled(started.runId);
      expect(firstDone.status).toBe('SUCCEEDED');
      expect(Object.keys(firstDone.attempts)).toHaveLength(3); // backend + frontend + integration_reviewer

      const firstFrontendAttemptId =
        firstDone.scopes.$root?.nodes.frontend_author?.latestAttemptId;

      // Create a second runtime instance from disk and rerun ONLY `backend_author`
      const rt2 = makeRuntime();
      const secondDone = await rt2.rerunFromNode({
        runId: 'run-diamond-e2e',
        nodeId: 'backend_author',
      });

      expect(secondDone.status).toBe('SUCCEEDED');
      // Only `backend_author` and `integration_reviewer` ran again (+2 attempts = 5 total);
      // `frontend_author` kept its original attempt!
      expect(Object.keys(secondDone.attempts)).toHaveLength(5);
      expect(secondDone.scopes.$root?.nodes.frontend_author?.latestAttemptId).toBe(
        firstFrontendAttemptId
      );
      expect(secondDone.coordinatorEpoch).toBeGreaterThan(firstDone.coordinatorEpoch);
    },
    30_000
  );

  it(
    'fails a reviewer that answers in prose without a structured verdict instead of passing it',
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), 'ua-wf-lazy-work-'));
      const storageDir = mkdtempSync(join(tmpdir(), 'ua-wf-lazy-store-'));
      tempDirs.push(workdir, storageDir);
      const agentScript = createMockAcpAgentScript(workdir);

      const flow = createWorkflowBuilder('lazy-review', 'Lazy review')
        .addAgent({
          id: 'review',
          name: 'Review',
          role: 'reviewer',
          goal: 'Review the change',
          acceptanceCriteria: ['All tests pass'],
          producesAssessment: true,
          maxTechnicalRetries: 1,
          outputs: [{ name: 'assessment', type: 'assessment', required: true }],
        })
        .buildDefinition();

      const runtime = createNodeWorkflowRuntime({
        workdir,
        homeDir: storageDir,
        roleBindings: {
          reviewer: {
            target: {
              cliType: 'custom',
              agentType: 'mock-lazy-reviewer-acp',
              command: process.execPath,
              args: [agentScript],
            },
            env: { MOCK_AGENT_ROLE: 'lazy-reviewer', MOCK_TARGET_WORKDIR: workdir },
          },
        },
      });

      const started = await runtime.start({ definition: flow });
      const done = await runtime.runUntilSettled(started.runId);

      expect(done.status).toBe('FAILED');
      const node = done.scopes.$root!.nodes.review!;
      expect(node.status).toBe('FAILED');
      expect(node.latestVerdict).toBeUndefined();
      expect(node.retryCount).toBe(1);
      expect(node.error).toContain('returned no structured assessment');
      expect(Object.values(done.assessments)).toHaveLength(0);
    },
    30_000
  );

  it(
    'records the effort a step asked for and keeps running when the client has no effort setting',
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), 'ua-wf-effort-work-'));
      const storageDir = mkdtempSync(join(tmpdir(), 'ua-wf-effort-store-'));
      tempDirs.push(workdir, storageDir);
      const agentScript = createMockAcpAgentScript(workdir);
      const flow = createWorkflowBuilder('effort-flow', 'Effort flow')
        .addAgent({ id: 'think', name: 'Think hard', role: 'worker', goal: 'Think', effort: 'high' })
        .buildDefinition();
      const runtime = createNodeWorkflowRuntime({
        workdir,
        homeDir: storageDir,
        roleBindings: {
          worker: {
            target: { cliType: 'custom', agentType: 'mock-worker-acp', command: process.execPath, args: [agentScript] },
            env: { MOCK_AGENT_ROLE: 'worker', MOCK_TARGET_WORKDIR: workdir },
          },
        },
      });
      const done = await runtime.runUntilSettled((await runtime.start({ definition: flow })).runId);
      expect(done.status).toBe('SUCCEEDED');
      const attempt = done.attempts[done.scopes.$root!.nodes.think!.latestAttemptId!]!;
      expect(attempt.receipt?.effort).toBe('high');
    },
    30_000
  );

  it.each(['max_tokens', 'max_turn_requests', 'refusal', 'disconnect'])(
    'does not complete a node after a real ACP stream ends with %s',
    async (termination) => {
      const workdir = mkdtempSync(join(tmpdir(), 'ua-wf-terminal-work-'));
      const storageDir = mkdtempSync(join(tmpdir(), 'ua-wf-terminal-store-'));
      tempDirs.push(workdir, storageDir);
      const agentScript = createMockAcpAgentScript(workdir);
      const flow = createWorkflowBuilder('interrupted-turn')
        .addAgent({
          id: 'worker', name: 'Worker', role: 'worker', goal: 'Produce a candidate',
          outputs: [{ name: 'candidate', type: 'artifact', required: true }],
        })
        .addAgent({ id: 'consumer', name: 'Consumer', role: 'worker', goal: 'Use the candidate' })
        .connectControl('worker', 'consumer')
        .buildDefinition();
      const runtime = createNodeWorkflowRuntime({
        workdir,
        homeDir: storageDir,
        agentDataDir: join(storageDir, 'agent-data'),
        roleBindings: {
          worker: {
            target: { cliType: 'custom', agentType: 'mock-worker-acp', command: process.execPath, args: [agentScript] },
            env: termination === 'disconnect'
              ? { MOCK_DISCONNECT_AFTER_CHUNK: '1' }
              : { MOCK_STOP_REASON: termination },
          },
        },
      });
      const done = await runtime.runUntilSettled((await runtime.start({ definition: flow })).runId);

      expect(done.status).toBe('FAILED');
      expect(done.scopes.$root!.nodes.worker!.status).toBe('FAILED');
      expect(done.scopes.$root!.nodes.worker!.outputs).toEqual({});
      expect(done.scopes.$root!.nodes.consumer!.latestAttemptId).toBeUndefined();
      expect(Object.values(done.attempts)).toEqual([
        expect.objectContaining({ nodeId: 'worker', status: 'FAILED', producedArtifactIds: [] }),
      ]);
      expect(done.scopes.$root!.nodes.worker!.error).toMatch(
        termination === 'disconnect' ? /closed|disconnect|exited/i : new RegExp(termination)
      );
    },
    30_000
  );
});

