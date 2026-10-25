# Universal Agent SDK (`@universal-agent/*`)

Run coding agents — Claude Code, Codex, DeepSeek, Kimi, Pi, Grok, Devin or any [ACP](https://agentclientprotocol.com) agent — from your own code, and orchestrate them with scripts into reliable workflows.

The SDK has two layers you can use separately:

- **Agent client** (`@universal-agent/client`): start and drive any supported agent over ACP from Node.js or Electron, with permissions, usage, steering, subagents and recorded conversations.
- **Workflow kit** (`@universal-agent/workflow-*`): describe a flow as a graph of agent, script and human steps; run it with review-driven loops, parallel items, safe concurrent edits to one repository, a supervising Chief agent, and a full record of every step. Use it through a web canvas, a CLI / HTTP API, or embedded in your own code.

📖 **Start here: [Workflow guide (中文)](docs/workflow-guide.md)** — every concept and how to use it, no source reading needed.

---

## Packages

| Package | What it is |
|---|---|
| [`@universal-agent/client`](packages/agent-client) | ACP host SDK: launch built-in or custom agents, stream updates, handle permissions, record conversations |
| [`@universal-agent/acp-extension-core`](packages/acp-extension-core) | ACP extension contracts shared by the client and the built-in adapters |
| [`@universal-agent/workflow-contract`](packages/workflow-contract) | Workflow definition schema, builder, conditions and compiler (runs in Node and browsers) |
| [`@universal-agent/workflow-runtime`](packages/workflow-runtime) | Scheduler and runtime: steps, loops, parallel items, isolation hooks, Chief, event-sourced run log |
| [`@universal-agent/workflow-node`](packages/workflow-node) | Node.js host: SQLite stores, agent and script executors, copy-on-write / git isolation, `ua-workflow` step CLI |
| [`@universal-agent/workflow-agents`](packages/workflow-agents) | Versioned agent profiles and the LLM Chief supervisor |
| [`@universal-agent/workflow-server`](packages/workflow-server) | HTTP server, `universal-agent-workflow` CLI, JS client and OpenAPI document |
| [`@universal-agent/workflow-ui`](packages/workflow-ui) | React components: canvas editor, inspector, run trace, Chief dock |
| [`@universal-agent/workflow-web`](packages/workflow-web) | The prebuilt web app served by the server |

Dependency order: `contract ← runtime ← node ← agents ← server`; `ui` builds on `contract` and `runtime`.

## Quick start

### Drive an agent

```ts
import { startAgentSession } from '@universal-agent/client';

const session = await startAgentSession({
  target: { cliType: 'builtin', agentType: 'claude' },
  workdir: process.cwd(),
  onUpdateMessage: ({ update }) => {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') process.stdout.write(update.content.text);
  },
  onRequestPermission: async (_id, request) => {
    const allow = request.options.find((o) => o.kind === 'allow_once');
    return { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } };
  },
});
await session.prompt([{ type: 'text', text: 'Summarize the project structure.' }]);
await session.shutdown();
```

See the [client README](packages/agent-client/README.md) for built-in agents, authentication and options.

### Run workflows with the web canvas and CLI

```bash
npm install -g @universal-agent/workflow-server
universal-agent-workflow --workdir ~/my-project          # http://127.0.0.1:4317

universal-agent-workflow run my-flow --input request='"Add a dark mode toggle"' --watch
universal-agent-workflow logs <runId>
universal-agent-workflow findings <runId>
```

### Embed workflows in your code

```ts
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createAgentWorkflowRuntime } from '@universal-agent/workflow-agents';

const flow = createWorkflowBuilder('fix-and-review')
  .addWorkflowInput({ name: 'request', type: 'string', required: true })
  .addAgent({ id: 'fix', name: 'Fix', role: 'developer', agentRef: 'dev', goal: 'Implement the request',
    inputs: [{ name: 'request', type: 'string', required: true }], writeScopes: ['src'] })
  .addAgent({ id: 'review', name: 'Review', role: 'reviewer', agentRef: 'dev', goal: 'Review the change', producesAssessment: true })
  .connectData({ fromNodeId: '$input', fromPort: 'request', toNodeId: 'fix', toPort: 'request' })
  .connectControl('fix', 'review')
  .loopBack('review', 'fix', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 3 })
  .setChief({})
  .buildDefinition();

const { runtime } = createAgentWorkflowRuntime({
  workdir: '/path/to/repo',
  agents: [{ id: 'dev', version: '1', name: 'Developer', charter: 'Writes and reviews code.', runtime: { adapter: 'acp', agentType: 'claude' } }],
});
const { runId } = await runtime.start({ definition: flow, inputs: { request: 'Add a dark mode toggle' } });
console.log((await runtime.runUntilSettled(runId)).status);
```

## What the workflow kit does

- **Graph of steps**: agent, script, human gate, parallel container, sub-flow; data edges pass values and versioned artifacts, control edges order steps and branch on verdicts or outputs (`port_compare`, `all` / `any`, `otherwise`).
- **Review-driven loops**: draw a way back from a reviewing step; it repeats while the condition holds, up to `maxRounds`, carrying the last round's output and feedback forward.
- **Parallel items**: run a step or an inline sub-flow for every item of a list, with bounded concurrency and per-item retries.
- **Safe concurrent edits**: writers work in copy-on-write clones or git worktrees, merge back three ways, pass a merge check, and redo once on a clash.
- **Chief**: a supervising agent that steps in on failures, stalled loops and questions, within a permission level; talk to it while a run is going.
- **Hand-over**: reviews can pass with minor findings, steps log known compromises, and `findings` collects everything still open for a person to finish.
- **Full record**: an append-only run log you can replay, step artifacts, assessments, workspace diffs, step data and every agent conversation.

## Documentation

| | |
|---|---|
| [Workflow guide (中文)](docs/workflow-guide.md) | Concepts, step types, conditions, loops, parallel, workspaces, data, Chief, run lifecycle, embedding |
| [Integration: CLI, HTTP API, step contracts](docs/workflow-integration.md) | Commands, exit codes, API flow, plugging your own process in |
| [OpenAPI document](docs/workflow-api.openapi.json) | The HTTP API, also served at `GET /api/openapi.json` |
| [Chief](docs/chief.md) · [Conversations](docs/conversations.md) · [Node parallel](docs/node-parallel.md) | Deep dives |
| [Releasing](docs/releasing.md) | Versioning, first publish and trusted publishing |
| [UPSTREAM.md](UPSTREAM.md) | Provenance of the client and adapters |

## Development

```bash
pnpm install
pnpm build        # every package, in dependency order
pnpm typecheck
pnpm test
pnpm dev:workflow # server + web app with live reload
```

Requires Node.js ≥ 22.13 (the workflow host uses `node:sqlite`) and pnpm 10.

## License

MIT — see [LICENSE](LICENSE).
