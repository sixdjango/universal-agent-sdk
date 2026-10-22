# acp-extension-dsh

ACP session controls and a pinned coding profile for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The package is a Cordis plugin, not a replacement for Harness. It adds ACP model,
reasoning-effort, permission, and agent-preset selectors, accepts inline images
when the selected model declares image input (the default `deepseek-flash` / DeepSeek-V41-Flash does), and mounts ACP-provided stdio or
Streamable HTTP MCP servers into each Harness Agent scope. Harness
continues to own model execution, sandbox enforcement, persistence, preset
composition, tool execution, and one-shot approvals.

With bilateral Core `subagentEvents` v1, scoped Harness `subagent/start` and
`subagent/end` events establish owned executions. Local descendants stream
committed assistant messages, live reasoning and the existing rich tool projection;
non-local runs expose lifecycle and final summaries only. Scope-carrier identity,
not tool titles, establishes ancestry. Child approvals keep run-scoped tool IDs on
the root ACP connection; delegated questionnaires remain outside the root bridge.
Core subagent list/output requests address the emitted run IDs and never expose
foreign sessions. Local runs support cancellation; remote runs expose final output
only and reject cancellation. Queries retain runs observed during this activation,
not a reconstructed historical roster. Core 0.1.9 supplies the shared contracts.

The adapter advertises Core's `_meta.lody.compaction` capability and translates
Harness `compaction/start` and `compaction/end` events into a standard ACP tool
lifecycle carrying `_meta.lody.activity`. Manual and automatic compaction remain
distinguishable, and failed compactions keep the Harness error reason.
Committed assistant images are read back through the attachment store and sent as
ACP image blocks. Tool results use Harness 0.2's tool-role messages: call identity
and error state live on the message, alongside the result content. Native V4
migration normalizes older persisted wrappers before replay. Prompt completion and cancellation wait for admission, Harness
idle, and ordered output delivery before releasing the session's prompt slot.

ACP model choices are discovered from Harness when each session is created and
returned through both the standard `model` config option and the legacy ACP
`models` response. Exact per-model metadata controls the reasoning selector and
image admission, and the legacy response carries `model[effort]` entries so a
host can cache the reasoning choices for every model rather than only the model
that happened to be active during the probe. Permission choices use the composed
Harness preset table.
When `DEEPSEEK_BASE_URL` is set, the adapter requests its OpenAI-compatible
`GET /models` endpoint once per ACP connection, resolves every advertised id
through Harness, and selects the first result initially. Discovery is bounded,
does not follow redirects, and reports an actionable startup failure when the
endpoint cannot provide a usable list. Without an endpoint, the Harness catalog
remains advisory: an explicitly configured or selected model is still resolved
even when it is not listed.

The official Messages base URL is `https://api.deepseek.com/anthropic`.
Legacy official roots (`https://api.deepseek.com` and `/v1`) and versioned
Messages roots normalize to it before native provider construction. Settings
`llm-deepseek.baseURL` still takes precedence over the environment; neither the
settings file nor the host environment is rewritten. Official model discovery
uses `https://api.deepseek.com/models`, independently of the Messages path, and
all official aliases retain official usage pricing. Custom endpoints keep their
path and must support Messages for inference plus OpenAI-compatible `/models`
for discovery. OpenAI Chat-only routes belong under `llm-pi-ai` instead.

Harness is pinned to **0.2.1-rc.2** (npm `next` at upgrade time; `latest` still
points to the older 0.0.1-rc.1). Native model discovery hides routes without
credentials; the configured model remains selectable even when unlisted. The ACP profile
reads `llm-deepseek`, `llm-pi-ai`, and `agent-presets.default` from
`$DSH_HOME/settings.yaml`, falling back to `~/.dsh/settings.yaml`. Model sections
feed native provider Config schemas. Missing settings preserve defaults; malformed
documents reject ACP initialization. The native settings migration is disabled:
it would rename the shared file and move settings into a generated profile.
This bridge never rewrites or renames the user's settings.
The `llm-deepseek.models` array replaces the local catalog in full, so retain any
default models and their vision metadata that should remain selectable. For example:

