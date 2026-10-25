import {
  type ChiefDecision,
  type ChiefPolicyInput,
  ChiefPolicySchema,
  createBoundedFixLoopFlow,
  createWorkflowBuilder,
  DEFAULT_CHIEF_AGENT_REF,
  type WorkflowDefinition,
} from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type ChiefReviewInput,
  type ChiefSupervisor,
  createWorkflowRuntime,
  DeterministicClock,
  foldRunLog,
  InMemoryAgentRegistry,
  InMemoryRuntimeStore,
  SequentialIdGenerator,
  type WorkflowRunState,
} from '../src/index';

const SCRIPT_UNUSED = async () => {
  throw new Error('unused');
};

function nodeStatuses(state: WorkflowRunState, scopeKey = '$root'): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state.scopes[scopeKey]!.nodes).map(([id, n]) => [id, n.status])
  );
}

function singleAgentFlow(options: { agentRef?: string; chief?: ChiefPolicyInput } = {}) {
  const builder = createWorkflowBuilder('single-agent')
    .addWorkflowOutput({ name: 'result', type: 'string', required: true })
    .addAgent({
      id: 'worker',
      name: 'Worker',
      role: 'worker',
      ...(options.agentRef ? { agentRef: options.agentRef } : {}),
      goal: 'Do the task',
      outputs: [{ name: 'result', type: 'string', required: true }],
    })
    .connectData({ fromNodeId: 'worker', fromPort: 'result', toNodeId: '$output', toPort: 'result' });
  if (options.chief) builder.setChief(options.chief);
  return builder.buildDefinition();
}

/** Scripted chief: returns queued decisions in order and records what it was shown. */
class ScriptedChief implements ChiefSupervisor {
  readonly seen: ChiefReviewInput[] = [];
  private readonly decide: (input: ChiefReviewInput) => ChiefDecision;

  constructor(decide: (input: ChiefReviewInput) => ChiefDecision) {
    this.decide = decide;
  }

  async review(input: ChiefReviewInput): Promise<ChiefDecision> {
    this.seen.push(input);
    return this.decide(input);
  }
}

function makeRuntime(options: {
  executeAgent: (req: AgentExecutionRequest) => Promise<AgentExecutionResult>;
  registry?: InMemoryAgentRegistry;
  chief?: ChiefSupervisor;
  adapters?: Record<string, { executeAgent: (req: AgentExecutionRequest) => Promise<AgentExecutionResult> }>;
}) {
  const clock = new DeterministicClock();
  const store = new InMemoryRuntimeStore(clock);
  const runtime = createWorkflowRuntime({
    store,
    clock,
    idGenerator: new SequentialIdGenerator(),
    executor: { executeAgent: options.executeAgent, executeScript: SCRIPT_UNUSED },
    ...(options.registry ? { agentRegistry: options.registry } : {}),
    ...(options.chief ? { chief: options.chief } : {}),
    ...(options.adapters ? { adapters: options.adapters } : {}),
  });
  return { runtime, store };
}

async function runToEnd(
  runtime: ReturnType<typeof createWorkflowRuntime>,
  definition: WorkflowDefinition,
  inputs?: Record<string, unknown>
) {
  const started = await runtime.start({ definition, ...(inputs ? { inputs } : {}) });
  return runtime.runUntilSettled(started.runId);
}

describe('scheduler regressions', () => {
  it('skips a node whose required input comes from a skipped branch instead of hanging', async () => {
    const definition = createWorkflowBuilder('skip-propagation')
      .addAgent({ id: 'a', name: 'a', role: 'x', goal: 'a', outputs: [{ name: 'out', type: 'json', required: true }] })
      .addAgent({ id: 'b', name: 'b', role: 'x', goal: 'b', outputs: [{ name: 'out', type: 'json', required: true }] })
      .addAgent({ id: 'c', name: 'c', role: 'x', goal: 'c', inputs: [{ name: 'x', type: 'json', required: true }] })
      .connectControl('a', 'b', { kind: 'verdict_is', verdict: 'NEEDS_FIX' })
      .connectControl('a', 'c')
      .connectData({ fromNodeId: 'b', fromPort: 'out', toNodeId: 'c', toPort: 'x', withControl: true })
      .buildDefinition();
    const { runtime } = makeRuntime({
      executeAgent: async (req) => ({
        status: 'COMPLETED',
        outputs: { out: req.node.id },
        ...(req.node.id === 'a' ? { assessment: { verdict: 'PASS', summary: 'ok' } } : {}),
      }),
    });

    const done = await runToEnd(runtime, definition);
    expect(done.status).toBe('SUCCEEDED');
    expect(nodeStatuses(done)).toEqual({ a: 'SUCCEEDED', b: 'SKIPPED', c: 'SKIPPED' });
  });

  it('keeps independent branches running while a gate waits', async () => {
    const definition = createWorkflowBuilder('gate-independent')
      .addGate({ id: 'g', name: 'g', prompt: 'ok?' })
      .addAgent({ id: 'a', name: 'a', role: 'x', goal: 'a' })
      .addAgent({ id: 'a2', name: 'a2', role: 'x', goal: 'a2' })
      .connectControl('a', 'a2')
      .buildDefinition();
    const { runtime } = makeRuntime({ executeAgent: async () => ({ status: 'COMPLETED' }) });

    const paused = await runToEnd(runtime, definition);
    expect(paused.status).toBe('WAITING');
    expect(nodeStatuses(paused)).toEqual({ g: 'WAITING', a: 'SUCCEEDED', a2: 'SUCCEEDED' });
  });
});

