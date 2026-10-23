import {
  compileWorkflowDefinition,
  createBoundedFixLoopFlow,
} from '@universal-agent/workflow-contract';
import { createNodeWorkflowRuntime } from '@universal-agent/workflow-node';

/**
 * Example: Multi-Agent Bounded Fix Loop (`Author -> Script Test -> Independent Reviewer`)
 * using `@universal-agent/workflow-contract` and `@universal-agent/workflow-node`.
 */
async function main() {
  const definition = createBoundedFixLoopFlow({
    id: 'feature-fix-loop',
    name: 'Claude Author + Test Script + Codex Reviewer Loop',
    maxRounds: 3,
    authorRole: 'author',
    authorAgentType: 'claude',
    reviewerRole: 'reviewer',
    reviewerAgentType: 'codex',
    authorGoal: 'Implement the requested TypeScript module and ensure all tests pass.',
    acceptanceCriteria: [
      'All exported functions have strict TypeScript types',
      'Unit test suite exits with code 0',
    ],
    verifyScript: {
      command: 'pnpm',
      args: ['test'],
      timeoutMs: 60_000,
    },
  });

  const plan = compileWorkflowDefinition(definition);
  console.log('Compiled workflow digest:', plan.definitionDigest);
  console.log('Root topological order:', plan.rootScope.topologicalOrder);
  console.log(
    'Loop body topological order:',
    plan.rootScope.childScopes.fix_loop?.topologicalOrder
  );

  // Create a Node workflow runtime backed by SQLite (`~/.universal-agent/workflow/workflow.db`,
  // or `$UNIVERSAL_AGENT_HOME/workflow/workflow.db`) and `@universal-agent/client`
  const runtime = createNodeWorkflowRuntime({
    workdir: process.cwd(),
    roleBindings: {
      author: { agentType: 'claude' },
      reviewer: { agentType: 'codex' },
    },
  });

  if (process.argv.includes('--run')) {
    const started = await runtime.start({
      definition: plan,
      inputs: {
        specification: 'Implement a retry backoff helper in src/retry.ts',
      },
    });
    const finalState = await runtime.runUntilSettled(started.runId);
    console.log('Workflow finished with status:', finalState.status);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