```yaml
llm-deepseek:
  models:
    - id: deepseek-flash
      name: DeepSeek-V41-Flash
      inputModalities: [text, image]
    - id: deepseek-v4-flash
      name: DeepSeek-V4-Flash
    - id: deepseek-v4-pro
      name: DeepSeek-V4-Pro
    - id: deepseek-v4-flash-vision-exp
      name: DeepSeek-V4-Flash-Vision-Exp
      inputModalities: [text, image]
    - id: custom-model
      name: Custom model
```

Settings are read at startup and ACP model choices are cached per connection.
Reconnect and refresh the host's model capabilities after catalog edits.
`DEEPSEEK_BASE_URL` still selects endpoint discovery: this setting does not merge
local-only model IDs into an endpoint's `/models` response. API credentials remain
in the host environment; generated compositions contain no credentials.

The host also mounts `dsh-llm-pi-ai` with an empty base profile. It remains dormant
until `settings.yaml` adds a supported route, for example alongside the unchanged
DeepSeek configuration:

```yaml
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: shared-model
          name: Shared model
          contextWindow: 65536
          maxTokens: 4096
```

`apiKeyEnv` is a reference resolved by Harness for each request. The key itself is
not copied into settings, the generated profile, ACP capability data, or Lody's
workspace state. Removing a route or leaving its named credential unavailable fails
that selection explicitly; the adapter does not switch back to DeepSeek. Reconnect
and refresh capabilities after changing the route catalog.

## Token and USD accounting

Core's usage capability reports committed request usage, cumulative per-model
totals and already-included deltas. The pinned Harness supplies usage
on `assistant/message` and actual route metadata on `request/context`; raw stream
chunks are not counted again. No model request or transcript is needed by tests.
Only reported activity in the ACP-owned Harness session is counted; separate
background agents or internal operations without usage events are not invented.