describe('agents', () => {
  it('delegates to a pinned agent profile, renders its charter, and stamps attempts', async () => {
    const registry = new InMemoryAgentRegistry([
      {
        id: 'backend-dev',
        name: 'Backend Dev',
        charter: 'Owns the HTTP API layer.',
        instructions: ['Run contract tests before handing off.'],
      },
    ]);
    const requests: AgentExecutionRequest[] = [];
    const { runtime, store } = makeRuntime({
      registry,
      executeAgent: async (req) => {
        requests.push(req);
        // A newer version registered mid-run must not leak into this run.
        registry.register({ id: 'backend-dev', version: '2', name: 'Backend Dev v2', charter: 'Different.' });
        return { status: 'COMPLETED', outputs: { result: 'done' } };
      },
    });

    const done = await runToEnd(runtime, singleAgentFlow({ agentRef: 'backend-dev' }));
    expect(done.status).toBe('SUCCEEDED');

    const req = requests[0]!;
    expect(req.agent?.agentId).toBe('backend-dev');
    expect(req.agent?.version).toBe('1');
    expect(req.renderedPrompt).toContain('# You are Backend Dev (backend-dev@1)');
    expect(req.renderedPrompt).toContain('Owns the HTTP API layer.');
    expect(req.renderedPrompt).toContain('- Run contract tests before handing off.');
    expect(req.manifest.agent?.digest).toMatch(/^sha256:/);

    const pinned = done.pinnedAgents['backend-dev']!;
    expect(pinned.version).toBe('1');
    const attempt = done.attempts[done.scopes.$root!.nodes.worker!.latestAttemptId!]!;
    expect(attempt.agent).toEqual({
      ref: 'backend-dev',
      agentId: 'backend-dev',
      version: '1',
      digest: pinned.digest,
    });
    expect(foldRunLog(await store.readLog(done.runId))).toEqual(done);
  });

  it('inherits a container default agent and routes to the profile adapter', async () => {
    const registry = new InMemoryAgentRegistry([
      { id: 'api-bot', name: 'API Bot', charter: 'Talks to a model API directly.', runtime: { adapter: 'direct-api' } },
    ]);
    const directCalls: string[] = [];
    const flow = createBoundedFixLoopFlow({
      id: 'loop-default-agent',
      maxRounds: 1,
      authorGoal: 'Write it',
      acceptanceCriteria: ['Works'],
    });
    const loop = flow.graph.nodes.find((n) => n.id === 'fix_loop')!;
    if (loop.kind === 'loop') loop.defaultAgentRef = 'api-bot';

    const { runtime } = makeRuntime({
      registry,
      executeAgent: async () => {
        throw new Error('default executor must not be used for direct-api agents');
      },
      adapters: {
        'direct-api': {
          executeAgent: async (req) => {
            directCalls.push(`${req.node.id}:${req.agent?.ref}`);
            return req.node.id === 'reviewer'
              ? { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'fine' } }
              : { status: 'COMPLETED', artifacts: { candidate: { content: 'code' } } };
          },
        },
      },
    });

    const done = await runToEnd(runtime, flow, { specification: 'spec' });
    expect(done.status).toBe('SUCCEEDED');
    expect(directCalls).toEqual(['author:api-bot', 'reviewer:api-bot']);
  });

  it('fails the node when its agent is unknown or its adapter is missing', async () => {
    const registry = new InMemoryAgentRegistry([
      { id: 'remote', name: 'Remote', charter: 'x', runtime: { adapter: 'nowhere' } },
    ]);
    const { runtime } = makeRuntime({ registry, executeAgent: async () => ({ status: 'COMPLETED' }) });

    const unknown = await runToEnd(runtime, singleAgentFlow({ agentRef: 'ghost' }));
    expect(unknown.status).toBe('FAILED');
    expect(unknown.scopes.$root!.nodes.worker!.error).toContain('Agent "ghost" is not registered');

    const noAdapter = await runToEnd(runtime, singleAgentFlow({ agentRef: 'remote' }));
    expect(noAdapter.status).toBe('FAILED');
    expect(noAdapter.scopes.$root!.nodes.worker!.error).toContain('requires adapter "nowhere"');
  });

  it('rejects malformed agent refs at compile time', async () => {
    const { runtime } = makeRuntime({ executeAgent: async () => ({ status: 'COMPLETED' }) });
    await expect(
      runtime.start({ definition: singleAgentFlow({ agentRef: 'bad ref!' }) })
    ).rejects.toThrow(/INVALID_AGENT_REF/);
  });
});

