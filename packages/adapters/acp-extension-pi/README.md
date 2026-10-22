# Pi ACP adapter

A Lody-owned ACP adapter for the pinned official Pi CLI (1.3.0).

```text
Lody → ACP Adapter → official Pi CLI --mode rpc
                         └─ packaged tools
```

The adapter translates protocols. Pi owns model execution, native tools,
automatic compaction, retry and session files. There is no custom SDK worker.

## Run

Requires Node.js 22.19 or newer.

```sh
pnpm install
pnpm build
node dist/index.js --provider <provider> --model <model>
```

Startup accepts --provider, --model and --thinking plus repeatable
-e/--extension flags naming an existing absolute or ~/ file or directory.
Authenticate/configure models through Pi on the execution machine. ACP
configuration also exposes model and thinking selection. stdout is ACP;
stderr contains diagnostics.

`LODY_PI_PATH` can select another Pi executable. It must support the Pi 1.3
RPC contract and explicit `builtin:codemode` loading, like the bundled runtime.

Extensions are opt-in only. The adapter disables ambient and project
auto-discovery; nothing outside an explicit -e/--extension path and the
packaged extension and Pi's built-in codemode extension is loaded.
Codemode stays inactive unless selected through Pi's `defaultTools` setting.
For example, `{"defaultTools":["+codemode"],"codemode":{"mode":"only"}}`
routes tools through codemode in both parent and child sessions. Pi's built-in
MCP discovery remains disabled; ACP supplies MCP servers through the existing bridge.
`node dist/index.js --list-extensions` performs
a read-only scan of globally installed extensions and prints candidates as
JSON; it never executes extension code. The same explicitly selected paths
are passed to native subagent children; the packaged adapter extension is
not forwarded. A separate context-only extension supplies their workspace and
subagent instructions without replacing native user prompts. Remote or package-spec sources (npm:, git:, URLs) and relative
paths are refused. Selected extension code runs with Pi's full authority and
can add tools: this boundary is a supported-feature contract, not a security
sandbox for shell commands, and arbitrary community plugins are not a
compatibility promise.

## V1 capabilities

When both peers advertise `subagentEvents` v1, child JSONL text/thinking deltas,
tool starts/results and lifecycle/progress feed Core `_lody/subagents/event`.
Legacy task cards are suppressed for these runs; non-negotiated clients keep them.
Children still cannot ask questions or spawn descendants. Existing task-ID
list/output/cancel endpoints remain separate; normalized run controls are disabled.
Core 0.1.9 supplies the contract and helper. A rebuilt, checksummed managed
runtime is still required before this reaches Lody's installed Pi provider.

- Native prompts, text/images, tool progress/results, model errors and cancellation.
- Native file identity for explicit new/resume/load/fork. No session-id map.
- Session list of native files for a working directory; load replays the
  current branch's user text/images, assistant text/thinking, tool and todo
  history. Compaction summaries and other branches are not replayed. A missing
  session file fails resume/load instead of starting an empty session.
- Acknowledged steering using acp-extension-core identity metadata.
- Per-response token usage by model (including compaction summaries and
  subagents), native context snapshots, automatic compaction activity and /compact.
- ACP-selected stdio MCP tools with text/image results and cancellation.
- Questionnaire: one or more questions in Lody's existing question card.
- Todo: list/add/toggle/clear through Lody's existing checklist.
- Subagent: native Lody task lifecycle, list, output and individual cancellation.

`session/new`, `session/load`, `session/resume` and `session/fork` accept
`additionalDirectories`. Both `cwd` and every additional directory must be
absolute paths. Each activation replaces the request-owned directory list:
`[A]` → `[B]` → `[]` → omitted means A, then B, then no additional request
directories, then no additional request directories. Native user configuration
is preserved. Load/resume reject a cwd that differs from the native session
header before changing runtime state or configuration (symlink aliases of the
same directory are accepted). Fork can choose a different target cwd.

The packaged extension supplies these directories to the native model's system
context. Relative paths and Bash's initial directory still use `cwd`; native
Read/Write/Bash can access additional roots by absolute path. This is workspace
context, not a filesystem sandbox or new permission guarantee. Additional roots
do not trigger extension discovery or load their project configuration. Subagent
processes inherit the current workspace context, but not the parent's MCP tools.
Request roots are activation-only, are not saved as native history, and are not
reported as durable roots by `session/list`; send the full list when reattaching.

Fork uses Pi's native file-fork mechanism for existing persisted history, creates
a new native ID/file and preserves the source file and active runtime. It copies
native history rather than sending history as a prompt. Each session has its own
RPC process and private workspace/MCP configuration; parent, child and sibling
sessions remain independently addressable on the connection. A fork of a live
source requires it to be idle. Connection close cleans up all owned runtimes;
an unexpected Pi exit still fails the entire connection. Empty, never-persisted
sessions are outside the recovery/fork contract.

Implementation and validation: [additional directories note](.agents/notes/implemented/feature/2026-10-18-additional-directories.md).

