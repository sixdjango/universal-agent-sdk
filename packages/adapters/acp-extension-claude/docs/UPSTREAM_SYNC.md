# Upstream main synchronization (2026-09-29)

Merged `agentclientprotocol/claude-agent-acp` main at
[`bdb50ad`](https://github.com/agentclientprotocol/claude-agent-acp/commit/bdb50ad)
(upstream 0.84.0). The previously imported source baseline was `d421f56`
(0.79.0), recorded in the fork's squash commit `c36fc06`.

The merge retains both real parents. Conflict resolution used the already
imported 0.79.0 source as its comparison base, avoiding reintroducing changes
removed by the fork after that synchronization.

## New behavior

- Tools now use shared reporters and field tracking. AIR clients can negotiate
  exact Git patches, plan-file references, and raw-input rendering. Other clients
  retain their standard ACP tool fields and the fork's Core metadata.
- Terminal output prefers deltas when supported. Consolidated assistant and
  subagent messages emit only text that has not already streamed.
- Experimental session notices report live advisories. Informational chunks are
  marked, and usage updates identify the effective model.
- Steering waits for the result that answers the injected input. Interrupted
  compactions close correctly, including cancellation before a user echo.
- Resuming recreates the SDK query when session options or skills change. Model
  lookup reads the transcript tail; native subagent replay reads child transcripts.
- Plan approval reports the effective mode, respects managed bypass restrictions,
  and handles clear-context plans approved during background followups.
- Authentication errors use ACP errors; synthetic quota failures preserve the
  last real context usage. Native Vertex endpoint defaults are preserved.
- Write rendering accepts `path` / `file_text` aliases. Permission prompts and
  file edits use the new shared rendering and patch logic.

## Fork compatibility

- Preserve `acp-extension-claude`, Core 0.1.9, the existing release pipeline, and
  the release-please-controlled fork version. Upstream's 0.84.0 does not manually
  set this fork's package version.
- Keep acknowledged steering's inject-or-refuse contract and correlation events.
- Keep cumulative per-model usage accounting, resumed cost baselines, unknown-cost
  propagation, and already-billed usage on cancellation.
- Keep `_meta.lody.turnId` as the SDK assistant UUID and pass it directly to
  `resumeSessionAt`; no in-memory message-ID mapping is maintained.
- Keep negotiated Core subagent events, ancestry, permission attribution, answer
  notes, and tool/activity metadata.
- Goals retain Core metadata and the `_lody/session/goal` control method. AIR
  clients additionally receive the AIR projection and the advertised control
  method; they should use that advertised method rather than hardcoding the
  upstream method in `air-extensions.md`.

## Dependencies

ACP SDK moves from 1.4.0 to 1.5.1; `diff` 9.0.0 and schema-test dependencies are
added. Claude Agent SDK stays at 0.3.284, which the fork already used. Development
packages follow the upstream updates, including Vitest 5.0.2.