describe('chief agent', () => {
  const registry = () =>
    new InMemoryAgentRegistry([
      { id: 'junior', name: 'Junior', charter: 'Learning.' },
      { id: 'senior', name: 'Senior', charter: 'Experienced.' },
      { id: 'lead', name: 'Lead', charter: 'Keeps runs on track.' },
    ]);

  const juniorFailsSeniorSucceeds = async (req: AgentExecutionRequest): Promise<AgentExecutionResult> => {
    if (req.agent?.agentId === 'junior') throw new Error('junior got stuck');
    return { status: 'COMPLETED', outputs: { result: `by ${req.agent?.agentId}` } };
  };

  it('swaps the agent and retries a failed node', async () => {
    const chief = new ScriptedChief((input) =>
      input.trigger.kind === 'node.failed'
        ? {
            rationale: 'Junior is stuck; hand it to senior',
            commands: [
              { kind: 'swap_agent', nodeId: 'worker', agentRef: 'senior' },
              { kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' },
            ],
          }
        : { rationale: '', commands: [] }
    );
    const { runtime, store } = makeRuntime({ registry: registry(), chief, executeAgent: juniorFailsSeniorSucceeds });

    const done = await runToEnd(runtime, singleAgentFlow({ agentRef: 'junior', chief: { agentRef: 'lead' } }));
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.result).toBe('by senior');
    expect(chief.seen[0]?.chiefAgent?.agentId).toBe('lead');

    const intervention = done.events.find((e) => e.type === 'chief.intervened');
    expect(intervention).toMatchObject({ trigger: 'node.failed', rejected: [] });
    expect(intervention && 'applied' in intervention ? intervention.applied : []).toHaveLength(2);
    expect(done.chief.interventionCount).toBe(1);
    expect(Object.keys(done.pinnedAgents).sort()).toEqual(['junior', 'lead', 'senior']);
    expect(foldRunLog(await store.readLog(done.runId))).toEqual(done);
  });

  it('plays the built-in chief on the engine most of the flow runs on when the policy names no agent', async () => {
    const chief = new ScriptedChief((input) =>
      input.trigger.kind === 'node.failed'
        ? { rationale: 'Hand it to senior', commands: [{ kind: 'swap_agent', nodeId: 'worker', agentRef: 'senior' }, { kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' }] }
        : { rationale: '', commands: [] }
    );
    const engines = new InMemoryAgentRegistry([
      { id: 'junior', name: 'Junior', charter: 'Learning.', runtime: { adapter: 'acp', agentType: 'deepseek', modelId: 'flash', modeId: 'agent' } },
      { id: 'senior', name: 'Senior', charter: 'Experienced.', runtime: { adapter: 'acp', agentType: 'claude' } },
    ]);
    const workerFails = async (req: AgentExecutionRequest): Promise<AgentExecutionResult> =>
      req.node.id === 'worker' ? juniorFailsSeniorSucceeds(req) : { status: 'COMPLETED' };
    const { runtime, store } = makeRuntime({ registry: engines, chief, executeAgent: workerFails });
    const definition = createWorkflowBuilder('engines')
      .addWorkflowOutput({ name: 'result', type: 'string', required: true })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', agentRef: 'junior', goal: 'Do it', outputs: [{ name: 'result', type: 'string', required: true }] })
      .addAgent({ id: 'check', name: 'Check', role: 'worker', agentRef: 'junior', goal: 'Check it' })
      .addAgent({ id: 'other', name: 'Other', role: 'worker', agentRef: 'senior', goal: 'Something else' })
      .connectData({ fromNodeId: 'worker', fromPort: 'result', toNodeId: '$output', toPort: 'result' })
      .setChief({})
      .buildDefinition();

    const done = await runToEnd(runtime, definition);
    expect(done.status).toBe('SUCCEEDED');
    const played = chief.seen[0]?.chiefAgent;
    expect(played?.ref).toBe(DEFAULT_CHIEF_AGENT_REF);
    expect(played?.profile.name).toBe('Default chief');
    // Two steps run on deepseek, one on claude; the step's mode is not carried over.
    expect(played?.profile.runtime).toEqual({ adapter: 'acp', agentType: 'deepseek', modelId: 'flash' });
    expect(done.pinnedAgents[DEFAULT_CHIEF_AGENT_REF]?.digest).toBe(played?.digest);
    expect(foldRunLog(await store.readLog(done.runId))).toEqual(done);
  });

  it('leaves the chief to the host default agent when no step names an engine', async () => {
    const chief = new ScriptedChief(() => ({ rationale: '', commands: [] }));
    const { runtime } = makeRuntime({ chief, executeAgent: async () => { throw new Error('stuck'); } });
    await runToEnd(runtime, singleAgentFlow({ chief: {} }));
    expect(chief.seen.length).toBeGreaterThan(0);
    expect(chief.seen[0]?.chiefAgent).toBeUndefined();
  });

  it('rejects commands above the policy level and never touches what counts as done', async () => {
    const chief = new ScriptedChief(() => ({
      rationale: 'Try to retry',
      commands: [{ kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' }],
    }));
    const { runtime } = makeRuntime({ registry: registry(), chief, executeAgent: juniorFailsSeniorSucceeds });

    const done = await runToEnd(
      runtime,
      singleAgentFlow({ agentRef: 'junior', chief: { maxLevel: 'advise' } })
    );
    expect(done.status).toBe('FAILED');
    const intervention = done.events.find((e) => e.type === 'chief.intervened');
    expect(intervention && 'rejected' in intervention ? intervention.rejected[0]?.reason : '').toContain(
      'policy caps at "advise"'
    );
  });

  it('injects guidance into the next loop round', async () => {
    const authorPrompts: string[] = [];
    let authorCalls = 0;
    const chief = new ScriptedChief((input) =>
      input.trigger.kind === 'loop.round_needs_fix'
        ? {
            rationale: 'Same finding twice is likely; point at the root cause',
            commands: [{ kind: 'inject_guidance', nodeId: 'author', text: 'Check operator precedence first.' }],
          }
        : { rationale: '', commands: [] }
    );
    const flow = createBoundedFixLoopFlow({ id: 'guided-loop', maxRounds: 3, authorGoal: 'Write add', acceptanceCriteria: ['a + b'] });
    flow.chief = ChiefPolicySchema.parse({});
    const { runtime } = makeRuntime({
      chief,
      executeAgent: async (req) => {
        if (req.node.id === 'author') {
          authorCalls += 1;
          authorPrompts.push(req.renderedPrompt);
          return { status: 'COMPLETED', artifacts: { candidate: { content: `v${authorCalls}` } } };
        }
        return {
          status: 'COMPLETED',
          assessment:
            authorCalls === 1
              ? { verdict: 'NEEDS_FIX', summary: 'wrong', findings: [{ id: 'f', severity: 'major', message: 'fix it' }] }
              : { verdict: 'PASS', summary: 'ok' },
        };
      },
    });

    const done = await runToEnd(runtime, flow, { specification: 'spec' });
    expect(done.status).toBe('SUCCEEDED');
    expect(authorPrompts[0]).not.toContain('Guidance From The Chief Agent');
    expect(authorPrompts[1]).toContain('## Guidance From The Chief Agent\n- Check operator precedence first.');
    const roundOneManifest = Object.values(done.manifests).find(
      (m) => m.nodeId === 'author' && m.scopeKey.endsWith(':round_1')
    );
    expect(roundOneManifest?.chiefGuidance).toEqual(['Check operator precedence first.']);
  });

  it('extends an exhausted loop within the policy cap', async () => {
    let reviews = 0;
    const chief = new ScriptedChief((input) =>
      input.trigger.kind === 'node.failed' && input.trigger.nodeId === 'fix_loop'
        ? {
            rationale: 'One more round should do it',
            commands: [
              { kind: 'extend_loop', scopeKey: '$root', nodeId: 'fix_loop', extraRounds: 5 },
              { kind: 'extend_loop', scopeKey: '$root', nodeId: 'fix_loop', extraRounds: 1 },
            ],
          }
        : { rationale: '', commands: [] }
    );
    const flow = createBoundedFixLoopFlow({ id: 'extend-loop', maxRounds: 1, authorGoal: 'Write', acceptanceCriteria: ['ok'] });
    flow.chief = ChiefPolicySchema.parse({ maxLoopRoundExtension: 2 });
    const { runtime } = makeRuntime({
      chief,
      executeAgent: async (req) => {
        if (req.node.id === 'author') return { status: 'COMPLETED', artifacts: { candidate: { content: 'c' } } };
        reviews += 1;
        return {
          status: 'COMPLETED',
          assessment: reviews === 1 ? { verdict: 'NEEDS_FIX', summary: 'not yet' } : { verdict: 'PASS', summary: 'ok' },
        };
      },
    });

    const done = await runToEnd(runtime, flow, { specification: 'spec' });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.chief.loopExtensions['$root/fix_loop']).toBe(1);
    const intervention = done.events.find((e) => e.type === 'chief.intervened');
    expect(intervention && 'rejected' in intervention ? intervention.rejected[0]?.reason : '').toContain(
      'above maxLoopRoundExtension 2'
    );
  });

  it('answers an agent question without bothering a human', async () => {
    const chief = new ScriptedChief((input) =>
      input.trigger.kind === 'wait.requested'
        ? {
            rationale: 'Low-risk naming question',
            commands: [{ kind: 'answer_wait', requestId: input.trigger.requestId!, answer: 'Use camelCase' }],
          }
        : { rationale: '', commands: [] }
    );
    const answers: string[] = [];
    const { runtime } = makeRuntime({
      chief,
      executeAgent: async (req) => {
        if (!req.humanAnswer) {
          return { status: 'WAIT_REQUESTED', waitRequest: { prompt: 'camelCase or snake_case?' } };
        }
        answers.push(`${String(req.humanAnswer.answer)} (${req.humanAnswer.responderId})`);
        return { status: 'COMPLETED', outputs: { result: 'named' } };
      },
    });

    const done = await runToEnd(runtime, singleAgentFlow({ chief: {} }));
    expect(done.status).toBe('SUCCEEDED');
    expect(answers).toEqual(['Use camelCase (chief:supervisor)']);
  });

  it('escalates to a human and acts on the answer', async () => {
    const chief = new ScriptedChief((input) => {
      if (input.trigger.kind === 'node.failed') {
        return { rationale: 'Unsure whether to spend senior time', commands: [{ kind: 'escalate', prompt: 'Retry with senior?' }] };
      }
      if (input.trigger.kind === 'escalation.resolved' && input.trigger.detail.includes('yes')) {
        return {
          rationale: 'Human approved',
          commands: [
            { kind: 'swap_agent', nodeId: 'worker', agentRef: 'senior' },
            { kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' },
          ],
        };
      }
      return { rationale: '', commands: [] };
    });
    const { runtime } = makeRuntime({ registry: registry(), chief, executeAgent: juniorFailsSeniorSucceeds });

    const paused = await runToEnd(runtime, singleAgentFlow({ agentRef: 'junior', chief: {} }));
    expect(paused.status).toBe('WAITING');
    const escalation = paused.waitRequests[paused.chief.pendingEscalationId!]!;
    expect(escalation.prompt).toBe('Retry with senior?');

    const done = await runtime.respond({
      runId: paused.runId,
      requestId: escalation.requestId,
      answer: 'yes',
      responderId: 'owner',
    });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.outputs.result).toBe('by senior');
    expect(done.chief.pendingEscalationId).toBeUndefined();
  });

  it('stops consulting the chief after maxInterventionsPerRun', async () => {
    const chief = new ScriptedChief(() => ({
      rationale: 'keep retrying',
      commands: [{ kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' }],
    }));
    const { runtime } = makeRuntime({ registry: registry(), chief, executeAgent: juniorFailsSeniorSucceeds });

    const done = await runToEnd(
      runtime,
      singleAgentFlow({ agentRef: 'junior', chief: { maxInterventionsPerRun: 3 } })
    );
    expect(done.status).toBe('FAILED');
    expect(chief.seen).toHaveLength(3);
    expect(done.chief.interventionCount).toBe(3);
  });
});
