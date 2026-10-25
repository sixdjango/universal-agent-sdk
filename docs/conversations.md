# Conversations

`ConversationService` is an optional chat runtime in `@universal-agent/client`. It wraps the existing ACP `startAgentSession` path and adds a persistent FIFO queue, exclusive session ownership, permission waits, complete message records and explicit crash recovery. `ConversationRecorder` lets externally scheduled Agent calls use the same records and queries. The Flow Executor uses this recorder; graphs, node kinds, scheduling and the existing `ManagedAgentSession` API stay intact.

## Direct SDK use

```ts
import { ConversationService } from '@universal-agent/client';

const chats = new ConversationService(); // Memory storage; inject a store for durability.
const conversation = await chats.create({
  agent: { agentType: 'claude', workdir: '/path/to/project' },
  extensions: { 'my-product.task': { issueId: 'TASK-42' } },
});
const unsubscribe = chats.subscribe(conversation.id, event => {
  // Emitted after commit. Use event.sequence to resume a durable event cursor.
  console.log(event);
});
const turn = await chats.send(conversation.id, {
  content: [{ type: 'text', text: 'Review this project.' }],
  idempotencyKey: 'submission-42',
});
// send() returns as soon as the input is stored; execution continues in the background.
// Respond to any pending permissions from another UI/API handler (see below).
const result = await chats.waitForTurn(conversation.id, turn.id);
console.log(result.status, await chats.getMessages(conversation.id, turn.id));
unsubscribe();
await chats.shutdown();
```

The memory store is for embedding/tests without persistence. The default durable Node assembly uses the existing SDK database and needs no Flow or server:

```ts
import { openWorkflowDatabase, createNodeConversationService } from '@universal-agent/workflow-node';

const db = openWorkflowDatabase('/path/to/sdk.db');
const chats = createNodeConversationService({
  db,
  // Resolve credentials and host callbacks when connecting. Do not put secrets in metadata.
  resolveSessionOptions: () => ({ dataDir: '/path/to/agent-data' }),
});
// create/send/query/respondPermission/recover/resume use the same interface.
await chats.shutdown();
db.$client.close(); // Caller owns the database.
```

`WorkflowHost.conversations` and the standalone server use this SQLite assembly. `ConversationStore` can be replaced by an external product's database without importing `workflow-node` or `workflow-server`. Implement `commit` as an atomic compare-and-swap of the conversation revision, changed turns and appended events, with unique turn numbers and idempotency keys per conversation. The memory and SQLite implementations provide examples.

## Message model and extensions

ACP already defines text, image, audio, embedded resource, resource link, thought, plan and tool events. A tool result updates the same `toolCallId`; it is not a second tool invocation. Conversation records preserve full content blocks, tool `rawInput`/`rawOutput` (including arrays, scalars and large values), diffs, terminal references and `_meta`. Permission requests/responses and Client usage, goal, image-generation and other extension callbacks are also recorded. Unsupported display events remain available as typed event messages or raw events.

`getMessages(id, turnId)` projects one complete turn into content, tool, plan and event messages. Streaming text remains an array of content blocks so annotations/metadata are retained. `store.readEvents(id, { after, limit, turnId })` returns exact ordered deltas with `nextCursor`; `store.listTurns` pages turn metadata. The existing lossy `SessionHistoryEntry` view stays unchanged for compatibility. A terminal reference is a reference, not a promise to archive terminal bytes that the Agent never emitted.

Conversation and turn `extensions`, appended message `extensions`, and custom events are JSON namespaces owned by the host:

```ts
type SymphonyData = { 'symphony.task': { taskId: string; projectId: string } };
const extensions: SymphonyData = {
  'symphony.task': { taskId: 'T-1', projectId: 'P-1' },
};
await chats.update(conversation.id, { extensions });
await chats.appendCustomEvent(conversation.id, {
  namespace: 'symphony', name: 'review.completed', data: { approved: true },
}, turn.id);
await chats.appendMessage(conversation.id, {
  role: 'system', content: [{ type: 'text', text: 'Review attached by the host.' }],
  extensions: { 'symphony.review': { reviewId: 'R-1' } },
}, turn.id);
```

