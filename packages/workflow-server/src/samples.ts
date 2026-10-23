import {
  type AgentProfileInput,
  createWorkflowBuilder,
  type WorkflowDefinition,
} from '@universal-agent/workflow-contract';

/** Starter agents so a fresh install has something to assign. */
export const SAMPLE_AGENTS: readonly AgentProfileInput[] = [
  {
    id: 'builder',
    name: 'Builder',
    charter: 'Turns a feature request into a working change with tests.',
    instructions: ['Keep changes small and explain trade-offs in the summary.'],
    runtime: { adapter: 'acp', agentType: 'deepseek' },
  },
  {
    id: 'critic',
    name: 'Critic',
    charter: 'Independently reviews changes against the acceptance criteria.',
    instructions: ['Cite the exact criterion each finding violates.'],
    runtime: { adapter: 'acp', agentType: 'deepseek' },
  },
];

/** Author -> independent review -> human sign-off -> release notes. */
export function createSampleWorkflow(): WorkflowDefinition {
  return createWorkflowBuilder('feature-with-review', 'Feature with review')
    .setDescription('Build a change, review it independently, and ship after sign-off')
    .addWorkflowInput({ name: 'request', type: 'string', required: true })
    .addWorkflowOutput({ name: 'notes', type: 'artifact', required: true })
    .addAgent({
      id: 'build',
      name: 'Build the change',
      role: 'author',
      agentRef: 'builder',
      goal: 'Implement the requested feature',
      acceptanceCriteria: ['The feature works as requested', 'Tests cover the new behaviour'],
      writeScopes: ['src', 'test'],
      inputs: [{ name: 'request', type: 'string', required: true }],
      outputs: [{ name: 'change', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'review',
      name: 'Independent review',
      role: 'reviewer',
      agentRef: 'critic',
      goal: 'Review the change against the request',
      acceptanceCriteria: ['The feature works as requested', 'Tests cover the new behaviour'],
      producesAssessment: true,
      inputs: [
        { name: 'request', type: 'string', required: true },
        { name: 'change', type: 'artifact', required: true },
      ],
      outputs: [{ name: 'assessment', type: 'assessment', required: true }],
    })
    .addGate({
      id: 'signoff',
      name: 'Ship it?',
      prompt: 'The review passed. Ship this change?',
      options: [
        { value: 'ship', label: 'Ship', description: 'Write release notes and finish' },
        { value: 'hold', label: 'Hold', description: 'Stop here for now' },
      ],
      outputs: [{ name: 'decision', type: 'string', required: true }],
    })
    .addAgent({
      id: 'notes',
      name: 'Release notes',
      role: 'author',
      agentRef: 'builder',
      goal: 'Write short release notes for the change',
      inputs: [{ name: 'change', type: 'artifact', required: true }],
      outputs: [{ name: 'notes', type: 'artifact', required: true }],
    })
    .connectData({ fromNodeId: '$input', fromPort: 'request', toNodeId: 'build', toPort: 'request' })
    .connectData({ fromNodeId: '$input', fromPort: 'request', toNodeId: 'review', toPort: 'request' })
    .connectData({ fromNodeId: 'build', fromPort: 'change', toNodeId: 'review', toPort: 'change', withControl: true })
    .connectControl('review', 'signoff', { kind: 'verdict_is', verdict: 'PASS' })
    .connectControl('signoff', 'notes', { kind: 'port_equals', port: 'decision', value: 'ship' })
    .connectData({ fromNodeId: 'build', fromPort: 'change', toNodeId: 'notes', toPort: 'change' })
    .connectData({ fromNodeId: 'notes', fromPort: 'notes', toNodeId: '$output', toPort: 'notes' })
    .setChief({ maxLevel: 'escalate' })
    .buildDefinition();
}
