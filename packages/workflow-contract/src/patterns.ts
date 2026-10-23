import { createWorkflowBuilder } from './builder';
import type { GateQuestionOption, WorkflowDefinition } from './schema';

/**
 * Pattern 1: Single Task and Structured Report (`singleTaskAndReport`)
 * Executes a single Agent node without an implicit retry loop.
 */
export function createSingleTaskFlow(options: {
  id: string;
  name?: string;
  role?: string;
  agentType?: string;
  goal: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  writeScopes?: string[];
}): WorkflowDefinition {
  return createWorkflowBuilder(options.id, options.name ?? 'Single Task & Report')
    .addWorkflowInput({ name: 'taskInput', type: 'json', required: true })
    .addWorkflowOutput({ name: 'report', type: 'artifact', required: true })
    .addAgent({
      id: 'worker',
      name: 'Task Worker',
      role: options.role ?? 'worker',
      agentType: options.agentType,
      goal: options.goal,
      acceptanceCriteria: options.acceptanceCriteria ?? [],
      constraints: options.constraints ?? [],
      writeScopes: options.writeScopes ?? [],
      inputs: [{ name: 'taskInput', type: 'json', required: true }],
      outputs: [{ name: 'report', type: 'artifact', required: true }],
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'taskInput',
      toNodeId: 'worker',
      toPort: 'taskInput',
    })
    .connectData({
      fromNodeId: 'worker',
      fromPort: 'report',
      toNodeId: '$output',
      toPort: 'report',
    })
    .buildDefinition();
}

/**
 * Pattern 2: Author + Independent Reviewer (`authorAndReviewer`)
 * Author produces a candidate artifact; Reviewer receives both the original specification
 * and the candidate artifact to perform independent verification.
 */