Hosts can compose/intersect exported record/message types and build their own projections. Extensions cannot override core IDs, sequence or status. The optional immutable `source: { namespace, identifiers }` provides indexed host correlation; `store.list({ source })` matches the namespace and every supplied identifier. Identifiers are nonempty strings. The core does not interpret host identifiers. Invalid/lossy JSON values such as functions, cycles, `Infinity` and `Date` objects are rejected rather than silently altered. `undefined` object properties are omitted as in ACP JSON encoding.

## Flow Agent recordings

`createNodeWorkflowRuntime` automatically records built-in ACP Agent calls in the same SQLite database used by `WorkflowHost.conversations`. A directly constructed `UniversalAgentExecutor` defaults to a public `conversationStore` in memory; inject a durable store to retain history across restarts. Custom Agent adapters are responsible for using the recorder themselves.

Each actual Executor call creates a fresh `mode: 'recording'` Conversation with one turn. Technical retries can reuse Flow's `attemptId` and `invocationId`, so each call has its own conversation/turn IDs and an explicit zero-based `retryIndex`. Its immutable `workflow` source also contains `runId`, `scopeKey`, `nodeId`, and the existing `roundIndex` when present. Parallel items and loop rounds retain their own scope identities. This adds correlation fields to execution requests and receipts, without changing the graph contract or retry policy.

```ts
import { createNodeConversationService, listWorkflowConversations } from '@universal-agent/workflow-node';

const conversations = createNodeConversationService({ db });
const calls = await listWorkflowConversations(conversations.store, {
  runId, nodeId: 'worker', // Optional: scopeKey, attemptId, invocationId, retryIndex, roundIndex.
  limit: 100,             // Continue with afterId: calls.at(-1)?.id.
});
for (const call of calls) {
  const [turn] = (await conversations.store.listTurns(call.id)).items;
  console.log(call.source, turn.status, turn.permissions);
  console.log(await conversations.getMessages(call.id, turn.id));
}
```

Successful Flow receipts include `conversationId` and `conversationTurnId`. Query by source to find **all** retries, startup failures and cancellations: those calls may never produce a successful Flow receipt. Lists sort by conversation ID for pagination; use `source.identifiers.retryIndex` or timestamps for display ordering. With custom storage, pass the same `ConversationStore` to `createNodeWorkflowRuntime({ conversationStore })` and `WorkflowHost.open({ conversationOptions: { store } })` (or the corresponding server options).

The recorder captures the submitted prompt (including a resolved human answer), raw ACP messages/tools, permission requests and decisions, usage and other session callbacks. Startup/load replay is recorded with `origin: 'replay'` outside the current turn so resumed history cannot be mistaken for new tool calls. A resumed native session still creates a fresh execution record and records `resumedFrom` on its attachment event.

Flow keeps ownership of scheduling, retries, cancellation and human waits. Existing permission policies, including the Executor's default read-only policy, stay in effect; requests and responses are persisted around that policy. Pending permissions can be queried, while decisions continue through the configured Flow permission callback. Chat queue/control APIs reject recording conversations with a conflict. Recording writes do not pass through `ConversationService.send` or its queue/lease machinery. Flow recorder events are read through the durable cursor/SSE; they are not emitted by a separate `ConversationService.subscribe` instance.

Only a normal `end_turn` **and** successful Executor validation/cleanup produce a completed recording. Truncation, refusal, disconnected streams, startup failure and shutdown failure retain their partial transcripts and terminal reason. Cancellation also cancels pending permission waits; retries never overwrite previous calls. A Flow human wait can follow a completed Agent turn. Later scheduler validation or workspace settlement is represented by Flow's attempt state, not by rewriting the already finished Agent transcript.

