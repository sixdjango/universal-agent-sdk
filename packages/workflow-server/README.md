# @universal-agent/workflow-server

Run Universal Agent workflows as a local service: an HTTP API with an OpenAPI document, the web canvas, the `universal-agent-workflow` CLI, and a small JS client — on the [`workflow-node`](../workflow-node) database.

```bash
npm install -g @universal-agent/workflow-server     # the CLI
# or, to embed or script it:
npm install @universal-agent/workflow-server
```

Requires Node.js ≥ 22.13 and, for agent steps, the agent CLIs installed and logged in.

## Start the server

```bash
universal-agent-workflow --workdir ~/my-project
# Universal Agent workflows: http://127.0.0.1:4317
```

| Option | Default | |
|---|---|---|
| `--port` | `4317` | |
| `--host` | `127.0.0.1` | Binding elsewhere lets other machines start agents that modify your files; there is no authentication |
| `--workdir` | current directory | Default workspace for workflows without workspace slots |
| `--home` | `$UNIVERSAL_AGENT_HOME` or `~/.universal-agent` | Data directory (database, blobs, worktrees) |
| `--allow-host` | | Extra `Host` header to accept (repeatable), e.g. behind a proxy |

The web app at the same address edits workflows (canvas, inspector, loops, containers, agents, workspaces) and follows runs (trace, live canvas, conversations, data, findings), with a Chief chat box, a Stop button, and "Fork from here" on finished steps. Runs left running when the server stopped are picked up again on start.

## Command line

The same binary talks to a running server (`--server <url>` or `$UA_WORKFLOW_SERVER`, default `http://127.0.0.1:4317`):

```bash
universal-agent-workflow workflows                           # saved workflows
universal-agent-workflow run <workflowId> \
  --input request='"Add a dark mode toggle"' \               # repeatable; JSON values are parsed
  --inputs inputs.json \
  --workspace main=./my-repo \                               # a directory (registered if new) or a workspace id
  --watch                                                    # follow it to the end
universal-agent-workflow status <runId>                      # status, every step (loop rounds, items), outputs
universal-agent-workflow logs <runId> [--no-follow]          # events; follows while the run is going
universal-agent-workflow findings <runId>                    # problems still open
universal-agent-workflow cancel <runId>
universal-agent-workflow fork <runId> --from <stepId> [--watch]  # new run from a step: earlier steps taken over,
                                                             # their changes merged onto the current HEAD
universal-agent-workflow runs [--workflow <id>] [--limit n]
universal-agent-workflow openapi > api.json                  # no server needed
```

`--json` prints machine-readable output (`logs --json`: one event per line). `run --watch` exits `0` succeeded, `1` failed, `2` cancelled, `3` waiting for an answer; usage errors exit `64`, an unreachable server `69` — handy in CI.

## HTTP API

The full description is served at `GET /api/openapi.json` (OpenAPI 3.1, request bodies generated from the server's own validation schemas, an `operationId` per operation) and checked into the repository as [`docs/workflow-api.openapi.json`](../../docs/workflow-api.openapi.json).

| Area | Endpoints |
|---|---|
| Workflows | `GET/POST /api/workflows`, `GET/PUT /api/workflows/{id}`, `PUT …/workspace-bindings`, `PUT …/layout` |
| Agents & engines | `GET/POST /api/agents`, `GET /api/runtimes`, `POST /api/runtimes/{agentType}/refresh` |
| Workspaces | `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/{id}` |
| Runs | `POST /api/runs`, `GET /api/runs`, `GET /api/runs/{id}`, `GET /api/runs/{id}/stream` (SSE), `POST …/respond`, `POST …/chief/messages`, `POST …/rerun`, `POST …/fork`, `POST …/cancel` |
| Evidence | `GET /api/runs/{id}/findings`, `GET /api/runs/{id}/data`, `GET /api/runs/{id}/conversations`, `GET /api/artifacts/{id}` |
| Conversations | `/api/conversations/…` (chats with agents outside workflows) |

The stream sends `log` events (one run-log entry each; reconnect with `Last-Event-ID` or `?after=<seq>`) and `activity` events (`{ active, chiefAnswering, liveProgress }`).

## JS client

A dependency-light client for the API (types only from the other packages):

```ts
import { WorkflowClient } from '@universal-agent/workflow-server/client';

const client = new WorkflowClient('http://127.0.0.1:4317');
await client.saveWorkflow(definition);
const { id: main } = await client.workspaceFor('/path/to/repo');
const { runId } = await client.startRun({ workflowId: definition.id, inputs: { request: '…' }, workspaces: { main } });

for await (const item of client.followRun(runId)) {
  if (item.type === 'log' && item.entry.mutation.kind === 'event.emitted') console.log(item.entry.mutation.event.type);
  if (item.type === 'activity' && !item.active) break;
}
console.log((await client.getRun(runId)).run.status, await client.listFindings(runId));
```

Also: `listWorkflows`, `getWorkflow`, `listRuns`, `cancelRun`, `forkRun(runId, { nodeId, inputs?, workspaces? })`, `respond`, `messageChief`, `listWorkspaces`, `openApi`. Errors are `WorkflowClientError` with the HTTP `status` (0 when the server is unreachable).

## Embedding

```ts
import { createDefaultWorkflowServer } from '@universal-agent/workflow-server';

const server = await createDefaultWorkflowServer({ workdir: process.cwd() }); // agents, Chief, web app, SQLite
await server.app.listen({ port: 4317, host: '127.0.0.1' });
```

`createWorkflowServer({ runtime, db, registry, … })` builds the same Fastify app around a runtime you assemble yourself; `server.host` is the underlying `WorkflowHost` and `server.routes` lists every route. `buildOpenApiDocument()`, `runCommand()` and the request schemas are exported too.

## Related

[`@universal-agent/workflow-node`](../workflow-node) · [`@universal-agent/workflow-agents`](../workflow-agents) · [`@universal-agent/workflow-ui`](../workflow-ui) · [workflow guide](../../docs/workflow-guide.md) · [integration](../../docs/workflow-integration.md)

## License

MIT
