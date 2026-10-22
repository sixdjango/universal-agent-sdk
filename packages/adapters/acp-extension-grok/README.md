# acp-extension-grok

Lody's ACP compatibility adapter for the official Grok runtime.

The adapter does not contain, build, patch, or publish Grok. It launches the
official runtime supplied through `GROK_PATH` and translates the small private
wire contract pinned in `runtime-manifest.json` into standard ACP session
configuration options.

Supported configuration:

## Scheduled tasks

The adapter advertises Core `tasks: { version: 1, scheduled: true }`.
Native scheduled-task created/fired/deleted notifications become standard ACP
tool updates carrying `_meta.lody.task` with `kind: "scheduled"` and a stable,
namespaced task ID. Created means pending; fired means in progress, not finished;
removal means completed schedule ownership, not successful subagent execution.
Shutdown cleanup is ignored because the schedule can resume. Replay metadata is
preserved, including replay arriving during session load/resume.

Canonical Grok `x.ai/tool` identities for `scheduler_create`, `scheduler_delete`,
and `scheduler_list` map to Core `CronCreate`, `CronDelete`, and `CronList`.
Inputs, outputs, and errors retain their native meaning; interval is not converted
to cron. This integrates the existing lifecycle schema, not the cron-based
next-fire panel, schedule controls, or Lody's machine-owned schedules. No Core
schema changes or new RPCs are introduced. Wire shapes are source-verified against
grok-build `f0e3be1`; authenticated scheduling on pinned Grok 1.0.46 remains unverified.

## Configuration and subagents

Subagent history is opt-in through bilateral `_meta.lody.subagentEvents` v1.
The adapter maps native spawn/progress/finish facts and child ACP output to
`_lody/subagents/event`, including nested lineage and new execution IDs on reuse.
Argument deltas accumulate as text, never as prematurely parsed JSON. Context
tokens remain display progress, not billing. Consent stays on the root connection
with run-scoped tool IDs; existing permission policy still applies. Run cancellation
and output reads are not advertised. Legacy clients retain native notifications.
The private event shape is source-verified in Grok 1.0.38/1.0.41; subagent execution
on pinned 1.0.46 still needs live verification. Core 0.1.9 supplies the event contract.

- Initial permission mode from `_meta.lody.sessionConfig` maps to Grok's
  startup `_meta.yoloMode` and `_meta.autoMode` before new/load/resume/fork reaches
  the official runtime. Both flags are explicit, including false. Omitted selections
  inherit the wrapper's client-scoped policy, otherwise Ask. Later changes map to
  `x.ai/yolo_mode_changed` with the current Lody `clientIdentifier`, which is
  registered during ACP initialization. In Always Approve (YOLO), the adapter
  answers native `session/request_permission` requests directly: prefer
  `allow_once`, then `allow_always` if no single-use allow option exists. These
  requests are not forwarded to the client, preventing approval UI flicker.
  The latter option may persist a grant in the official runtime. Questions,
  mode-switch decisions, requests for unknown sessions, and requests without a usable allow option
  remain interactive.
- Model and reasoning-effort selections use Grok's native standard
  `session/set_config_option` contract. The adapter merges the runtime's
  `configOptions` and `config_option_update` snapshots with Lody's Plan and
  Permission controls. A legacy `session/set_model` fallback remains for older
  runtimes that do not publish the standard options. On the native path, the
  private `model_changed` precursor updates adapter state without producing a
  duplicate client update; legacy sessions still receive its standard ACP
  translation.
- Interaction mode maps to the corresponding standard legacy ACP call.
  Grok 1.0.34 reliably supports Agent and Plan. It silently ignores Ask, so the
  adapter does not advertise Ask and maps legacy persisted Ask selections to
  Plan.
- Native `user_message_chunk` echo is requested through `x.ai/userMessageEcho`
  to read fork boundaries, then consumed for live turns; Lody owns rendering the
  submitted prompt. Replay user messages remain visible.
- Per-turn token and trusted cost totals from Grok's prompt metadata or durable
  `_x.ai/session/update` `turn_completed` event map to Core's
  `_lody/session/usage_update` extension. Per-prompt model rows are accumulated
  across the ACP accounting lifetime and emitted with already-included deltas.
  Repeated prompt IDs can complete earlier partial statistics without being
  counted twice. Reports without IDs/model rows cannot be safely attributed.
  Core 0.1.5 must be published before this adapter release. Cache and reasoning totals are
  converted from Grok's inclusive counters into Lody's disjoint buckets.
- The adapter queries `x.ai/session/info` after session setup and completed
  prompts, then emits standard ACP `usage_update` context-window updates. Replay
  events never re-record historical billing usage.
- The adapter queries `x.ai/billing` after session setup and completed prompts,
  then maps the official credit usage percentage and billing period to Core's
  `_lody/rate_limits/update` extension. Clients can also call
  `_lody/rate_limits/get` independently of a session. For the fresh
  unified-billing shape where Grok explicitly returns zero cap, usage, and balance
  but omits the percentage, the adapter mirrors the official `/usage` UI's weekly `0%`.
  Billing failures never fail a session.

Ask, Auto, and Always Approve are advertised when initialization reports Grok
1.0.46 or newer. Older/unknown runtimes retain Ask and Always Approve; requesting
Auto then fails before session creation or native fork copying. A startup Auto
selection also requires the current client identifier. The baseline compatibility
floor remains 1.0.34; Auto has its own verified version floor.

