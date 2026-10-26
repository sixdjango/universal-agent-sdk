# @universal-agent/workflow-node

The Node.js host of the Universal Agent workflow kit: a ready-to-run [`workflow-runtime`](../workflow-runtime) with SQLite storage, an agent executor built on [`@universal-agent/client`](../agent-client), a script executor, copy-on-write / git isolation for concurrent writers, step tools (`ua-workflow` CLI and MCP), conversation recording, and `WorkflowHost` — everything a product needs to offer workflows as a service, without any HTTP layer.

```bash
npm install @universal-agent/workflow-node @universal-agent/workflow-contract
```

Requires Node.js ≥ 22.13 (`node:sqlite`). Agent steps need the agent CLIs installed and logged in (see the [client README](../agent-client/README.md#authentication)).

## Quick start

```ts
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createNodeWorkflowRuntime } from '@universal-agent/workflow-node';

const flow = createWorkflowBuilder('lint-then-fix')
  .addScript({ id: 'lint', name: 'Lint', command: 'npx', args: ['eslint', 'src'] }) // exit 0 → PASS, else NEEDS_FIX
  .addAgent({ id: 'fix', name: 'Fix lint errors', role: 'developer', agentType: 'claude',
    goal: 'Run `npx eslint src` and fix every error it reports.', writeScopes: ['src'] })
  .connectControl('lint', 'fix', { kind: 'verdict_is', verdict: 'NEEDS_FIX' })
  .buildDefinition();

const runtime = createNodeWorkflowRuntime({ workdir: '/path/to/repo' });
const { runId } = await runtime.start({ definition: flow });
const done = await runtime.runUntilSettled(runId);
console.log(done.status, await runtime.getOpenFindings(runId));
```

Need agent profiles and the LLM Chief too? Use `createAgentWorkflowRuntime` from [`@universal-agent/workflow-agents`](../workflow-agents), which takes the same options.

## `createNodeWorkflowRuntime(options)`

| Option | Purpose |
|---|---|
| `workdir` | Default directory for steps when a run binds no workspace (required) |
| `homeDir` / `db` | Data directory (default `$UNIVERSAL_AGENT_HOME` or `~/.universal-agent`) or an already-open database |
| `roleBindings` | Which engine plays a role when a step has no `agentRef`: `{ reviewer: { agentType: 'codex', modelId: '…' } }` (also by step id; a binding can launch a `target` such as a custom ACP command) |
| `defaultTarget` | Engine for steps nothing else resolves |
| `env`, `agentDataDir` | Environment for agents and scripts; agents' data directory |
| `onRequestPermission` | Override how agent tool permissions are answered (default: allow, except writes by read-only steps) |
| `agentRegistry`, `adapters`, `chief`, `chiefOptions`, `chiefPermissions` | Agent profiles, extra adapters, supervisor and its tool limits |
| `parallelOptions.maxConcurrency` | Host cap per parallel batch |
| `conversationStore`, `artifactTools`, `captureChanges`, `clock`, `idGenerator` | Advanced overrides |

It returns a `WorkflowRuntime` (see [workflow-runtime](../workflow-runtime#workflowruntime-methods)) whose `nodeData`, `artifacts` and `store` live in SQLite.

## Agent steps

`UniversalAgentExecutor` launches the step's agent with `@universal-agent/client` in the step's workspace (or its isolated copy) and:

- sends the rendered prompt (agent charter and rules, goal, criteria, inputs, workspace, feedback, output contract);
- mounts the `ua-workflow` MCP server and puts the `ua-workflow` CLI on the agent's `PATH`;
- refuses file edits for steps without `writeScopes`; the chief is read-only;
- records the full conversation (every message, thought, tool call and permission) per attempt, retry, loop round and parallel item;
- parses the ` ```ua-workflow-result ` block (`outputs`, `artifacts`, `assessment`, `waitRequest`) and captures the workspace diff as the step's `changes`.

Engine resolution, first match wins:

1. `roleBindings[<step id>]`;
2. the step's `agentType`, when it differs from its agent profile's engine;
3. the agent profile (`agentRef`, or a container's `defaultAgentRef`): `roleBindings[<agent id>]` if set (executable path, env), else the profile's `runtime`;
4. `roleBindings[<role>]`;
5. the step's `agentType` / `modelId` / `modeId`;
6. `defaultTarget`;
7. the role name used as the engine name (e.g. `role: 'claude'`).

## Script steps

`NodeScriptExecutor` runs `command` + `args` in the step's workspace (`cwd` relative to it):

| Variable | Contents |
|---|---|
| `UA_INPUT_<PORT>` | Path of a file holding that input (text as is, other values as JSON); `<PORT>` is the port name upper-cased, non-alphanumerics as `_` |
| `UA_INPUTS_FILE` | All inputs as one JSON file |
| `UA_OUTPUTS_FILE` | Write `{ "outputs": {…}, "artifacts": { "name": { "content": "…", "mediaType": "…" } }, "assessment": { "verdict": "PASS", "summary": "…", "findings": [] } }` here |
| `PATH` | Includes `ua-workflow` |

Without an assessment, a script with `producesAssessment` (the default) passes on exit code 0 and needs a fix otherwise. Logs longer than 16 KB are kept as artifacts.

## Step tools: `ua-workflow` and MCP

Inside a step (agent shell or script):

```bash
ua-workflow data put <collection> <key> [json]     # save (stdin when no value)
ua-workflow data append <collection> [json]        # add a record with a generated key
ua-workflow data get <collection> <key> [--node <stepId>]
ua-workflow data list [--collection c] [--node id] # --shared: the run's shared data
ua-workflow inputs                                 # what this step was given
ua-workflow artifact read <id> [--offset n --max n --section heading]
ua-workflow issue "<problem and fix>" [--severity minor --file path --line n]
ua-workflow findings                               # everything still open in the run
```

Agents get the same as MCP tools on the `ua-workflow` server: `data_put`, `data_append`, `data_get`, `data_list`, `list_context_inputs`, `read_artifact`, `log_issue`, `list_findings`.

## Workspaces and isolation

- A run binds each workspace slot to a directory. Steps with `writeScopes` write there; overlapping scopes queue.
- Steps that may write at the same time as others (or `isolation: 'worktree'`) work in a private copy: an APFS copy-on-write clone of the whole repository on macOS (dependencies and build output included), a git worktree elsewhere. The workspace must be a git repository.
- When a copy finishes, its changes merge three ways into the workspace as it is by then (`git merge-tree`), never touching the index. If others changed it meanwhile and the slot declares a `mergeCheck` command, that command runs on the merged code in the copy first.
- A clash (conflict or failed check) redoes the step once in a fresh copy, telling the agent what clashed and where its earlier changes are (`git show <branch>`); a second clash fails the step and keeps its changes on that branch.
- Each step's recorded changes keep the git trees before and after (`changes.trees`), so they can be replayed later: `replayWorkspaceChanges(dir, changes)` merges them three-way onto a working tree in order, binary files included, falling back to the recorded diff when the trees are gone; nothing is written unless all of them land (`ChangeReplayError` otherwise).
- `LocalWorkspaceManager`, `forkWorkspace`, `snapshotWorkingTree`, `diffTrees` and `replayWorkspaceChanges` are exported for custom hosts.

## `WorkflowHost`

The transport-free service layer the HTTP server is built on:

```ts
import { createAgentWorkflowRuntime } from '@universal-agent/workflow-agents';
import { createWorkflowHost } from '@universal-agent/workflow-node';

const { runtime, db } = createAgentWorkflowRuntime({ workdir: process.cwd() });
const host = await createWorkflowHost({ runtime, db, workdir: process.cwd() });

host.library.save(definition, { mode: 'upsert' });           // saved workflows
const workspace = await host.workspaces.create({ path: '/path/to/repo' });
const run = await host.startRun({ workflowId: definition.id, workspaces: { main: workspace.id } });
// host.runs: get, list, readLog, respond, messageChief, cancel, rerunFromNode, fork, resumeInterrupted, isActive

// A new run from a step: the latest saved definition, fresh worktrees at the current HEAD with the
// earlier steps' changes merged on, the step and what follows run again (conflict → WorkflowHostError 'conflict').
const forked = await host.forkRun({ sourceRunId: run.runId, nodeId: 'review', inputs: { tone: 'formal' } });
// host.conversations: the ConversationService for chats and recorded agent calls
await host.close();
```

`RunService` drives each run in the background with a per-run queue and a database lease, so several processes can share one database without driving the same run; runs left `RUNNING` by a crash are picked up again (`resumeInterrupted`).

## Storage

`<home>/workflow/workflow.db` (SQLite via Drizzle; migrations ship in `drizzle/` and `drizzle-host/` and run on open):

- the run log, snapshots and projections (node states, attempts, assessments, context manifests, edge deliveries, wait requests, chief interventions);
- artifacts (content deduplicated by sha256; above 1 MB in `<home>/workflow/blobs/`);
- step data and issues (`node_data`), conversations, the workflow library, workspaces and leases.

`openWorkflowDatabase(path)`, `resolveWorkflowStoragePaths(home)` and the `Sqlite*Store` classes are exported.

## Related

[`@universal-agent/workflow-agents`](../workflow-agents) (profiles, Chief) · [`@universal-agent/workflow-server`](../workflow-server) (HTTP, CLI, web app) · [workflow guide](../../docs/workflow-guide.md) · [conversations](../../docs/conversations.md)

## License

MIT
