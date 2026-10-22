# ACP additional directories

Status: implemented
Translation: current

[中文](2026-10-18-additional-directories.zh.md)

## Contract

On the Pi 1.3.0 baseline (84d3c3a), new/load/resume/fork accept an absolute cwd
and absolute additionalDirectories. Each activation replaces the complete
request-owned list; omission and [] clear it. User configuration stays intact.
Load/resume validate the native header cwd before any runtime/config mutation;
canonical symlink aliases are accepted. Fork allows a separate target cwd.
The user explicitly excluded empty, never-persisted sessions from recovery and
fork acceptance; no implementation is added for that case.

## Ownership

The adapter owns one official RPC process and private workspace/MCP files per
active native session. The routing key is the native file path, not an identity
translation. Lifecycle operations are excluded from one another; live-source
fork holds its connection configuration lock and rejects active work.

The packaged extension snapshots the workspace configuration on native attach.
A before_agent_start hook appends the directory context to the current system
prompt. Pi projects that forced prompt into model requests without recording it
as native history. No user prompt replay, context-file store or executor is added.
The existing system prompt and configured user resources remain in effect.
Subagents receive the same snapshot through an explicit context-only extension hook;
they keep their existing extension/MCP/tool isolation and execution ownership.

Fork calls official SessionManager.forkFrom (the CLI --fork primitive) and then
attaches a separate RPC process. The source runtime is never navigated or
replaced. Native non-header entries are copied by Pi, including their identities;
the child gets a new native ID/header/path. A session_start hook reconciles newly
selected MCP tool declarations through Pi's tool API: restored transcript loadouts otherwise omit new MCP names. Native
codemode visibility and non-MCP tool selections remain authoritative.
New/fork MCP and startup model/thinking settings apply only to the destination
runtime. Normal close cleans every owned
process group; unexpected native exit fails the connection. Shutdown drains
accepted ACP request responses through actual transport writes before allowing
process exit, preserving startup diagnostics even under output backpressure.

## Limits

Roots provide model workspace context, not a sandbox: native absolute file access
and Bash keep Pi's existing permissions. cwd is the relative-path base. Added
roots do not cause project configuration or extension discovery. Request roots
are not persisted or returned by session/list; clients must resupply them on
attach. Recovery/fork require existing persisted native history. Concurrent
writers to the same native file from independent ACP connections are not locked
by this adapter. No pins in Lody, release or publication are included.

## Validation

Owning tests cover absolute path validation, replacement/omission, rejected
attach preserving the existing activation, native header/cwd matching, file-fork
identity/history/source preservation and independent runtime routing/cleanup.
The official CLI smoke exercises both ordinary and codemode-only tools against a
local deterministic model: model directory context, Read/Write/Bash effects,
subagent inheritance, hot/cold load/resume, independent fork cwd, parent/sibling
isolation, native history and no model call during fork.

Verified locally on macOS with Node 22.20.0:

- `pnpm check`: typecheck, 102 passing tests (one platform-specific skip), formatting.
- `pnpm build`: passed.
- `pnpm smoke`: passed in ordinary and codemode-only modes.
- `pnpm pack`, a separate temporary install, and the same complete smoke against
  the installed adapter: passed in both modes; the new context modules are packed.
- Sixteen isolated official-CLI startup-failure probes all delivered full ACP
  diagnostics before exit after fixing the response-write shutdown race.

No commercial provider was contacted. Linux and Windows were not executed locally.
Delivery: Draft PR for review against main. This change does not merge, publish,
or update Lody runtime pins.