export function createAuthorReviewerFlow(options: {
  id: string;
  name?: string;
  authorRole?: string;
  authorAgentType?: string;
  reviewerRole?: string;
  reviewerAgentType?: string;
  authorGoal: string;
  reviewerGoal?: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  writeScopes?: string[];
}): WorkflowDefinition {
  return createWorkflowBuilder(options.id, options.name ?? 'Author & Independent Reviewer')
    .addWorkflowInput({ name: 'specification', type: 'json', required: true })
    .addWorkflowOutput({ name: 'artifact', type: 'artifact', required: true })
    .addWorkflowOutput({ name: 'assessment', type: 'assessment', required: true })
    .addAgent({
      id: 'author',
      name: 'Author Agent',
      role: options.authorRole ?? 'author',
      agentType: options.authorAgentType,
      goal: options.authorGoal,
      acceptanceCriteria: options.acceptanceCriteria,
      constraints: options.constraints ?? [],
      writeScopes: options.writeScopes ?? ['src'],
      inputs: [{ name: 'specification', type: 'json', required: true }],
      outputs: [{ name: 'candidate', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'reviewer',
      name: 'Independent Reviewer Agent',
      role: options.reviewerRole ?? 'reviewer',
      agentType: options.reviewerAgentType,
      goal:
        options.reviewerGoal ??
        'Independently audit the candidate artifact against the original specification and acceptance criteria.',
      acceptanceCriteria: options.acceptanceCriteria,
      constraints: [
        'Do not trust author self-assertions without verifying evidence.',
        ...(options.constraints ?? []),
      ],
      producesAssessment: true,
      inputs: [
        { name: 'specification', type: 'json', required: true },
        { name: 'candidate', type: 'artifact', required: true },
      ],
      outputs: [{ name: 'assessment', type: 'assessment', required: true }],
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'specification',
      toNodeId: 'author',
      toPort: 'specification',
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'specification',
      toNodeId: 'reviewer',
      toPort: 'specification',
    })
    .connectData({
      fromNodeId: 'author',
      fromPort: 'candidate',
      toNodeId: 'reviewer',
      toPort: 'candidate',
      withControl: true,
    })
    .connectData({
      fromNodeId: 'author',
      fromPort: 'candidate',
      toNodeId: '$output',
      toPort: 'artifact',
    })
    .connectData({
      fromNodeId: 'reviewer',
      fromPort: 'assessment',
      toNodeId: '$output',
      toPort: 'assessment',
    })
    .buildDefinition();
}

/**
 * Pattern 3: Bounded Fix Loop (`boundedFixLoop`)
 * Wraps `Author (Agent) -> Verify (Optional Script) -> Review (Agent)` inside a scoped `LoopNode`
 * that iterates while verdict is `NEEDS_FIX` up to `maxRounds`.
 */
export function createBoundedFixLoopFlow(options: {
  id: string;
  name?: string;
  maxRounds?: number;
  onExhausted?: 'fail' | 'gate' | 'pass_with_findings';
  authorRole?: string;
  authorAgentType?: string;
  reviewerRole?: string;
  reviewerAgentType?: string;
  authorGoal: string;
  reviewerGoal?: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  writeScopes?: string[];
  verifyScript?: {
    command: string;
    args?: string[];
    timeoutMs?: number;
  };
}): WorkflowDefinition {
  return createWorkflowBuilder(options.id, options.name ?? 'Bounded Fix Loop')
    .addWorkflowInput({ name: 'specification', type: 'json', required: true })
    .addWorkflowOutput({ name: 'artifact', type: 'artifact', required: true })
    .addWorkflowOutput({ name: 'assessment', type: 'assessment', required: true })
    .addLoop({
      id: 'fix_loop',
      name: 'Author-Verify-Review Loop',
      maxRounds: options.maxRounds ?? 3,
      onExhausted: options.onExhausted ?? 'fail',
      continueWhen: {
        kind: 'verdict_is',
        verdict: 'NEEDS_FIX',
        sourceNodeId: 'reviewer',
      },
      inputs: [{ name: 'specification', type: 'json', required: true }],
      outputs: [
        { name: 'candidate', type: 'artifact', required: true },
        { name: 'assessment', type: 'assessment', required: true },
      ],
      writeScopes: options.writeScopes ?? ['src'],
      body: (loop) => {
        loop.addAgent({
          id: 'author',
          name: 'Author Agent',
          role: options.authorRole ?? 'author',
          agentType: options.authorAgentType,
          goal: options.authorGoal,
          acceptanceCriteria: options.acceptanceCriteria,
          constraints: options.constraints ?? [],
          writeScopes: options.writeScopes ?? ['src'],
          inputs: [{ name: 'specification', type: 'json', required: true }],
          outputs: [{ name: 'candidate', type: 'artifact', required: true }],
        });

        loop.connectData({
          fromNodeId: '$input',
          fromPort: 'specification',
          toNodeId: 'author',
          toPort: 'specification',
        });

        if (options.verifyScript) {
          loop.addScript({
            id: 'verify',
            name: 'Verification Script',
            command: options.verifyScript.command,
            args: options.verifyScript.args ?? [],
            timeoutMs: options.verifyScript.timeoutMs ?? 60_000,
            producesAssessment: true,
            inputs: [{ name: 'candidate', type: 'artifact', required: true }],
            outputs: [{ name: 'testReport', type: 'json', required: true }],
          });

          loop.addAgent({
            id: 'reviewer',
            name: 'Independent Reviewer Agent',
            role: options.reviewerRole ?? 'reviewer',
            agentType: options.reviewerAgentType,
            goal:
              options.reviewerGoal ??
              'Review candidate artifact and verification test report against original specification.',
            acceptanceCriteria: options.acceptanceCriteria,
            constraints: options.constraints ?? [],
            producesAssessment: true,
            inputs: [
              { name: 'specification', type: 'json', required: true },
              { name: 'candidate', type: 'artifact', required: true },
              { name: 'testReport', type: 'json', required: true },
            ],
            outputs: [{ name: 'assessment', type: 'assessment', required: true }],
          });

          loop.connectData({
            fromNodeId: 'author',
            fromPort: 'candidate',
            toNodeId: 'verify',
            toPort: 'candidate',
            withControl: true,
          });
          loop.connectData({
            fromNodeId: '$input',
            fromPort: 'specification',
            toNodeId: 'reviewer',
            toPort: 'specification',
          });
          loop.connectData({
            fromNodeId: 'author',
            fromPort: 'candidate',
            toNodeId: 'reviewer',
            toPort: 'candidate',
            withControl: true,
          });
          loop.connectData({
            fromNodeId: 'verify',
            fromPort: 'testReport',
            toNodeId: 'reviewer',
            toPort: 'testReport',
            withControl: true,
          });
        } else {
          loop.addAgent({
            id: 'reviewer',
            name: 'Independent Reviewer Agent',
            role: options.reviewerRole ?? 'reviewer',
            agentType: options.reviewerAgentType,
            goal:
              options.reviewerGoal ??
              'Review candidate artifact against original specification.',
            acceptanceCriteria: options.acceptanceCriteria,
            constraints: options.constraints ?? [],
            producesAssessment: true,
            inputs: [
              { name: 'specification', type: 'json', required: true },
              { name: 'candidate', type: 'artifact', required: true },
            ],
            outputs: [{ name: 'assessment', type: 'assessment', required: true }],
          });

          loop.connectData({
            fromNodeId: '$input',
            fromPort: 'specification',
            toNodeId: 'reviewer',
            toPort: 'specification',
          });
          loop.connectData({
            fromNodeId: 'author',
            fromPort: 'candidate',
            toNodeId: 'reviewer',
            toPort: 'candidate',
            withControl: true,
          });
        }

        loop.connectData({
          fromNodeId: 'author',
          fromPort: 'candidate',
          toNodeId: '$output',
          toPort: 'candidate',
        });
        loop.connectData({
          fromNodeId: 'reviewer',
          fromPort: 'assessment',
          toNodeId: '$output',
          toPort: 'assessment',
        });
      },
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'specification',
      toNodeId: 'fix_loop',
      toPort: 'specification',
    })
    .connectData({
      fromNodeId: 'fix_loop',
      fromPort: 'candidate',
      toNodeId: '$output',
      toPort: 'artifact',
    })
    .connectData({
      fromNodeId: 'fix_loop',
      fromPort: 'assessment',
      toNodeId: '$output',
      toPort: 'assessment',
    })
    .buildDefinition();
}

/**
 * Pattern 4: Parallel Fan-Out & Fan-In (`parallelFanOutFanIn`)
 * Fans out across declared `items` inside a `ParallelNode` container and aggregates results in a `reducer` Agent node.
 */
export function createParallelFanOutFlow(options: {
  id: string;
  name?: string;
  maxConcurrency?: number;
  workerRole?: string;
  workerAgentType?: string;
  workerGoal: string;
  reducerRole?: string;
  reducerAgentType?: string;
  reducerGoal: string;
  acceptanceCriteria?: string[];
}): WorkflowDefinition {
  return createWorkflowBuilder(options.id, options.name ?? 'Parallel Fan-Out & Fan-In')
    .addWorkflowInput({ name: 'items', type: 'array', required: true })
    .addWorkflowOutput({ name: 'summary', type: 'artifact', required: true })
    .addParallel({
      id: 'fan_out',
      name: 'Parallel Item Workers',
      itemsPort: 'items',
      maxConcurrency: options.maxConcurrency ?? 4,
      inputs: [{ name: 'items', type: 'array', required: true }],
      outputs: [{ name: 'results', type: 'array', required: true }],
      itemBody: (sub) => {
        sub
          .addAgent({
            id: 'item_worker',
            name: 'Item Worker',
            role: options.workerRole ?? 'worker',
            agentType: options.workerAgentType,
            goal: options.workerGoal,
            acceptanceCriteria: options.acceptanceCriteria ?? [],
            inputs: [{ name: 'item', type: 'json', required: true }],
            outputs: [{ name: 'itemResult', type: 'artifact', required: true }],
          })
          .connectData({
            fromNodeId: '$input',
            fromPort: 'item',
            toNodeId: 'item_worker',
            toPort: 'item',
          })
          .connectData({
            fromNodeId: 'item_worker',
            fromPort: 'itemResult',
            toNodeId: '$output',
            toPort: 'results',
          });
      },
    })
    .addAgent({
      id: 'reducer',
      name: 'Fan-In Reducer',
      role: options.reducerRole ?? 'reducer',
      agentType: options.reducerAgentType,
      goal: options.reducerGoal,
      acceptanceCriteria: options.acceptanceCriteria ?? [],
      inputs: [{ name: 'results', type: 'array', required: true }],
      outputs: [{ name: 'summary', type: 'artifact', required: true }],
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'items',
      toNodeId: 'fan_out',
      toPort: 'items',
    })
    .connectData({
      fromNodeId: 'fan_out',
      fromPort: 'results',
      toNodeId: 'reducer',
      toPort: 'results',
      withControl: true,
    })
    .connectData({
      fromNodeId: 'reducer',
      fromPort: 'summary',
      toNodeId: '$output',
      toPort: 'summary',
    })
    .buildDefinition();
}

/**
 * Pattern 5: Serialized Writer with Affected Consumer Re-verification (`serializedWriterWithReverify`)
 * Two writer nodes sharing overlapping `writeScopes` followed by downstream verification.
 */
export function createSerializedWriterReverifyFlow(options: {
  id: string;
  name?: string;
  sharedWriteScope: string;
  firstWriterGoal: string;
  secondWriterGoal: string;
  verifierCommand: string;
  verifierArgs?: string[];
}): WorkflowDefinition {
  return createWorkflowBuilder(options.id, options.name ?? 'Serialized Writers with Reverify')
    .addWorkflowInput({ name: 'spec', type: 'json', required: true })
    .addWorkflowOutput({ name: 'verificationReport', type: 'json', required: true })
    .addAgent({
      id: 'writer_a',
      name: 'Writer A',
      role: 'author',
      goal: options.firstWriterGoal,
      writeScopes: [options.sharedWriteScope],
      inputs: [{ name: 'spec', type: 'json', required: true }],
      outputs: [{ name: 'patchA', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'writer_b',
      name: 'Writer B',
      role: 'author',
      goal: options.secondWriterGoal,
      writeScopes: [options.sharedWriteScope],
      inputs: [{ name: 'spec', type: 'json', required: true }],
      outputs: [{ name: 'patchB', type: 'artifact', required: true }],
    })
    .addScript({
      id: 'reverify',
      name: 'Affected Scope Verifier',
      command: options.verifierCommand,
      args: options.verifierArgs ?? [],
      producesAssessment: true,
      inputs: [
        { name: 'patchA', type: 'artifact', required: true },
        { name: 'patchB', type: 'artifact', required: true },
      ],
      outputs: [{ name: 'verificationReport', type: 'json', required: true }],
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'spec',
      toNodeId: 'writer_a',
      toPort: 'spec',
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'spec',
      toNodeId: 'writer_b',
      toPort: 'spec',
    })
    .connectData({
      fromNodeId: 'writer_a',
      fromPort: 'patchA',
      toNodeId: 'reverify',
      toPort: 'patchA',
      withControl: true,
    })
    .connectData({
      fromNodeId: 'writer_b',
      fromPort: 'patchB',
      toNodeId: 'reverify',
      toPort: 'patchB',
      withControl: true,
    })
    .connectData({
      fromNodeId: 'reverify',
      fromPort: 'verificationReport',
      toNodeId: '$output',
      toPort: 'verificationReport',
    })
    .buildDefinition();
}

/**
 * Pattern 6: Human Decision Gate (`humanDecisionGate`)
 * Prepares a proposal via an Agent, pauses at a `GateNode` for human approval/decision,
 * and routes conditionally based on the human decision.
 */
export function createHumanDecisionGateFlow(options: {
  id: string;
  name?: string;
  plannerGoal: string;
  gatePrompt: string;
  gateOptions?: GateQuestionOption[];
  executorGoal: string;
}): WorkflowDefinition {
  const gateOptions: GateQuestionOption[] = options.gateOptions ?? [
    { value: 'approve', label: 'Approve & Execute' },
    { value: 'reject', label: 'Reject' },
  ];

  return createWorkflowBuilder(options.id, options.name ?? 'Human Decision Gate Flow')
    .addWorkflowInput({ name: 'request', type: 'json', required: true })
    .addWorkflowOutput({ name: 'executionResult', type: 'artifact', required: false })
    .addAgent({
      id: 'planner',
      name: 'Proposal Planner',
      role: 'planner',
      goal: options.plannerGoal,
      inputs: [{ name: 'request', type: 'json', required: true }],
      outputs: [{ name: 'proposal', type: 'artifact', required: true }],
    })
    .addGate({
      id: 'approval_gate',
      name: 'Human Approval Gate',
      prompt: options.gatePrompt,
      options: gateOptions,
      inputs: [{ name: 'proposal', type: 'artifact', required: true }],
      outputs: [{ name: 'decision', type: 'string', required: true }],
    })
    .addAgent({
      id: 'executor',
      name: 'Approved Plan Executor',
      role: 'executor',
      goal: options.executorGoal,
      inputs: [
        { name: 'proposal', type: 'artifact', required: true },
        { name: 'decision', type: 'string', required: true },
      ],
      outputs: [{ name: 'executionResult', type: 'artifact', required: true }],
    })
    .connectData({
      fromNodeId: '$input',
      fromPort: 'request',
      toNodeId: 'planner',
      toPort: 'request',
    })
    .connectData({
      fromNodeId: 'planner',
      fromPort: 'proposal',
      toNodeId: 'approval_gate',
      toPort: 'proposal',
      withControl: true,
    })
    .connectControl('approval_gate', 'executor', {
      kind: 'port_equals',
      port: 'decision',
      value: 'approve',
      sourceNodeId: 'approval_gate',
    })
    .connectData({
      fromNodeId: 'planner',
      fromPort: 'proposal',
      toNodeId: 'executor',
      toPort: 'proposal',
    })
    .connectData({
      fromNodeId: 'approval_gate',
      fromPort: 'decision',
      toNodeId: 'executor',
      toPort: 'decision',
    })
    .connectData({
      fromNodeId: 'executor',
      fromPort: 'executionResult',
      toNodeId: '$output',
      toPort: 'executionResult',
      required: false,
    })
    .buildDefinition();
}
