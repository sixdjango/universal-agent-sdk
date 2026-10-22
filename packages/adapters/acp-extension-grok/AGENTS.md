# Grok ACP adapter guidelines

`CLAUDE.md` is a symlink to this file. The public Lody repository guidelines also apply.

## Usage accounting

- Accumulate native per-prompt model usage in Core's session accumulator across
  both completion channels. Stable prompt IDs deduplicate and permit monotonic
  incomplete-to-complete corrections. Replay adds nothing; no model map means
  no invented model attribution. Preserve the ledger across model/config changes.
- Cumulative `modelUsage` and optional `delta` carry the same contribution at
  different scopes. Do not restore first-result-wins or client-side delta summing.

## Per-model reasoning-effort ladders

- The reasoning-effort list is the SELECTED model's ladder, re-derived from that
  model's own `_meta.reasoningEfforts` / `_meta.reasoning_efforts` on every
  model change; a switch to a model that publishes no ladders withdraws the
  control rather than reusing another model's list, while a repeat for the
  same model keeps what the session already reported.
- Session responses publish the per-model view to Lody as
  `_meta.lody.modelReasoningEfforts`; vendor model `_meta` never reaches Lody
  as a contract.
- For sessions that publish native standard config options, consume the runtime
  `model_changed` precursor internally and let the following complete
  `config_option_update` be the single client-visible update. Translate the
  precursor for legacy sessions only; never pass it through to Lody.

## Permission modes

- Seed both `yoloMode` and `autoMode`, including explicit false, on new/load/resume/fork.
  Pre-session notifications cannot configure a session that does not exist yet.
- Auto is available only after initialization reports at least the manifest's
  `autoPermissionMinimumVersion`; reject unsupported Auto before creating/copying
  a session. Keep client identifiers stable and reseed inherited selections on attach.
- Permission options express the requested policy, not a native acknowledgement.
  Grok's Auto gate can fall back to Ask. Do not infer effective state from version,
  notification delivery, remote-only settings, or a successful config response.
  Validate Auto against the official binary with the isolated native probe.
- Live selections still use the client-scoped `x.ai/yolo_mode_changed` notification.
  Resolve new YOLO tool permissions in the adapter as described below; requests
  already forwarded to Lody remain owned by its durable permission flow.

## Model snapshot settling

- Official Grok 1.0.34 may return a provisional model roster from `session/new`, then emit
  `_x.ai/models/update` later. The update has no session id and is a process-level complete
  snapshot containing `currentModelId` and `availableModels`.
- The production adapter must settle a pending session response from that explicit snapshot
  signal. If the snapshot arrives first, reuse it for the response. If the response arrives
  first, defer it only until the signal or the bounded safety timeout; never use an unconditional
  sleep.
- After a session response is already visible, translate a new snapshot to standard ACP
  `config_option_update`. Do not expose the provider-specific notification to Lody business code.
- Tests must deterministically cover initial 4.5 followed by a complete 4.6 + 4.5 snapshot, the
  reverse ordering, and the bounded fallback. Do not depend on scheduler timing or a real runtime.
- This settling happens inside the existing ACP process. It must not add Streams/Flock
  subscriptions or change connection cardinality.

## Plan approval

- Translate native plan approval only inside the wrapper, using standard ACP plan,
  permission, and elicitation messages. Core owns the Plan toggle and elicitation
  metadata; do not add a provider RPC or vocabulary to Lody business code.
- Preserve the native request id and envelope. Only explicit approval may return
  `approved`; errors and cancellation stay in Plan. Mode updates must refresh the
  boolean config snapshot without changing permission policy.

## Permission fallback

- Advertise Ask, Auto (on compatible runtimes), and Always Approve. Auto delegates
  classification entirely to Grok; never apply YOLO's approval fallback to Auto.
  Switching to Ask or Always Approve explicitly disables native auto mode.
- For a known session in Always Approve, answer native permission requests in
  the adapter, preferring `allow_once` then `allow_always`; match ACP option kinds,
  never substrings in labels or ids. Only select an option supplied by the request.
- Do not forward an automatically answered request to the client. Keep questions,
  mode-switch decisions, unknown sessions, and requests without usable allow options interactive.
- Never consume a pending client request when a reverse request uses the same id.

## Subagent events

- Negotiated subagent events admit children only through an owned native parent.
  Preserve attempt identities and permission policy; child progress is not usage.
  Native child replay must not create a fresh live execution.

## Scheduled tasks

- Translate only owned sessions (including pending load/resume replay). Keep
  stable schedule IDs separate from subagent run IDs. A fire is not completion;
  shutdown cleanup is not deletion. Preserve replay metadata.
- Map scheduling tool identity from native `x.ai/tool`, never display titles or
  MCP names. Keep interval input unchanged; Core's existing cron identity does
  not authorize inventing cron timing or a next-fire timestamp.

## Session forks

- Translate Core's standard `session/fork` and versioned `forkAtTurn` only in the
  adapter. Discover the source cwd; the request cwd belongs to the child.
- Copy natively, then resume the child without replay. Never cancel or reload the
  source, silently discard a malformed boundary, or replace failed forks with new
  blank sessions. A failed attach reports the already-created child identity.
- Turn IDs come from native prompt markers, remain opaque to the host, and use
  the runtime's zero-based inclusive boundary. Consume live user echoes while
  publishing the Core boundary; preserve replay and unrelated metadata.