MCP audio, resource links and embedded resources are unsupported: a result containing
any of these fails explicitly, including mixed results. Structured JSON output is
appended as text. This validates returned content; it cannot undo an MCP tool's effects.
Codemode calls also receive the structured MCP result (`content`,
`structuredContent`, `isError`), so scripts can pass image blocks to `image()`.

Questionnaire waits inside the parent tool call and returns answers or cancellation.
Late answers are ignored. Child agents do not ask questions; they report missing
information to the parent. Official TUI Question/Questionnaire code is not loaded.

Todo state is persisted in Pi tool results and reconstructed on resume. Codemode
results carry the same todo snapshot because nested calls have no separate native
result messages. Replayed nested calls use Pi's recorded ids, arguments and statuses;
Pi stores only bounded nested metadata, so full nested results are not recreated. ACP
checklist updates are a display projection. There is no second todo database.
Todo completion maps to pending/completed; the tool does not invent in-progress
status. The /todos terminal window is not provided.

Subagent launches an isolated official Pi child and waits for exit. It uses the
optional `model` argument (`provider/model-id`, which must be an available Pi
model) or else the parent's model. It inherits the parent's thinking level
(clamped by Pi to the child model), cwd and the same explicitly selected
extension paths, and uses Pi's built-in tools. It does not inherit MCP clients
or load the packaged questionnaire/subagent adapter extension.
The execution owner generates task ids and supplies Core task metadata; Lody
presents the native task UI and forwards list/output/cancel requests.
Output queries retain the last 64 Ki characters for the current runtime.
Completed child processes are not resumed after adapter restart.
Child tasks are not detached background jobs or separate Lody sessions.

## Lifecycle

Pi's prompt response reports `started`, `queued`, or `handled`. A handled input
finishes without waiting for a model event; started and queued inputs wait for
native agent_settled, which covers the supported native model loop and
awaited tools, retries and automatic compaction. Manual compact instead waits for
its RPC result. Execution settlement is followed by output delivery and cleanup;
a new request cannot overtake this barrier.

Stop does not release admission immediately. It waits for preflight if necessary,
cancels outstanding questions, clears queues, aborts Pi, and waits for request
cleanup. A transport failure fails the request. Connection close terminates the
owned process group, including non-detached child agents.

On Unix, V1 relies on Pi's cooperative cleanup of its detached shell commands.
If Pi is forcibly killed or crashes before that cleanup runs, commands in separate
process groups can survive the adapter and continue writing files or running
services. They may require manual termination. This is an accepted V1 limitation:
there is no additional watchdog or replacement shell executor. Normal Stop and
connection-close cleanup remain supported. Unexpected Pi exit fails the connection
with a nonzero adapter exit code; it never reports success or retries the prompt.
Resume requires an explicit new connection and does not clean up orphaned commands.

On Windows, the adapter joins a Windows Job before starting Pi. Adapter exit
releases the Job and terminates remaining descendants, including MCP servers.
Unexpected Pi exit ends the connection with a nonzero adapter exit code; native
session files remain available for explicit resume through a new connection.
This adds no worker process. Missing or unusable native support fails startup.

Ordinary diagnostics do not replace the model's terminal outcome. Session file
changes cannot silently retarget ACP identity. No extension may enqueue work
after its tool returns or replace the parent session.

## Exclusions

V1 does not support arbitrary community or official-example plugin
compatibility, remote or package-spec extension sources, ambient or project
extension discovery, Plan Mode, presets/tool-selection plugins,
extension-triggered compaction,
hot reload, handoff/session-navigation plugins, permission/environment plugins,
terminal UI adaptation, background child jobs or recursive subagent tools.

## Validation

Windows source development requires `pnpm build:native` with the Visual C++
toolchain and Python available. Published packages carry CI-built Node-API
modules for Windows x64 and ARM64; end users do not compile them. The Check
workflow assembles the distributable tarball only after both Windows jobs pass.

```sh
pnpm check
pnpm build
pnpm smoke
pnpm pack
```

Unit tests protect transport failure, session identity, steering, final outcomes,
cancellation and delivery ordering. The native smoke uses the official CLI and a
local synthetic model endpoint. It checks question answers/cancellation, todo
recovery, subagent lifecycle/output/cancel, ambient extension exclusion, and an
explicitly selected provider extension reaching both the parent and a native
subagent. The entire smoke runs in ordinary-tool and codemode-only modes, including
stats, manual compaction and extension commands handled without a model turn.
It verifies real file read/write/edit and shell effects, image input and MCP images
in the model request, per-response usage, steering, provider-error recovery and
explicit child model selection and tool isolation.
The same script accepts an installed dist/index.js path.

Upgrade decision and verification limits: [Pi 1.3 runtime note](.agents/notes/implemented/feature/2026-10-16-pi-1.3-runtime.md).

The separate Electron acceptance in that note covers one real provider, a locally
served checksummed managed runtime, and a host-side image attachment submission
limit. It does not establish other providers' quality or public runtime publication.
Historical checks of the previous SDK implementation do not validate this architecture.

When Pi exits during startup, adapter failures include only a short extension
diagnostics allowlist: load failures, tool-name conflicts and extension-related
hints. Other startup failures remain on the process stream and can be added to
the allowlist later when their presentation is defined; unrelated output is
never forwarded through ACP.
