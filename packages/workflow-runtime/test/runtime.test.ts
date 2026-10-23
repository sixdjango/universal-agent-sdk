import {
  createBoundedFixLoopFlow,
  createHumanDecisionGateFlow,
  createParallelFanOutFlow,
  createWorkflowBuilder,
} from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  ArtifactQuotaExceededError,
  CoordinatorFenceError,
  createWorkflowRuntime,
  DeterministicClock,
  foldRunLog,
  InMemoryArtifactStore,
  InMemoryRuntimeStore,
  RevisionConflictError,
  SequentialIdGenerator,
  UnauthorizedArtifactReadError,
} from '../src/index';

describe('@universal-agent/workflow-runtime: Hierarchical DAG Scheduler, Context Bundle & Fencing', () => {
  it('executes boundedFixLoop across multiple rounds and injects priorRoundFeedback until PASS', async () => {
    const flow = createBoundedFixLoopFlow({
      id: 'fix-loop-test',
      maxRounds: 3,
      authorGoal: 'Implement add(a, b)',
      acceptanceCriteria: ['Returns a + b', 'Passes unit test'],
      verifyScript: {
        command: 'npm',
        args: ['test'],
      },
    });

    const authorPrompts: string[] = [];
    let authorCalls = 0;
    let scriptCalls = 0;

    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'author') {
            authorCalls += 1;
            authorPrompts.push(req.renderedPrompt);
            const code =
              authorCalls === 1
                ? 'export const add = (a, b) => a - b; // bug in round 0'
                : 'export const add = (a, b) => a + b; // fixed in round 1';
            return {
              status: 'COMPLETED',
              artifacts: {
                candidate: {
                  content: code,
                  mediaType: 'text/typescript',
                  summary: `Implementation v${authorCalls}`,
                },
              },
            };
          }

          if (req.node.id === 'reviewer') {
            const report = req.inputs.testReport as { exitCode: number };
            if (report.exitCode !== 0) {
              return {
                status: 'COMPLETED',
                assessment: {
                  verdict: 'NEEDS_FIX',
                  summary: 'Unit test failed because add subtracted instead of adding',
                  findings: [
                    {
                      id: 'f1',
                      severity: 'critical',
                      message: 'Replace a - b with a + b',
                      filePath: 'src/math.ts',
                    },
                  ],
                },
              };
            }
            return {
              status: 'COMPLETED',
              assessment: {
                verdict: 'PASS',
                summary: 'All acceptance criteria and unit tests verified',
                findings: [],
              },
            };
          }

          throw new Error(`Unexpected agent node: ${req.node.id}`);
        },

        async executeScript(req) {
          scriptCalls += 1;
          const code = String(req.inputs.candidate ?? '');
          const passed = code.includes('a + b');
          return {
            exitCode: passed ? 0 : 1,
            stdout: passed ? '1 passed' : '',
            stderr: passed ? '' : 'AssertionError: expected -1 to equal 3',
            durationMs: 25,
          };
        },
      },
    });

    const initial = await runtime.start({
      definition: flow,
      inputs: { specification: 'Write add(a, b) function' },
    });
    const finalState = await runtime.runUntilSettled(initial.runId);

    expect(finalState.status).toBe('SUCCEEDED');
    expect(authorCalls).toBe(2);
    expect(scriptCalls).toBe(2);
    // Round 1 prompt must include prior round feedback and findings!
    expect(authorPrompts[1]).toContain('Prior Loop Round Feedback (Round 0 -> NEEDS_FIX)');
    expect(authorPrompts[1]).toContain('Replace a - b with a + b');
    expect(String(finalState.outputs.artifact)).toContain('a + b');
  });

  it('enforces ContextBundle inline byte budget, preserves acceptance criteria, and guards ScopedArtifactReader', async () => {
    const flow = createWorkflowBuilder('context-budget-flow')
      .addWorkflowInput({ name: 'seed', type: 'string', required: true })
      .addAgent({
        id: 'producer_used',
        name: 'Used Producer',
        role: 'author',
        goal: 'Produce large markdown doc',
        inputs: [{ name: 'seed', type: 'string', required: true }],
        outputs: [{ name: 'largeDoc', type: 'artifact', required: true }],
      })
      .addAgent({
        id: 'producer_unrelated',
        name: 'Unrelated Producer (Not connected by DataEdge to consumer)',
        role: 'author',
        goal: 'Produce secret doc on unrelated branch',
        inputs: [{ name: 'seed', type: 'string', required: true }],
        outputs: [{ name: 'secretDoc', type: 'artifact', required: true }],
      })
      .addAgent({
        id: 'consumer',
        name: 'Consumer with tight budget',
        role: 'reviewer',
        goal: 'Audit largeDoc while preserving mandatory criteria',
        acceptanceCriteria: ['MUST_KEEP_CRITERION_ALPHA', 'MUST_KEEP_CRITERION_BETA'],
        constraints: ['NEVER_DROP_CONSTRAINT_GAMMA'],
        contextBudget: {
          initialBundleBytes: 512, // tight inline budget so 2KB doc overflows to artifact_ref
          pageReadBytes: 200,
          stageReadQuotaBytes: 350,
        },
        inputs: [{ name: 'doc', type: 'artifact', required: true }],
        outputs: [{ name: 'result', type: 'string', required: true }],
      })
      .connectData({
        fromNodeId: '$input',
        fromPort: 'seed',
        toNodeId: 'producer_used',
        toPort: 'seed',
      })
      .connectData({
        fromNodeId: '$input',
        fromPort: 'seed',
        toNodeId: 'producer_unrelated',
        toPort: 'seed',
      })
      .connectControl('producer_unrelated', 'consumer')
      .connectData({
        fromNodeId: 'producer_used',
        fromPort: 'largeDoc',
        toNodeId: 'consumer',
        toPort: 'doc',
        withControl: true,
      })
      .buildDefinition();

    let unrelatedArtifactId = '';
    const artifacts = new InMemoryArtifactStore();

    const runtime = createWorkflowRuntime({
      artifacts,
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'producer_used') {
            const bigText = `# Architecture\n${'A'.repeat(1200)}\n# Security\n${'B'.repeat(1200)}`;
            return {
              status: 'COMPLETED',
              artifacts: {
                largeDoc: { content: bigText, mediaType: 'text/markdown', summary: 'Big arch doc' },
              },
            };
          }
          if (req.node.id === 'producer_unrelated') {
            return {
              status: 'COMPLETED',
              artifacts: {
                secretDoc: { content: 'TOP_SECRET_UNCONNECTED_DATA', mediaType: 'text/plain' },
              },
            };
          }
          if (req.node.id === 'consumer') {
            // 1. Mandatory goal, acceptanceCriteria, and constraints must be 100% preserved
            expect(req.renderedPrompt).toContain('MUST_KEEP_CRITERION_ALPHA');
            expect(req.renderedPrompt).toContain('MUST_KEEP_CRITERION_BETA');
            expect(req.renderedPrompt).toContain('NEVER_DROP_CONSTRAINT_GAMMA');

            // 2. Large doc exceeded 512B inline budget so it must be delivered as artifact_ref
            expect(req.manifest.entries).toHaveLength(1);
            expect(req.manifest.entries[0]?.mode).toBe('artifact_ref');
            const authArtId = req.manifest.entries[0]!.artifactRef!.artifactId;

            // 3. Attempting to read `secretDoc` (connected only by ControlEdge, NOT DataEdge) must throw UnauthorizedArtifactReadError
            await expect(req.artifactReader.readPage(unrelatedArtifactId)).rejects.toBeInstanceOf(
              UnauthorizedArtifactReadError
            );

            // 4. Paginated read on authorized artifact succeeds within quota (200B page)
            const page1 = await req.artifactReader.readPage(authArtId, {
              offsetBytes: 0,
              maxBytes: 200,
            });
            expect(page1.readBytes).toBe(200);
            expect(page1.hasMore).toBe(true);

            // Second page (150B left in 350B stage quota)
            const page2 = await req.artifactReader.readPage(authArtId, {
              offsetBytes: 200,
              maxBytes: 200,
            });
            expect(page2.readBytes).toBe(150);

            // Third read exceeds 350B stageReadQuotaBytes!
            await expect(
              req.artifactReader.readPage(authArtId, { offsetBytes: 350, maxBytes: 100 })
            ).rejects.toBeInstanceOf(ArtifactQuotaExceededError);

            return {
              status: 'COMPLETED',
              outputs: { result: 'verified' },
            };
          }
          throw new Error(`Unknown node ${req.node.id}`);
        },
        async executeScript() {
          throw new Error('Unused');
        },
      },
    });

    const started = await runtime.start({
      definition: flow,
      inputs: { seed: 'go' },
    });

    // Step through producer nodes so we can capture `unrelatedArtifactId`
    const finalState = await runtime.runUntilSettled(started.runId);
    unrelatedArtifactId =
      finalState.scopes.$root?.nodes.producer_unrelated?.outputs.secretDoc?.artifactId ?? '';
    expect(finalState.status).toBe('SUCCEEDED');
    expect(finalState.readReceipts).toHaveLength(2);
  });

  it('handles GateNode pause, idempotent respond(), conditional dead-path SKIPPED propagation, and parallel fan-out', async () => {
    const gateFlow = createHumanDecisionGateFlow({
      id: 'gate-test',
      plannerGoal: 'Create deployment plan',
      gatePrompt: 'Proceed with deployment?',
      executorGoal: 'Deploy service',
    });

    let executorRan = false;
    const runtime = createWorkflowRuntime({
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'planner') {
            return {
              status: 'COMPLETED',
              outputs: { proposal: 'Deploy v2' },
            };
          }
          if (req.node.id === 'executor') {
            executorRan = true;
            return {
              status: 'COMPLETED',
              outputs: { executionResult: 'Deployed v2' },
            };
          }
          throw new Error(`Unexpected node: ${req.node.id}`);
        },
        async executeScript() {
          throw new Error('Unused');
        },
      },
    });

    // Case A: Human rejects -> `executor` node is SKIPPED via dead-path elimination!
    const runReject = await runtime.start({
      definition: gateFlow,
      inputs: { request: 'deploy' },
    });
    const pausedState = await runtime.runUntilSettled(runReject.runId);
    expect(pausedState.status).toBe('WAITING');
    const waitReq = Object.values(pausedState.waitRequests)[0]!;
    expect(waitReq.prompt).toBe('Proceed with deployment?');

    // Duplicate respond with same answer is idempotent
    const afterReject = await runtime.respond({
      runId: runReject.runId,
      requestId: waitReq.requestId,
      answer: 'reject',
      responderId: 'user-1',
    });
    const idempotentRepeat = await runtime.respond({
      runId: runReject.runId,
      requestId: waitReq.requestId,
      answer: 'reject',
      responderId: 'user-1',
    });
    expect(idempotentRepeat.revision).toBe(afterReject.revision);
    expect(afterReject.status).toBe('SUCCEEDED');
    expect(afterReject.scopes.$root?.nodes.executor?.status).toBe('SKIPPED');
    expect(executorRan).toBe(false);

    // Parallel fan-out & fan-in test
    const parallelFlow = createParallelFanOutFlow({
      id: 'parallel-test',
      workerGoal: 'Process item',
      reducerGoal: 'Combine items',
    });
    const parallelRuntime = createWorkflowRuntime({
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'item_worker') {
            return {
              status: 'COMPLETED',
              outputs: { itemResult: `processed:${String(req.inputs.item)}` },
            };
          }
          if (req.node.id === 'reducer') {
            const list = req.inputs.results as string[];
            return {
              status: 'COMPLETED',
              outputs: { summary: list.join(' | ') },
            };
          }
          throw new Error(`Unexpected: ${req.node.id}`);
        },
        async executeScript() {
          throw new Error('Unused');
        },
      },
    });
    const pStart = await parallelRuntime.start({
      definition: parallelFlow,
      inputs: { items: ['modA', 'modB', 'modC'] },
    });
    const pFinal = await parallelRuntime.runUntilSettled(pStart.runId);
    expect(pFinal.status).toBe('SUCCEEDED');
    expect(pFinal.outputs.summary).toBe('processed:modA | processed:modB | processed:modC');
  });

  it('reruns only the reachable downstream subgraph on rerunFromNode and enforces CoordinatorEpoch & CAS fences', async () => {
    const diamond = createWorkflowBuilder('diamond-rerun')
      .addWorkflowInput({ name: 'seed', type: 'string', required: true })
      .addWorkflowOutput({ name: 'finalOut', type: 'string', required: true })
      .addAgent({
        id: 'left',
        name: 'Left',
        role: 'author',
        goal: 'Left work',
        inputs: [{ name: 'seed', type: 'string', required: true }],
        outputs: [{ name: 'leftVal', type: 'string', required: true }],
      })
      .addAgent({
        id: 'right',
        name: 'Right',
        role: 'author',
        goal: 'Right work',
        inputs: [{ name: 'seed', type: 'string', required: true }],
        outputs: [{ name: 'rightVal', type: 'string', required: true }],
      })
      .addAgent({
        id: 'join',
        name: 'Join',
        role: 'reviewer',
        goal: 'Join left and right',
        producesAssessment: true,
        inputs: [
          { name: 'leftVal', type: 'string', required: true },
          { name: 'rightVal', type: 'string', required: true },
        ],
        outputs: [{ name: 'finalOut', type: 'string', required: true }],
      })
      .connectData({ fromNodeId: '$input', fromPort: 'seed', toNodeId: 'left', toPort: 'seed' })
      .connectData({ fromNodeId: '$input', fromPort: 'seed', toNodeId: 'right', toPort: 'seed' })
      .connectData({
        fromNodeId: 'left',
        fromPort: 'leftVal',
        toNodeId: 'join',
        toPort: 'leftVal',
        withControl: true,
      })
      .connectData({
        fromNodeId: 'right',
        fromPort: 'rightVal',
        toNodeId: 'join',
        toPort: 'rightVal',
        withControl: true,
      })
      .connectData({
        fromNodeId: 'join',
        fromPort: 'finalOut',
        toNodeId: '$output',
        toPort: 'finalOut',
      })
      .buildDefinition();

    const executionCounts: Record<string, number> = { left: 0, right: 0, join: 0 };
    const store = new InMemoryRuntimeStore();
    const runtime = createWorkflowRuntime({
      store,
      executor: {
        async executeAgent(req) {
          executionCounts[req.node.id] = (executionCounts[req.node.id] ?? 0) + 1;
          if (req.node.id === 'left') {
            return {
              status: 'COMPLETED',
              outputs: { leftVal: `L${executionCounts.left}` },
            };
          }
          if (req.node.id === 'right') {
            return {
              status: 'COMPLETED',
              outputs: { rightVal: `R${executionCounts.right}` },
            };
          }
          return {
            status: 'COMPLETED',
            outputs: {
              finalOut: `${String(req.inputs.leftVal)}+${String(req.inputs.rightVal)}`,
            },
            assessment: {
              verdict: 'PASS',
              summary: 'Joined cleanly',
            },
          };
        },
        async executeScript() {
          throw new Error('Unused');
        },
      },
    });

    const initial = await runtime.start({ definition: diamond, inputs: { seed: 'init' } });
    const firstDone = await runtime.runUntilSettled(initial.runId);
    expect(firstDone.outputs.finalOut).toBe('L1+R1');
    expect(executionCounts).toEqual({ left: 1, right: 1, join: 1 });

    // Rerun ONLY `left` -> `left` and `join` must re-execute, while `right` stays at count 1!
    const secondDone = await runtime.rerunFromNode({
      runId: initial.runId,
      nodeId: 'left',
    });
    expect(secondDone.outputs.finalOut).toBe('L2+R1');
    expect(executionCounts).toEqual({ left: 2, right: 1, join: 2 });

    // Old assessment from first `join` must be marked `stale: true`
    const assessments = Object.values(secondDone.assessments);
    expect(assessments).toHaveLength(2);
    expect(assessments.some((a) => a.stale === true)).toBe(true);
    expect(assessments.some((a) => a.stale === false)).toBe(true);

    // Fault Injection: Stale CoordinatorEpoch and stale CAS Revision must be rejected
    const noopPatch = [{ kind: 'run.patched', status: secondDone.status }] as const;
    await expect(
      store.appendMutations({
        runId: initial.runId,
        expectedSeq: secondDone.revision,
        coordinatorEpoch: 1, // stale epoch!
        mutations: noopPatch,
      })
    ).rejects.toBeInstanceOf(CoordinatorFenceError);

    await expect(
      store.appendMutations({
        runId: initial.runId,
        expectedSeq: 1, // stale revision!
        coordinatorEpoch: secondDone.coordinatorEpoch,
        mutations: noopPatch,
      })
    ).rejects.toBeInstanceOf(RevisionConflictError);

    // The append-only log alone must reproduce the live state
    const log = await store.readLog(initial.runId);
    expect(log[0]?.mutation.kind).toBe('run.created');
    expect(log.map((e) => e.seq)).toEqual(log.map((_, idx) => idx + 1));
    expect(foldRunLog(log)).toEqual(await store.getRun(initial.runId));
  });

  it('handles nested WaitRequest inside LoopNode, LoopNode onExhausted="gate", technical error persistence, and UTF-8 multi-byte slicing', async () => {
    // 1. LoopNode with nested mid-turn WAIT_REQUESTED on round 0 and `onExhausted: 'gate'` on round 1
    const loopFlow = createBoundedFixLoopFlow({
      id: 'loop-gate-exhausted',
      maxRounds: 2,
      onExhausted: 'gate',
      authorGoal: 'Draft code',
      acceptanceCriteria: ['Must pass review'],
    });

    let authorInvocations = 0;
    const loopRuntime = createWorkflowRuntime({
      executor: {
        async executeAgent(req) {
          if (req.node.id === 'author') {
            authorInvocations += 1;
            // First call in round 0 requests human clarification mid-turn
            if (authorInvocations === 1 && !req.humanAnswer) {
              return {
                status: 'WAIT_REQUESTED',
                waitRequest: {
                  prompt: 'Which target runtime should I use?',
                  options: [{ value: 'node22', label: 'Node 22' }],
                },
              };
            }
            return {
              status: 'COMPLETED',
              artifacts: {
                candidate: {
                  content: `code_v${authorInvocations}_${String(req.humanAnswer?.answer ?? 'default')}`,
                },
              },
            };
          }
          // Reviewer always returns NEEDS_FIX so the 2-round loop exhausts and triggers `onExhausted: 'gate'`
          return {
            status: 'COMPLETED',
            assessment: {
              verdict: 'NEEDS_FIX',
              summary: 'Still needs minor polish',
              findings: [{ id: 'f1', severity: 'minor', message: 'Polish naming' }],
            },
          };
        },
        async executeScript() {
          throw new Error('Unused');
        },
      },
    });

    const loopStart = await loopRuntime.start({
      definition: loopFlow,
      inputs: { specification: 'Build service' },
    });
    const pausedInsideLoop = await loopRuntime.runUntilSettled(loopStart.runId);
    expect(pausedInsideLoop.status).toBe('WAITING');
    const nestedWait = Object.values(pausedInsideLoop.waitRequests).find(
      (w) => w.status === 'PENDING'
    )!;
    expect(nestedWait.scopeKey).toBe('$root/fix_loop:round_0');

    // Respond to the nested wait inside round 0 -> resumes round 0, runs round 1, and pauses at `onExhausted: 'gate'`!
    const pausedAtExhaustedGate = await loopRuntime.respond({
      runId: loopStart.runId,
      requestId: nestedWait.requestId,
      answer: 'node22',
      responderId: 'architect',
    });
    expect(pausedAtExhaustedGate.status).toBe('WAITING');
    const exhaustedWait = Object.values(pausedAtExhaustedGate.waitRequests).find(
      (w) => w.status === 'PENDING'
    )!;
    expect(exhaustedWait.nodeId).toBe('fix_loop');

    // Approve the exhausted loop gate -> workflow converges to SUCCEEDED!
    const completedLoop = await loopRuntime.respond({
      runId: loopStart.runId,
      requestId: exhaustedWait.requestId,
      answer: 'approve',
      responderId: 'tech-lead',
    });
    expect(completedLoop.status).toBe('SUCCEEDED');
    expect(completedLoop.outputs.artifact).toContain('code_v3');

    // 2. Technical failure persistence after exhausting `maxTechnicalRetries`
    const failingFlow = createWorkflowBuilder('failing-agent-flow')
      .addAgent({
        id: 'flaky',
        name: 'Flaky Agent',
        role: 'worker',
        goal: 'Try work',
        maxTechnicalRetries: 1,
        outputs: [{ name: 'out', type: 'string', required: true }],
      })
      .buildDefinition();

    let flakyTries = 0;
    const failRuntime = createWorkflowRuntime({
      executor: {
        async executeAgent() {
          flakyTries += 1;
          throw new Error(`ACP connection reset (try ${flakyTries})`);
        },
        async executeScript() {
          throw new Error('Unused');
        },
      },
    });
    const failStart = await failRuntime.start({ definition: failingFlow });
    const failedRun = await failRuntime.runUntilSettled(failStart.runId);
    expect(failedRun.status).toBe('FAILED');
    expect(flakyTries).toBe(2); // initial + 1 technical retry
    const failedAttempt = Object.values(failedRun.attempts)[0]!;
    expect(failedAttempt.status).toBe('FAILED');
    expect(failedAttempt.error).toContain('ACP connection reset (try 2)');

    // 3. UTF-8 multi-byte character pagination in ArtifactStore.readSlice
    const artifactStore = new InMemoryArtifactStore();
    const chineseDoc = '#### 第四级标题\n你好世界，这是一段包含中文多字节字符的架构说明文档。';
    const art = await artifactStore.put({
      content: chineseDoc,
      producerRunId: 'r1',
      producerNodeId: 'n1',
      producerAttemptId: 'a1',
      portName: 'doc',
    });
    expect(art.sections).toEqual(['第四级标题']);

    // Slice with 10-byte pages (which would normally land mid-character in 3-byte UTF-8 Chinese chars)
    let offset = 0;
    let reconstructed = '';
    while (true) {
      const slice = await artifactStore.readSlice(art.artifactId, {
        offsetBytes: offset,
        maxBytes: 10,
      });
      expect(slice.content).not.toContain('\uFFFD');
      reconstructed += slice.content;
      if (!slice.hasMore || slice.nextOffsetBytes === undefined) break;
      offset = slice.nextOffsetBytes;
    }
    expect(reconstructed).toBe(chineseDoc);
  });
});
