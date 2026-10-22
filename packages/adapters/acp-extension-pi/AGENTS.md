# acp-extension-pi

Standalone public ACP adapter. Lody consumes its executable; never import Lody
workspace packages or reimplement Pi's executor.

- Launch the pinned official Pi CLI in RPC mode. There is no custom SDK worker,
  AgentSession facade, generic call owner or background execution scheduler.
- Ambient and project extension discovery stay disabled. Only the packaged
  extension, Pi's builtin:codemode and explicit -e/--extension absolute paths are loaded; selections
  are default-off and bounded. `--list-extensions` scans globally installed
  extensions read-only without executing them. Child Pi processes disable
  discovery too and inherit the same explicit list plus a context-only workspace
  extension, never the packaged tools extension. This is a supported-feature boundary, not a sandbox against
  arbitrary bash: selected extension code can add tools and no arbitrary
  plugin compatibility is promised.
- Packaged tools are questionnaire, todo, subagent and ACP-selected stdio MCP
  tools. Their execute promises own all work. No detached callbacks, hot reload,
  extension-driven session replacement or custom compaction.
- Only the main agent asks questions. Questionnaire handles one or many questions
  through Lody form elicitation. Stop closes questions; late answers cannot enter
  another request. Do not implement terminal UI.
- Todo snapshots live in Pi tool results, including outer codemode results for nested
  calls. Reconstruct on native resume and publish
  ACP checklist updates to Lody; never create another todo store or bidirectional sync.
- Subagent execution owns task ids, status, output and child cancellation. Lody
  receives Core task metadata and list/output/cancel methods. Parent tools await
  child exit; child agents have built-in Pi tools, no questionnaire or subagent
  extension. They inherit thinking, cwd and the same explicit extension list,
  not the parent's MCP clients. The model is the tool's optional available
  `provider/model-id`, else the parent's; reject others before launch.
  Process-local task queries do not resume or replay a terminated child.
- Negotiated Core subagent events replace legacy live task cards, not execution
  ownership or billing. Stream child JSONL through the adapter; run IDs do not
  authorize legacy task-ID controls. Keep non-negotiated clients compatible.
- Pi 1.3 prompt disposition is authoritative: handled completes without waiting
  for a model event; started/queued wait for agent_settled, including retries and
  automatic compaction. Explicit compact waits for its own RPC response. Both
  drain output and finish cleanup before admitting another request.
- Abort must not overtake prompt preflight. Clear queues, cancel questions, await
  native abort and the same request cleanup. Transport failure is failure, never
  successful settlement. Never silently retry a prompt.
- Pi owns native session files. ACP identity is the native file path. Explicit
  new/resume and configuration exclude execution. Never silently follow another
  file or branch. Do not replay Lody history or add an identity map.
  session/list reads Pi's native files without starting Pi. session/load
  switches like resume, then replays only the current branch from Pi's entries
  with Pi's tool call ids and each todo snapshot at its original position.
- Steering uses native custom-message metadata, never matching text. Emit the Core
  applied notification before later output; Lody owns its application barrier.
- Keep diagnostics separate from model outcomes. Preserve native error, length
  and cancellation results. Pi stats own context occupancy only: they sum the
  current context, drop with compaction/retry and restore history on resume.
  Usage is live per-response `message.usage` (main, compaction summary, subagent
  children) in a Core accumulator scoped per activation; never seed it from stats.
- stdout is protocol only; diagnostics go to stderr. On Unix, normal connection
  close requests Pi cleanup and terminates its process group; subagents remain
  in that group. V1 accepts that detached shell commands may survive a Pi hard
  crash and require manual termination. Do not add a watchdog or replace Pi's
  shell executor to provide hard-crash containment. Preserve normal Stop/close
  cleanup and fail the ACP connection on unexpected Pi exit; never report success
  or automatically retry. Explicit resume does not reclaim orphaned commands.
- On Windows the executable joins its own kill-on-close Job before spawning Pi.
  The adapter alone holds its handle; process exit kills remaining descendants.
  Unexpected Pi exit terminates the ACP connection with a nonzero adapter exit.
  Ship CI-built Node-API binaries for Windows x64/ARM64; no user-side compilation
  or taskkill fallback when the native module cannot load or join the Job.
- MCP names use the reserved mcp_ prefix and must be unique after normalization.
  Support text/image results; reject other content types instead of stringifying
  them. Preserve error flags and cancellation. Codemode receives the structured
  MCP result so image blocks remain callable through image(). Configuration secrets stay
  in private temporary files, never native history.
- Use acp-extension-core contracts. Advertise only implemented capabilities.
  No permission modes, arbitrary plugin compatibility, TUI, Plan Mode, runtime
  preset/tools plugins or detached subagent jobs in V1.
- Tests use synthetic inputs and explicit signals, no real sleeps or commercial
  providers. Unit tests protect wire contracts; smoke drives the official CLI
  through a local deterministic model endpoint, with an opted-in synthetic
  provider extension covering explicit selection in a separate phase.

Implementation changes use a Draft PR. Before committing run pnpm check,
pnpm build and pnpm smoke. Verify installed tarball behavior for packaging changes.
Remove replaced production paths and their implementation-only tests together.