This recorder does not introduce a second crash-recovery driver for Flow. An abrupt process death can leave a nonterminal partial recording; its source identifies the owning Flow execution for reconciliation. Chat `recover` cannot take over or re-execute it. The independent chat recovery behavior below applies to chat conversations only.

## Flow execution details in the web UI

Open an Agent node's execution details from **Trace** or the run **Canvas**, then select **Conversation**. The Execution selector shows each actual call separately, with its initial/retry number and terminal status. It defaults to the latest call; selecting an older call keeps that call selected during refresh. Run, scope and node identity prevent parallel items and loop rounds from mixing. The graph and node layout are unchanged.

The transcript includes the submitted input, assistant messages and thoughts, plans, tool inputs/outputs and updates, permission requests and decisions, and failure/cancellation reasons. Multimodal blocks, resource contents, diffs and terminal references are retained. Session events, resumed-session replay and the full ordered event log can be expanded for inspection. Replay is not presented as a new call. Permission decisions and retries remain owned by Flow; this view is read-only.

Call lists and events follow every page. Only the selected call's transcript is loaded; open recordings refresh with an incremental event cursor. Closing details or changing calls aborts pending reads. Partial history is retained on connection errors, with an error message and Refresh action. Text is scrollable without character truncation; large raw JSON is rendered when expanded. The selected transcript is still materialized in browser memory. Historical executions without recorder data show an explicit empty state.

Embedded frontends can supply a `ConversationReader` to `TraceView` or render the reusable component directly:

```tsx
import { NodeConversation, type ConversationReader } from '@universal-agent/workflow-ui';
import '@universal-agent/workflow-ui/styles.css';

// reader implements list/get/turns/events against the host's read APIs, forwarding AbortSignal.
function History({ reader }: { reader: ConversationReader }) {
  return <NodeConversation reader={reader}
    target={{ runId: 'run-1', scopeKey: '$root', nodeId: 'worker' }} live={false} />;
}
```

`@universal-agent/client/conversation` exports browser-safe Conversation types and `projectConversationMessages`. The chat service, recorder and Node launcher remain on the main SDK entry; the UI uses the shared projection without bundling those runtimes. The standalone web app injects a reader for the existing server routes below; no conversation state machine moves into the server or frontend.

## Queue, ownership and permissions

- `send` persists before sending. Only one turn runs at a time. Identical idempotency keys return the existing turn; different content/options/extensions with the same key are rejected, even after restart. Completed requests are never re-executed by a retry.
- `pause` stops subsequent sends, leaving the active turn alone. `resume` continues queued turns. Normal `end_turn` advances the queue; cancellation, truncation, refusal and failure pause it.
- `cancel(id, turnId)` can cancel an unsent turn or the active turn. Active cancellation shuts down the native connection to prevent late output being assigned to another turn. Subsequent execution resumes the saved native session, subject to the Agent's capabilities.
- An owner holds a persisted lease (default 30 seconds, heartbeat every 10 seconds). Acquisition tokens and revision checks fence stale writers. A live lease cannot be stolen. Set matching lease/heartbeat durations for your storage latency; no work should outlive a failed event writer.
- Permissions default to waiting. Read the active turn's `permissions` or observe `permission.requested`, then call `respondPermission(id, permission.id, { outcome: { outcome: 'selected', optionId } })`. Only an offered option or `cancelled` is accepted. Response metadata is preserved for structured elicitation answers. The response is stored before resolving the native RPC.
- Hosts may supply `onPermission` for an explicit automatic policy; return `undefined` to leave the request waiting. An existing `onRequestPermission` supplied by `resolveSessionOptions` is used if `onPermission` is absent. Cancellation resolves outstanding requests as cancelled. A policy error stops the session.

Native session options, permissions and tools still use the existing Client. Agent input/turn execution is not a Flow checkpoint or a filesystem transaction. No token ceiling is added. Message contents are not clipped; pagination bounds query rows. The pending event writer has a configurable event-count limit (default 1024) to stop a slow/broken store from consuming unbounded memory; hitting it stops execution and surfaces an error rather than dropping events. `getMessages` materializes a full turn, so use paged events for very large turns.

