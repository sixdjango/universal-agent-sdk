# Devin ACP adapter guidelines

`CLAUDE.md` is a symlink to this file. The public Lody repository guidelines also apply.

## Scope

- Standalone public adapter. Lody consumes its executable; never import Lody
  workspace packages.
- Launch only the official `devin acp` from an explicit `DEVIN_PATH`. Do not
  patch or bundle Devin. Do not search `PATH`: the managed binary may
  already be a user wrapper.
- Private `cognition.ai/*` methods and `_meta` fields are translated inside the
  adapter only. Every relied-on field is pinned in `runtime-manifest.json` and
  asserted by tests against a fixed official runtime version.
- Advertise only implemented Core capabilities; never declare a `_meta.lody`
  capability before its translation exists.
- stdout carries protocol only; diagnostics go to stderr. On connection close,
  end the child's stdin; propagate child error/exit codes and signals.

## Maintenance workflow

- Use feature branches and pull requests as the default delivery workflow.
  Adapter maintainers own review and merging.
- Before pushing, opening a PR, or updating main, present the changes and
  verification results and obtain explicit approval from the user or
  maintainer directing the task.
- PR descriptions record the implementation rationale, validation scope, and
  adapter/runtime versions. Review the full diff and complete the required
  checks before merging.
- Verify repository permissions and branch rules before choosing the merge
  path. Confirm PR and mainline state through authoritative GitHub data.
- Report implementation, commit, push, PR, and mainline status separately,
  with the relevant commit IDs and PR links.
- Before publishing commits or merges, verify that author and committer
  identities are public-safe; use the approved noreply identity for
  AI-assisted work.

## Subagent events

- Translate the private subagent stream only after bilateral negotiation:
  client `_meta.lody.subagentEvents` in, `cognition.ai/subagentSupport` out.
- Once negotiated, native child output and lifecycle rows never reach the root
  stream; unattributed events must not become root output.
- A snapshot precedes all content of its run; late content after termination is
  dropped. Run IDs are adapter-owned and distinct from Devin agentIds — a reused
  agentId after termination is a new run.
- Sidekick runs are inferred (no wire lifecycle); never invent descriptions or
  summaries for them. `session/load` replay creates no runs.

## Compaction

- The native lifecycle owns completion independently of prompt responses: a
  `/compact` ACK or a client cancel is not a terminal. Only `started`,
  `completed` and `failed` on `_cognition.ai/compaction` drive the activity.
- Emit optional activity metadata only from verified native data; never invent
  duration, token counts, or failure reasons.
- `session/load`/`session/resume` replay creates no live compaction activity.

## Usage accounting

- Translate `usage_update` only for admitted sessions; replay and unadmitted
  sessions produce no `_lody/session/usage_update`.
- Keep Core buckets disjoint: Devin `inputTokens` includes cache reads AND
  writes (`inputTokens = fresh + cachedRead + cachedWrite`; cachedWrite may be
  absent, e.g. SWE-2), so subtract both before filling `inputTokens`. Never
  fabricate `costUSD`;
  unverified private cost meta passes through under `cognition.ai/*` keys.
- Count each inference once across its untagged/context-tagged twins; skip
  `run_subagent` child rows (they bill to the child's identity). Each new
  counted row is a new accumulator operation, so cumulative `modelUsage` and
  per-request `delta` stay consistent.

## MCP

- Forward `session/new` / `session/load` `mcpServers` verbatim. Devin
  `>=3000.11.1` accepts stdio, HTTP and SSE there; the adapter never writes an
  MCP configuration file.

## Local working records

- Optional `local-work/` holds checkout-local working records and evidence.
  Exclude it through this checkout's Git `info/exclude`; never stage or publish
  its contents. `CLAUDE.md` remains a symlink to this file.
- When that directory exists, read `local-work/AGENTS.md` and
  `local-work/STATUS.md` before resuming work, then follow their decision and
  evidence links. Local notes supplement these public rules.
- Public behavior and contributor-wide rules belong in tracked documentation;
  local notes do not replace public contracts or approval.

## Tests

- Synthetic inputs and explicit signals only: no sleeps, no real Devin process,
  no commercial providers. Inject `spawnImpl` for process assertions. Never
  commit captured transcripts; fixtures must be synthetic.

## Checks

- Before committing run `pnpm check` and `pnpm build`.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. AI commits
  end with `Model: <runtime-model-id>`.