Auto requests `yoloMode=false, autoMode=true` and delegates the decisions to Grok's
native classifier. Any permission requests it emits stay interactive, including
classifier failures, questions, and Plan approval. The adapter never automatically
answers them. Switching out of Auto explicitly disables it; switching from YOLO
to Auto immediately stops the adapter's YOLO approval fallback.

Permission changes use an unacknowledged native notification. The returned config
snapshot is the **requested policy**, not proof of the effective runtime state;
Auto's option description makes this limitation explicit. Grok can disable Auto
through its own environment/config/managed/remote gate and execute with Ask instead.
The adapter does not override that gate, parse debug logs, inject hooks, or treat a
remote-only settings flag as the effective policy. The official runtime currently
offers no effective-permission query. Requests already forwarded to a client remain
owned by that client. Standard elicitation requests pass through unchanged.

The protocol setter applies immediately when called. A host's input-box draft does
not call that setter by itself: Lody must submit the config or send
`session/set_config_option` for the active session. This adapter does not change
that host interaction. Host static catalogs and managed-runtime artifacts must be
updated when integrating this version.

## Native Auto verification

```sh
GROK_PATH=/path/to/official/grok node scripts/probe-auto-permissions.mjs
```

This opt-in probe runs the production adapter with the official binary, isolated
config/history, and a loopback model fixture. It uses synthetic credentials only.
Native hook observations verify the effective mode; local classifier requests and
file markers verify actual permission decisions and execution. Hooks are test
instruments, not part of the adapter's production permission handling.

Verified on macOS arm64 Grok 1.0.46: startup, warm/cold load and resume, fork,
source preservation, Ask/Auto/YOLO transitions, classifier allow/block/unavailable,
and disabled Auto at startup and during live selection. These checks exercise the
official runtime but do not measure a hosted model's classification quality or
validate another platform. The [permission spec](specs/auto-permissions.md) and
[decision record](.agents/notes/implemented/feature/2026-10-07-native-auto-permissions.md)
describe the confirmation boundary and supersede the earlier Auto retirement.

Run with:

```sh
GROK_PATH=/path/to/official/grok node src/index.js
```

## Plan configuration

Core’s boolean `plan_mode` option replaces the interaction-mode picker. The adapter maps it to the native default/plan session mode independently of `permission_mode`.

## Plan review

The native `x.ai/exit_plan_mode` reverse request is translated to standard ACP
`plan_update` (when advertised) and a `session/request_permission` decision with
`kind: switch_mode`. Older clients receive the plan in the approval tool's text
content. Empty plans still require a decision. Approve, keep planning, and abandon
map to the native `approved`, `cancelled`, and `abandoned` outcomes.

When the client advertises form elicitation, keep planning opens an optional
`elicitation/create` feedback form using Core's `_meta.lody.elicitation` contract.
Dismissal, errors, and session cancellation never approve a plan. Native mode
updates refresh Core's boolean `plan_mode` config option. The adapter does not
change permission policy when reviewing a plan.

Hosts must keep `switch_mode` decisions interactive, including when their tool
permission policy is Always Approve. Release this adapter with that host change;
ordinary tool auto-approval is not consent to implement a plan.

## Automatic session titles

The adapter advertises Core `agentCapabilities._meta.lody.sessionTitle: { version: 1 }`.
The official runtime already pushes automatic titles through ACP `session_info_update`.
The proxy labels nonempty untagged titles `_meta.lody.titleSource: "explicit"`,
as the runtime does not distinguish generated names from manual names on this wire.
It preserves existing source tags, other metadata, and the session id; tagged
fallback/unset updates are never promoted. Hosts can skip their own title process.
The wrapper cannot distinguish an untagged runtime fallback from a real name;
this preserves the existing trust in official Grok title pushes rather than
claiming new provenance evidence.
## Session forks

Standard ACP `session/fork` bridges the official runtime's private
`x.ai/session/fork`, then attaches the new session with `session/resume` (no
history replay). The adapter discovers the source cwd with paginated
`session/list`; the requested cwd and MCP servers belong to the child. Initial
permission metadata is applied when attaching the child. The source is neither
cancelled nor reloaded. A failed attach returns `error.data.forkedSessionId` for
the already-persisted child rather than reporting success or creating a blank session.

Core's `_meta.lody.forkAtTurn: { version: 1, turnId }` selects an inclusive native
prompt boundary. The adapter publishes opaque `grok-prompt:<index>` turn IDs from
Grok's native `promptIndex` on live/replayed updates. Native user echoes are
requested internally to obtain these markers; live user text is consumed, while
`session_info_update` publishes the boundary. Replay keeps its user text. A new
prompt clears the previous active boundary; unmarked mid-turn echoes do not
invent a new turn. Missing markers in older histories stay unsupported for
point-specific forks. IDs are native branch-local coordinates, not global IDs
across external rewinds. Do not synthesize or alter them in clients.

Omitting `forkAtTurn` copies the persisted conversation in full. A targeted fork
passes the native zero-based, inclusive `targetPromptIndex`. This delegates
history and compaction handling to Grok; it does not copy files or rewrite its
storage in the adapter. Live copies reflect what the runtime has persisted.

Run deterministic protocol tests with `node scripts/test.mjs`. An optional
native probe uses a temporary `GROK_HOME`, synthetic history, and no login/model
prompts, verifying source discovery, full/partial copies, different source/child
cwd values, and unchanged source files:

```sh
GROK_PATH=/path/to/official/grok node scripts/probe-session-fork.mjs
```

The probe passes on 1.0.34, 1.0.40, and 1.0.46. Authenticated child continuation, concurrent
live persistence, and cross-compaction targeted forks need further end-to-end
validation.
