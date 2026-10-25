# @universal-agent/workflow-agents

The agent layer of the Universal Agent workflow kit, on top of [`@universal-agent/workflow-node`](../workflow-node):

- **Agent profiles**: versioned, reusable roles (engine, charter, rules, skills) stored in the workflow database, which steps reference with `agentRef`.
- **The LLM Chief**: a supervisor agent that reads a run's state and evidence and decides how to keep it moving, within the workflow's chief policy.

```bash
npm install @universal-agent/workflow-agents @universal-agent/workflow-contract
```

## Quick start

```ts
import { createAgentWorkflowRuntime } from '@universal-agent/workflow-agents';

const { runtime, registry, db } = createAgentWorkflowRuntime({
  workdir: '/path/to/repo',
  agents: [
    { id: 'dev', version: '1', name: 'Developer', charter: 'Implements changes carefully.',
      instructions: ['Keep changes minimal.', 'Run the tests before you finish.'],
      runtime: { adapter: 'acp', agentType: 'claude', modelId: 'sonnet' } },
    { id: 'critic', version: '1', name: 'Critic', charter: 'Reviews changes against the criteria.',
      instructions: ['Never edit files.'], runtime: { adapter: 'acp', agentType: 'codex' } },
  ],
});

// Steps use agentRef: 'dev' (latest version) or 'dev@1'; a definition with `chief` gets the LLM Chief.
const { runId } = await runtime.start({ definition, inputs: { request: 'Add a dark mode toggle' } });
await runtime.runUntilSettled(runId);
```

`createAgentWorkflowRuntime(options)` takes every option of `createNodeWorkflowRuntime`, plus:

| Option | Purpose |
|---|---|
| `agents` | Profiles to register before the runtime starts (idempotent per version) |
| `chief` | A custom `ChiefSupervisor`, or `false` to ignore chief policies (default: `AgentChiefSupervisor`) |

It returns `{ runtime, registry, db }`: the runtime, the `SqliteAgentRegistry` and the shared database (runs, artifacts and agents in one file).

## Agent profiles

```ts
{
  id: 'critic',                 // letters, digits, '_', '.', '-'
  version: '1',                 // immutable once registered: change a profile by registering a new version
  name: 'Critic',
  charter: 'Reviews changes…',  // rendered at the top of every task the agent gets
  instructions: ['…'],          // standing rules, kept verbatim
  skills: [],
  runtime: { adapter: 'acp', agentType: 'codex', modelId?: '…', modeId?: '…', effort?: 'high', options?: {} },
}
```

`SqliteAgentRegistry`: `register(profile)` (returns `{ created }`; the same version with different content is refused), `resolve('id' | 'id@version')`, `listAgents()`, `listVersions(id)`. A run pins the exact profile (by digest) the first time it uses it, so reruns and replays stay the same.

## The Chief

When a definition sets `chief` (see [`ChiefPolicySchema`](../workflow-contract)), the runtime wakes the supervisor on its triggers — a step failed, a loop round needs a fix, an agent asked a question, the run stalled, the budget ran out, or a person wrote to it. `AgentChiefSupervisor` runs the chief as an ordinary agent:

- it renders a briefing (`renderChiefBriefing`): the trigger, the run's steps and verdicts, recent events, and the evidence it may read (artifacts, findings, conversations);
- the chief replies with a ` ```ua-chief-decision ` block (`parseChiefDecision`): a rationale, an optional reply to the person, and commands — `report`, `inject_guidance`, `retry_node`, `rerun_from_node`, `swap_agent`, `answer_wait`, `extend_loop`, `escalate`;
- the runtime applies only commands within the policy's `maxLevel` and logs the rest as rejected.

With no `agentRef` in the policy the built-in **Default chief** plays it, on the engine most of the workflow's steps use. The chief is read-only and can never change acceptance criteria, verdicts or write scopes. Details and host options: [Chief](../../docs/chief.md).

## Related

[`@universal-agent/workflow-node`](../workflow-node) · [`@universal-agent/workflow-server`](../workflow-server) · [workflow guide](../../docs/workflow-guide.md)

## License

MIT
