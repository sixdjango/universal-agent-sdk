import { describe, expect, it } from 'vitest';
import {
  compileWorkflowDefinition,
  computeDefinitionDigest,
  computeDownstreamSubgraph,
  createAuthorReviewerFlow,
  createBoundedFixLoopFlow,
  createHumanDecisionGateFlow,
  createParallelFanOutFlow,
  createSerializedWriterReverifyFlow,
  createSingleTaskFlow,
  createWorkflowBuilder,
  validateWorkflowDefinition,
  WorkflowCompilationError,
} from '../src/index';

describe('@universal-agent/workflow-contract: Hierarchical DAG Compiler & Pattern Builders', () => {
  it('compiles all 6 standard workflow patterns into valid Hierarchical DAG plans with deterministic digests', () => {
    const singleFlow = createSingleTaskFlow({
      id: 'flow-single',
      goal: 'Generate architecture report',
      acceptanceCriteria: ['Includes module diagram'],
    });
    const singlePlan = compileWorkflowDefinition(singleFlow);
    expect(singlePlan.definitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(singlePlan.rootScope.topologicalOrder).toEqual(['worker']);

    const authorReviewerFlow = createAuthorReviewerFlow({
      id: 'flow-author-reviewer',
      authorGoal: 'Implement feature X',
      acceptanceCriteria: ['All edge cases handled'],
    });
    const arPlan = compileWorkflowDefinition(authorReviewerFlow);
    expect(arPlan.rootScope.topologicalOrder).toEqual(['author', 'reviewer']);

    const fixLoopFlow = createBoundedFixLoopFlow({
      id: 'flow-fix-loop',
      maxRounds: 3,
      authorGoal: 'Implement feature X',
      acceptanceCriteria: ['Tests pass', 'No lint errors'],
      verifyScript: {
        command: 'pnpm',
        args: ['test'],
      },
    });
    const loopPlan = compileWorkflowDefinition(fixLoopFlow);
    expect(loopPlan.rootScope.topologicalOrder).toEqual(['fix_loop']);
    expect(loopPlan.rootScope.childScopes.fix_loop?.topologicalOrder).toEqual([
      'author',
      'verify',
      'reviewer',
    ]);

    const parallelFlow = createParallelFanOutFlow({
      id: 'flow-parallel',
      workerGoal: 'Audit single module',
      reducerGoal: 'Combine module audits',
    });
    const parallelPlan = compileWorkflowDefinition(parallelFlow);
    expect(parallelPlan.rootScope.topologicalOrder).toEqual(['fan_out', 'reducer']);
    expect(parallelPlan.rootScope.childScopes.fan_out?.topologicalOrder).toEqual(['item_worker']);

    const serializedWritersFlow = createSerializedWriterReverifyFlow({
      id: 'flow-writers',
      sharedWriteScope: 'src/shared',
      firstWriterGoal: 'Update types',
      secondWriterGoal: 'Update implementation',
      verifierCommand: 'pnpm',
      verifierArgs: ['typecheck'],
    });
    const writersPlan = compileWorkflowDefinition(serializedWritersFlow);
    expect(writersPlan.rootScope.writeScopeConflicts.writer_a).toEqual(['writer_b']);
    expect(writersPlan.rootScope.writeScopeConflicts.writer_b).toEqual(['writer_a']);

    const gateFlow = createHumanDecisionGateFlow({
      id: 'flow-gate',
      plannerGoal: 'Draft migration plan',
      gatePrompt: 'Approve migration execution?',
      executorGoal: 'Run migration',
    });
    const gatePlan = compileWorkflowDefinition(gateFlow);
    expect(gatePlan.rootScope.topologicalOrder).toEqual(['planner', 'approval_gate', 'executor']);
  });

  it('produces identical canonical digests regardless of node/edge/port insertion order', () => {
    const flowA = createWorkflowBuilder('canonical-test', 'Canonical Test')
      .addWorkflowInput({ name: 'b_in', type: 'string', required: true })
      .addWorkflowInput({ name: 'a_in', type: 'string', required: true })
      .addAgent({
        id: 'node_2',
        name: 'Node 2',
        role: 'reviewer',
        goal: 'Review',
        writeScopes: ['src/b', 'src/a'],
        inputs: [{ name: 'in1', type: 'string', required: true }],
        outputs: [{ name: 'out2', type: 'string', required: true }],
      })
      .addAgent({
        id: 'node_1',
        name: 'Node 1',
        role: 'author',
        goal: 'Write',
        inputs: [{ name: 'a_in', type: 'string', required: true }],
        outputs: [{ name: 'out1', type: 'string', required: true }],
      })
      .connectData({
        id: 'e2',
        fromNodeId: 'node_1',
        fromPort: 'out1',
        toNodeId: 'node_2',
        toPort: 'in1',
        withControl: true,
      })
      .connectData({
        id: 'e1',
        fromNodeId: '$input',
        fromPort: 'a_in',
        toNodeId: 'node_1',
        toPort: 'a_in',
      })
      .buildDefinition();

    const flowB = createWorkflowBuilder('canonical-test', 'Canonical Test')
      .addWorkflowInput({ name: 'a_in', type: 'string', required: true })
      .addWorkflowInput({ name: 'b_in', type: 'string', required: true })
      .addAgent({
        id: 'node_1',
        name: 'Node 1',
        role: 'author',
        goal: 'Write',
        inputs: [{ name: 'a_in', type: 'string', required: true }],
        outputs: [{ name: 'out1', type: 'string', required: true }],
      })
      .addAgent({
        id: 'node_2',
        name: 'Node 2',
        role: 'reviewer',
        goal: 'Review',
        writeScopes: ['src/a', 'src/b'],
        inputs: [{ name: 'in1', type: 'string', required: true }],
        outputs: [{ name: 'out2', type: 'string', required: true }],
      })
      .connectData({
        id: 'e1',
        fromNodeId: '$input',
        fromPort: 'a_in',
        toNodeId: 'node_1',
        toPort: 'a_in',
      })
      .connectData({
        id: 'e2',
        fromNodeId: 'node_1',
        fromPort: 'out1',
        toNodeId: 'node_2',
        toPort: 'in1',
        withControl: true,
      })
      .buildDefinition();

    expect(computeDefinitionDigest(flowA)).toBe(computeDefinitionDigest(flowB));
  });

  it('rejects cycles, missing required input bindings, and data edges violating control flow order', () => {
    // 1. Cycle in control edges
    const cyclic = createWorkflowBuilder('cyclic')
      .addAgent({ id: 'a', name: 'A', role: 'worker', goal: 'A' })
      .addAgent({ id: 'b', name: 'B', role: 'worker', goal: 'B' })
      .connectControl('a', 'b')
      .connectControl('b', 'a')
      .buildDefinition();

    const cyclicRes = validateWorkflowDefinition(cyclic);
    expect(cyclicRes.ok).toBe(false);
    if (!cyclicRes.ok) {
      expect(cyclicRes.issues.some((i) => i.code === 'CYCLE_DETECTED')).toBe(true);
    }

    // 2. Missing required input port binding
    const unbound = createWorkflowBuilder('unbound')
      .addAgent({
        id: 'a',
        name: 'A',
        role: 'worker',
        goal: 'A',
        inputs: [{ name: 'missingPort', type: 'string', required: true }],
      })
      .buildDefinition();

    expect(() => compileWorkflowDefinition(unbound)).toThrowError(WorkflowCompilationError);

    // 3. Data edge without a control path (or reverse order)
    const reverseData = createWorkflowBuilder('reverse-data')
      .addAgent({
        id: 'a',
        name: 'A',
        role: 'worker',
        goal: 'A',
        outputs: [{ name: 'out', type: 'string', required: true }],
      })
      .addAgent({
        id: 'b',
        name: 'B',
        role: 'worker',
        goal: 'B',
        inputs: [{ name: 'in', type: 'string', required: true }],
      })
      .connectData({
        fromNodeId: 'a',
        fromPort: 'out',
        toNodeId: 'b',
        toPort: 'in',
        withControl: false,
      })
      .buildDefinition();

    const reverseRes = validateWorkflowDefinition(reverseData);
    expect(reverseRes.ok).toBe(false);
    if (!reverseRes.ok) {
      expect(reverseRes.issues.some((i) => i.code === 'DATA_EDGE_ORDER_VIOLATION')).toBe(true);
    }
  });

  it('computes exact reachable downstream subgraphs for incremental invalidation', () => {
    const plan = createWorkflowBuilder('diamond-graph')
      .addWorkflowInput({ name: 'seed', type: 'string', required: true })
      .addAgent({
        id: 'root',
        name: 'Root',
        role: 'planner',
        goal: 'Plan',
        inputs: [{ name: 'seed', type: 'string', required: true }],
        outputs: [
          { name: 'leftSpec', type: 'string', required: true },
          { name: 'rightSpec', type: 'string', required: true },
        ],
      })
      .addAgent({
        id: 'left_branch',
        name: 'Left Branch',
        role: 'author',
        goal: 'Left',
        inputs: [{ name: 'spec', type: 'string', required: true }],
        outputs: [{ name: 'leftOut', type: 'artifact', required: true }],
      })
      .addAgent({
        id: 'right_branch',
        name: 'Right Branch',
        role: 'author',
        goal: 'Right',
        inputs: [{ name: 'spec', type: 'string', required: true }],
        outputs: [{ name: 'rightOut', type: 'artifact', required: true }],
      })
      .addAgent({
        id: 'join_review',
        name: 'Join Review',
        role: 'reviewer',
        goal: 'Review both',
        inputs: [
          { name: 'leftOut', type: 'artifact', required: true },
          { name: 'rightOut', type: 'artifact', required: true },
        ],
        outputs: [{ name: 'verdict', type: 'assessment', required: true }],
      })
      .connectData({ fromNodeId: '$input', fromPort: 'seed', toNodeId: 'root', toPort: 'seed' })
      .connectData({
        fromNodeId: 'root',
        fromPort: 'leftSpec',
        toNodeId: 'left_branch',
        toPort: 'spec',
        withControl: true,
      })
      .connectData({
        fromNodeId: 'root',
        fromPort: 'rightSpec',
        toNodeId: 'right_branch',
        toPort: 'spec',
        withControl: true,
      })
      .connectData({
        fromNodeId: 'left_branch',
        fromPort: 'leftOut',
        toNodeId: 'join_review',
        toPort: 'leftOut',
        withControl: true,
      })
      .connectData({
        fromNodeId: 'right_branch',
        fromPort: 'rightOut',
        toNodeId: 'join_review',
        toPort: 'rightOut',
        withControl: true,
      })
      .compile();

    // Modifying `left_branch` only invalidates `join_review`, NOT `right_branch` or `root`!
    const affectedByLeft = computeDownstreamSubgraph(plan.rootScope, ['left_branch']);
    expect(affectedByLeft).toEqual(['join_review']);

    // Modifying `root` invalidates `left_branch`, `right_branch`, and `join_review` in topological order
    const affectedByRoot = computeDownstreamSubgraph(plan.rootScope, ['root']);
    expect(affectedByRoot).toEqual(['left_branch', 'right_branch', 'join_review']);
  });
});
