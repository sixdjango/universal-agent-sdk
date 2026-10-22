# acp-extension-dsh contributor guide

Provider-owned ACP/Harness boundary. Keep it usable without importing Lody packages.

## Ownership

- `src/adapter.ts` owns ACP lifecycle, prompt streaming, model/reasoning changes,
  permission-preset selection, blank-session Agent preset composition, and
  session-scoped mounting of ACP stdio/HTTP servers through `dsh-mcp-client`.
- `src/capabilities.ts` owns the static preflight metadata shared with host UIs.
  Each ACP session must instead derive its model selector from `ctx.llm.listModels()`,
  exact model/reasoning metadata and image admission from `ctx.llm.resolveModelInfo()`,
  and permission labels/options from `ctx.permissionPresets`. The LLM catalog is
  advisory: resolve and expose the configured model even when it is unlisted, and
  never reject a model switch only because it is absent from the catalog. Do not
  pin a default catalog in the generated profile. When `DEEPSEEK_BASE_URL` is set,
  discover its OpenAI-compatible `GET /models` response once per ACP connection
  (official Chat/Messages roots use `https://api.deepseek.com/models`),
  resolve those exact ids through Harness, and use the first as the initial model;
  do not add a parallel host-authored model list. Permission knob events can move
  a session to the derived `custom` state outside ACP, so keep both ACP mode and
  config-option state synchronized from the durable Harness events.
  Advertise image input only with a compatible Harness attachment store, persist
  accepted image bytes before queuing the user message, and re-read committed
  assistant images for ACP output. Prompt completion and cancellation keep the
  slot owned until admission, Agent idle, and ordered output delivery quiesce.
- `src/profile.ts` owns the pinned Harness version, the same-release npx package
  closure, and the generated `dsh` profile: the pinned `@deepseek-ai/dsh-base`
  bundle plus a `cordis.patch.yml` overlay that disables telemetry/product rows
  and mounts this adapter as the ACP entry. That entry's `name` is a module
  specifier, so render the adapter path as a `file:` URL: a raw Windows path
  (`C:\...`) parses as the `c:` URL scheme and fails the ESM loader. Pin transitive DSH dependencies and peers too; cold installs must not mix releases. `presets/` contains the official
  standard/ptc/minimal/cordis declarations, with only the outer patch insertion
  envelope removed. Refresh from the pinned `dsh-web-app` package and retain its
  notice; creator skills resolve from `dsh-agent-preset`. Exclude these files from
  formatting. Register them in the profile scope for runtime package resolution;
  retain legacy `$DSH_HOME/.agent-presets` identities and configured defaults.
  Disable Harness 0.2's automatic settings migration in this generated profile.
  Read legacy model sections into native Config without modifying settings.yaml;
  normalize exact official Chat/Messages aliases to the `/anthropic` inference root
  before native provider construction, preserving settings-over-environment precedence.
  Never rewrite custom endpoints or credentials.
  validate on ACP initialize and wait for Loader settlement before catalogs.
  Model changes require a fresh connection. Keep `dsh-llm-pi-ai` dormant without
  configured providers. Native Config owns route lifecycle and credentials.
  ACP model ids encode the exact provider/model pair; never collapse equal ids
  or fall back after a route fails.
  Its persistence default matches upstream `zstd`; hosts may select legacy raw
  `none` only after inspecting an existing single-encoding root. A mixed root is
  an error and must never trigger automatic artifact mutation or deletion.
  Keep the SQLite session-query service mounted with `openAt: never`: this ACP
  composition needs its exact-read contract but exposes no full-text search,
  and public Node builds do not reliably include SQLite FTS5.
  Use createDeepSeekHarnessNpxSpecifiers(); keep Cordis versions independent.
  Never force npm peer resolution.
- `src/capabilities.ts` metadata is authoritative for built-in preset labels exposed
  through ACP. Harness runtime metadata remains authoritative for user presets.
- Hosts own installation caches, data-directory selection, process supervision,
  credentials, and bundling.

- `src/user-questions.ts` translates native questions through standard ACP form
  elicitation and Core metadata. Register its answerer in each ACP Agent scope;
  retain Harness's live-root admission and never route delegated/unowned callers
  to a parent's UI. Queue per session, cancel active/waiting requests on teardown,
  and preserve additive multi-select custom text only after Core answer-notes
  negotiation. Plan-review intent changes presentation, not Plan or permissions.

Change profile and adapter together for selector/service changes. Keep credentials
in the host environment, never generated profiles.

Core controls must retain ACP prompt ownership across goals and steering.
History queries never activate writers. Project metadata never changes cwd or
permissions. Force quiet job completion at preset registration; never admit
unowned root steps. Per-run query/cancel support follows actual local ownership.

Preserve valid available ACP MCP names; normalize invalid names and suffix
collisions in Harness's process-global tool namespace.
MCP plugin fibers belong to the Agent context and must settle before `session/new`
returns, so failed startup cannot publish a session without its requested tools.
Forward reasoning deltas immediately as ACP thoughts, ending blocks with `\n\n`.
Do not retract/deduplicate retry thoughts or replay final reasoning blocks.
Translate Harness's durable `compaction/start` / `compaction/end` bracket into one
standard ACP tool-call lifecycle. Compaction meaning belongs only in the shared
`_meta.lody.activity` contract from `acp-extension-core`; manual compaction has a
`null` Harness turn owner and automatic compaction has a numeric owner.

Retain the first-prompt title plugin. Declare Core `sessionTitle`; queue durable
`session/title` events, mapping provider/user/fallback to generated/explicit/fallback.
Never label a first-message preview as generated.

## Tool projection

- `src/tool-calls.ts` projects native durable calls/results and PTC dispatches into
  ACP. Keep state session-local and delivery on the session output queue, including
  attachment reads. Resolve presenters in the calling Agent's scope; malformed or
  absent presentation must not hide native arguments, results, or failures.
- Approval waits for preceding tool updates and carries the known call details.
  Only successful result-time diffs are edit evidence. Missing results at turn
  settlement mean unknown outcome, never success. Do not expose another Agent's
  session events or invent terminal IDs for Harness-owned subprocesses.

## Usage accounting

- Count committed `assistant/message.data.usage` once by durable event sequence,
  never raw usage chunks as well. `request/context` owns the actual model route.
  Preserve cumulative Core model usage across turns, model switches and compaction.
- Pinned Harness input already excludes cache hits; DeepSeek output includes
  reasoning. Split only the latter. Price official routes per request using the
  event timestamp and the dated UTC peak/off-peak table in `src/usage.ts`.
  Unknown models, custom endpoints and missing timestamps keep costs unknown.

## Checks

- Core subagent events require negotiation and native carrier ancestry; child
  permissions retain run attribution. See README for stream limits.

Do not commit generated `dist/`. Retain the `prepare` build hook so consumers
resolve `./dist/*` after installation.

Run `npm run build`, `npm test`, and `npm run format:check` before publishing a
change. Node.js 22 or newer is required.

## Session forks

Use Core `forkAtTurn`/`turnId` and native event prefixes through exact ended turns.
Never round unknown targets, copy open tails, replay a transcript prompt, or alter
source runtime/files. Preserve target cwd/MCP; flush ended prompts and children before success.
Release failed children and identify any possible stored artifact in the error.
See README for scope and native validation.

## Session restoration

Use native resume with original ID/cwd and fresh MCP; reject subagents/duplicate
activation and clean up failures. Load replays history, resume does not. See README.