Official [DeepSeek prices](https://api-docs.deepseek.com/quick_start/pricing/),
checked directly on 2026-09-13, are estimated per request at completion time.
Off-peak USD/million tokens (cache miss / hit / output): Flash 0.15 / 0.003 / 0.6;
V4 Pro 0.66 / 0.022 / 1.98. Weekday 01:00–04:00 and 06:00–10:00 UTC are twice
those rates. `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` now alias the
new `deepseek-flash` price. Unknown models/custom endpoints have no estimated cost.
These are list-price estimates, not invoices; cross-boundary requests can differ.
Only the registered `deepseek-official` route at the official endpoint is priced;
an arbitrary provider named `deepseek` is not evidence of official billing.
The adapter consumes the published Core 0.1.9 contract.

## Exports

- `acp-extension-dsh` exports the Cordis plugin: `apply`, `inject`, and `name`.
- `acp-extension-dsh/capabilities` exports the selector vocabulary for host UIs.
- `acp-extension-dsh/profile` exports the pinned Harness version, the
  same-release npx package closure, and `createDeepSeekHarnessProfileFiles`,
  which renders the generated `dsh` profile files.

The host launches the pinned `dsh` executable with
`--profile lody-acp`, writing the generated profile (the `@deepseek-ai/dsh-base`
bundle plus the Lody `cordis.patch.yml` overlay) under
`$DSH_HOME/profiles/lody-acp`. It stages this package's official
`standard`/`ptc`/`minimal`/`cordis` preset snapshot beside the ACP adapter.
The adapter registers the upstream declarations in the native registry and retains
legacy user declarations (`preset.yml` plus `agent.cordis.yml`) below
`$DSH_HOME/.agent-presets`. Built-in names take precedence. Unavailable configured
defaults fall back to usable Standard mode; explicit selections remain strict.
Harness binds the selected preset revision per session. MCP tools use Harness's native
`mcp__<server>__<tool>` naming and are removed with their owning ACP session.

The generated profile defaults session persistence to upstream's `zstd`
encoding. A host that reuses an existing Harness session root may pass `none`
to the profile builder only after verifying that the root contains raw
`session[.vN].jsonl` artifacts and no `session[.vN].jsonl.zstd` artifacts. Harness roots
are single-encoding stores: hosts must refuse mixed roots without moving,
rewriting, or deleting user artifacts. Harness 0.2 writes V4 successors on native
write-open when migrating supported historical formats, retaining the old files.
Retained predecessors do not provide automatic downgrade after new turns.

The ACP profile keeps the session-query service mounted for exact reads but sets
its full-text SQLite index to `openAt: never`. This composition does not expose
the session-search tool, and public Node distributions cannot be assumed to
include SQLite FTS5. Disabling the unused index prevents ACP startup from
depending on that optional SQLite build feature.

## Development

```sh
npm install
npm run build
npm test
npm run format:check
```

Node.js 22 or newer is required.

The optional real-runtime settings regression test uses a preinstalled profile
closure. Install every specifier `createDeepSeekHarnessNpxSpecifiers()` returns
in a separate directory first, then run:

```sh
DSH_TEST_RUNTIME_ROOT=/absolute/runtime/node_modules npm run test:settings-profile
```

The test itself uses isolated temporary homes, synthetic settings, and ACP
initialization/session creation only. It does not install packages, use API keys,
send model requests, or edit the user's Harness home. It checks first-request
catalog visibility, absent settings, invalid YAML, non-mapping settings documents, and
preservation of the settings document. The profile's ACP entry explicitly waits
for `settings` so catalog discovery cannot race the initial file read.

## Plan configuration

Core’s boolean `plan_mode` option is available only when the current Agent preset mounts the native Plan service. It calls `planMode.set`, preserves sandbox/approval settings, and publishes durable Plan changes as config updates. A pending selection is reflected until its next-step commit; Plan is guidance, not a sandbox policy.

## User questions

Each ACP-owned Agent mounts an answerer for Harness `user-questions/request`.
The `standard`, `ptc`, and `cordis` presets expose `ask_user_question`; `minimal`
still does not. Clients must advertise standard `elicitation.form`. The adapter
sends `elicitation/create` with Core `_meta.lody.elicitation` and restores the
original Harness question ids and selected option labels in the tool result.
Free text and single-select Other use the existing replacement-answer flow.

For multi-select, clients advertising Core 0.1.6 `answerNotes` receive a separate
Other note alongside their selections. A collision-free Other option permits
custom-only answers; this synthetic label never reaches the tool result.
Clients without answer notes retain replacement-only Other. Plan-review questions
display the question and full plan detail, preserve the declared approval label,
and do not change Plan Mode or permissions.

Harness owns exact-live/root-agent admission (`CALLER_NOT_LIVE` and
`DELEGATED_CALLER`). Requests queue independently per ACP session. Abort, session
cancel/close, and connection disposal reject pending tools with `ASK_ABORTED`;
decline returns `ASK_DECLINED`, transport failure `ANSWER_FAILED`, and malformed
accepted answers `INVALID_ANSWER`. Cancelled queued requests do not dispatch.
SDK 1.3's `AgentSideConnection` has no per-request cancellation API: an already
sent form may remain visible until the host dismisses it or cancels the turn.
The adapter ignores late answers and releases its local queue immediately.

Run the native tool/service/Cordis/ACP boundary test against the pinned installed
closure (no model requests or credentials):

```sh
npm run build
DSH_TEST_RUNTIME_ROOT=/absolute/runtime/node_modules node --test scripts/user-questions-smoke.mjs
```

## Tool calls

The adapter projects durable Harness `tool/call` and `tool/result` events into
standard ACP tool lifecycles. Each row keeps the tool name, parsed arguments
(or the original malformed JSON), completion/failure status, and native result
payload. Text and stored images become ACP content; unsupported blocks remain
inspectable as JSON. Unavailable attachments produce a visible placeholder.
Permission requests wait for the preceding call notification and include its
name, title, kind, arguments and locations.

Agent-scoped tool presenters supply titles, categories, file locations, terminal
output and successful result-time diffs. Broken or absent presenters fall back
to native data. Call-time diffs are deliberately not published as evidence of an
applied edit, and failed calls retain their native error output.
`tool/ptc-dispatch-start` / `tool/ptc-dispatch` also expose tools inside `run_code`
as separate rows, with native sub-call IDs; result payloads retain their root and
parent IDs. The adapter does not invent a host-specific nesting protocol.

Only the exact ACP-owned session contributes rows. Ordered delivery includes
attachment reads, and prompt settlement drains it before releasing the slot.
A turn that ends without a recorded tool result closes the remaining row as
failed with an explicit unknown-outcome explanation, never invented success.
This does not add child-agent transcript forwarding, token-level tool argument
streaming, or subprocess stdout streaming that the durable tool events lack.

## Session titles

The managed profile enables the upstream first-prompt LLM title plugin. Initialize
advertises Core 0.1.7's `_meta.lody.sessionTitle: { version: 1 }`; clients can skip
a separate title process. Native `session/title` events use the ordered ACP output
queue and map provider/user/fallback provenance to generated/explicit/fallback
`titleSource` metadata. Harness owns generation, persistence and user-name protection.
A failed generation leaves the fallback title; it does not fail the prompt.

## Session forks

The adapter advertises standard ACP `sessionCapabilities.fork` and Core
`_meta.lody.forkAtTurn: { version: 1 }`. `session/fork` without a target copies
the observed native log if no turn is open, including an empty session. With
`_meta.lody.forkAtTurn: { version: 1, turnId }`, it copies the inclusive prefix
through that exact native `turn/end`. Root prompt admission and committed
assistant output publish opaque `_meta.lody.turnId` values such as `dsh-turn:1`.
Pass those values unchanged, with their source session ID.

Any ended turn can be selected, including an earlier turn while the parent is
running. Unknown/malformed targets and unfinished turns fail; the adapter never
rounds a target or silently copies the latest turn. The pinned Harness retains
raw events across compaction, so a prefix before compaction reconstructs the
earlier model context. Legacy client history without native markers does not
gain invented turn boundaries.

Sources are read through Harness's live/persisted query service. Children are
independent root Agents with native fork lineage, the requested cwd and MCP
servers, and the prefix's model/reasoning and Agent preset. Permission and Plan
events remain in the seed for their native projections. An empty history uses
the normal model/preset defaults when no selection has been logged. No model
prompt is sent, and the parent is neither cancelled nor reloaded. Historical
events are not replayed to ACP: the client retains its copied display history.

Prompt completion waits for its native checkpoint so another ACP process can
read the ended turn immediately. Fork success also waits for the child's native
durability checkpoint. Failures release
the child runtime and MCP reservations; a failed checkpoint error identifies
the child ID because Harness offers no public deletion operation for a stored
artifact. Forking does not restore project files or create a Git worktree.
Session restoration is described below; fork still creates a separate native identity.

`npm test` covers ACP routing, capabilities, exact prefixes, configuration,
failure paths and the durability barrier. The optional native event-store check
uses the pinned runtime without model calls or credentials:

```sh
npm run build
DSH_TEST_RUNTIME_ROOT=/absolute/runtime/node_modules node --test scripts/session-fork-smoke.mjs
```

It verifies prefix reconstruction, compaction surface replacements, source
isolation and serialized restoration. It does not exercise actual JSONL/zstd
restart, model continuation, or the compaction model/plugin.

## Session restoration

The adapter advertises `loadSession: true` and `sessionCapabilities.resume: {}`.
Both `session/load` and `session/resume` use Harness `agents.resume` with the original
session ID. Harness owns writer locking, disk reconstruction and interrupted-turn
repair. The adapter requires the persisted cwd, rejects delegated subagent identities
and duplicate activation, restores the Agent preset and model/reasoning selection,
and waits for every requested ACP MCP server before returning configuration.
Missing sessions, unavailable configuration, and setup failures are errors; no fresh
session or transcript-prompt fallback is created by the adapter.

Load emits the root session's user messages, assistant text/reasoning/images, tool
lifecycles and titles in log order before its response. Synthetic injected user context
is not presented as a human message; child-agent transcripts are not reconstructed.
Missing historical images fail load and release the runtime; resume can still proceed
because it emits no history. Both paths rebuild usage without emitting historical
usage increments. The next usage delta contains only new work.

New sessions checkpoint their initial model selection. Model/reasoning changes are
recorded and flushed even before the next prompt, so a restart preserves that choice.
Existing logs without a selection use their last request header, or the configured
default for a blank legacy session. Preset changes remain forbidden after a turn starts.

The native restoration probe runs separate processes over real JSONL and zstd storage,
with a synthetic model and preset composition. It verifies original identity, interrupted
turn repair, ordered load replay, silent resume, continued model context and usage:

```sh
npm run build
DSH_TEST_RUNTIME_ROOT=/absolute/runtime/node_modules node --test scripts/session-restore-smoke.mjs
```

Set `DSH_TEST_PREVIOUS_RUNTIME_ROOT` to a separately installed 0.1.5-rc.2
`node_modules` directory to additionally create old sessions and restore them with
the current runtime, checking that historical artifacts remain byte-identical.

The settings/profile probe also checks load after close with a retained model and
permission preset. Real remote models, full subagent-history replay and file rollback
are not part of these tests.

## Core controls

The generated Harness 0.2.1-rc.2 profile (v20) exposes Core sessionHistory,
steering, subagents, goal, tasks.background and worktreeProject in addition to
forkAtTurn, subagentEvents, sessionTitle, compaction and cumulative usage.
Goal, task and project declarations require their backing service/configuration.

- `session/list` discovers root sessions. `_lody/session/history/read` replays a
  nonactivated session through an immutable query observation, without writer
  locks, resume, recovery writes or model calls. History imports prefer this
  advertised method. Subagent history remains outside the root transcript.
- `_lody/session/steer` accepts input only during an owned active native turn.
  Non-waking injection preserves the active request configuration. Durable
  consumption produces `steer_applied`; rejected/cancelled/idle input cannot
  silently become another turn. Unsupported request content fails validation.
- Goal set/resume use prompt `goalControl`; native automatic rounds retain the
  same ACP prompt until completion, pause, blocking or disarm. Pause/clear use
  `_lody/session/goal`. Cancel pauses the goal. Native round exhaustion maps to
  `limited`; no token-budget or elapsed-usage values are invented. Fallback
  prompt text is ignored for these native controls.
- Background jobs project owner-scoped task lifecycle without reading the
  model's output cursor. Preset registration sets native job completion delivery
  to `quiet`; idle notifications wait for later owned input. Retry waits use Core
  activity metadata. Standard `usage_update` reports current context pressure,
  independently of cumulative Core token accounting.
- `worktreeProject` validates an existing absolute directory and persists an
  atomic catalog sidecar under `$DSH_HOME/lody-projects`. Listing by original
  project includes its worktree sessions while preserving each actual `cwd`.
  Forks inherit the association unless overridden. No execution/permission path
  uses this metadata; missing metadata retains ordinary cwd association.

Task/output requests require an active root session. Output is a bounded text tail
(100,000 characters); `tail` limits returned lines. Each run advertises its actual
stream/output/cancel support. Restored sessions begin a new observed-run roster.
No account rate-limit windows are available from the API-key composition, and the
native schedule service is not mounted because this composition has no ACP
transport for scheduled-turn ownership. `rateLimits` and `tasks.scheduled` therefore remain unadvertised.

Native behavioral probe (synthetic model and isolated storage):

```sh
DSH_TEST_RUNTIME_ROOT=/path/to/pinned/node_modules node --test scripts/core-capabilities-smoke.mjs
```