## Disconnect and crash recovery

`disconnect(id)` stops the owned native connection, marks any active turn interrupted, pauses the queue, and releases the lease while keeping history. `shutdown()` does this for all sessions owned by the service. `close(id)` also cancels queued turns and permanently closes that conversation. History remains queryable.

After process death, wait for the old lease to expire and call `recover(id)`. It marks any started turn `interrupted`, expires unresolved permission requests, and leaves unsent turns paused. Inspect the partial result and workspace, then call `resume(id)` to send only never-started turns. Recovery does not repeat started prompts, automatically answer permissions, or roll back files/tool effects. The SDK cannot forcibly stop a foreign/orphaned process; the embedding host must reconcile such processes before continuing external work.

Reconnection uses the recorded native session ID. If the Agent cannot load/resume it, or returns a different ID, connection fails and the queue remains paused with a `connection_error` event. There is no fallback that silently creates a new conversation. Core recovery and cross-process fencing are tested; actual resume support remains engine-dependent. Lease fencing does not make external tools exactly-once.

Only `end_turn` records `completed`. ACP cancellation records `cancelled`, token/request truncation `truncated`, refusal `refused`, missing response `interrupted`, and thrown/unknown failures `failed`. Partial text and tools remain queryable in every case. A storage error cannot publish an uncommitted success; the session stops and may require recovery after the store is repaired.

Subscriptions deliver committed events produced by the current service instance. Cross-process readers and reconnecting consumers must use the durable event cursor. `waitForTurn` waits for a terminal turn (or local fatal storage/ownership error); queued/paused turns can wait indefinitely, so pass an `AbortSignal` when needed.

## Standalone server

The existing standalone server exposes these routes and uses the same `host.conversations` service. It retains its existing request guards and transport limits; core state transitions stay in the SDK. The web app includes the read-only Flow execution history above; an independent chat composer is outside this integration.

| Route | Operation |
| --- | --- |
| `POST /api/conversations` | Create `{ agent: { agentType, workdir, ... }, title?, extensions? }` |
| `GET /api/conversations?afterId=&limit=` | List conversations |
| `GET /api/runs/:id/conversations` | List Flow Agent calls; optional `nodeId`, `scopeKey`, `attemptId`, `invocationId`, `retryIndex`, `roundIndex`, `afterId`, `limit` |
| `GET/PATCH /api/conversations/:id` | Query/update title and extension namespaces |
| `POST /api/conversations/:id/turns` | Enqueue `{ content, idempotencyKey?, promptOptions?, extensions? }`; returns 202 |
| `GET /api/conversations/:id/turns?after=&limit=` | Page turns |
| `GET /api/conversations/:id/turns/:turnId` | Turn metadata and complete message projection |
| `POST /api/conversations/:id/turns/:turnId/cancel` | Cancel a turn |
| `GET /api/conversations/:id/permissions` | Pending permissions |
| `POST /api/conversations/:id/permissions/:permissionId/respond` | Respond with the ACP response object |
| `POST /api/conversations/:id/connect\|pause\|resume\|recover\|disconnect\|close` | Lifecycle/queue controls |
| `GET /api/conversations/:id/events?after=&limit=&turnId=` | Page durable events |
| `POST /api/conversations/:id/events` | Append `{ namespace, name, data, turnId? }` |
| `GET /api/conversations/:id/stream` | SSE, `event: conversation`, `id: sequence`; supports `Last-Event-ID` |

The migrations add `conversations`, `conversation_turns`, `conversation_events` and the generic `conversation_sources` index table. Existing Flow tables/data are not rewritten. Recording starts with new executions; historical transcripts absent from the old Client/Flow records cannot be reconstructed. The ordinary Agent Executor records directly through the SDK and remains controlled by Flow.
