# Agent guide

An ACP-compatible coding agent powered by the Claude Agent SDK. Source in `src/`,
TypeScript, ESM, Node >= 22.

## Commands

```sh
npm run build         # tsc
npm run test:run      # vitest, single pass
npm run check         # eslint + prettier --check
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
```

Run `npm run check` before opening a PR.

## Code comments

Keep comments straightforward, concise, and concrete. Say what the code does and
why, in plain terms: name the actual state, call, or failure involved instead of
alluding to it. Prefer a short concrete example over an abstract description.
Don't use vague phrases like "keeps it honest" or "the residual case" that make
the reader reconstruct the meaning.

## Pull Requests

- Always open pull requests against the `LodyAI` organization repository
  (`LodyAI/acp-extension-claude`), not a personal fork.

Squash merges use the PR title as the commit subject, and release-please parses it
to compute the next version. Titles must be conventional commits using one of:
`feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`,
`build`, `ci`. `conventional-prs.yml` rejects anything else.

The title also decides the release: `feat:` bumps the minor, `fix:`/`perf:` the
patch, and `chore:`/`ci:`/`test:` and friends do not release at all.

## ACP Turn Forks

- Acknowledged steer is inject-or-refuse. Use JSON-RPC `invalid request`
  (`-32600`) only for proven non-delivery so Lody can queue the same input as a
  normal prompt. Never accept correlated steer once a turn is settling. An
  internal/transport failure is ambiguous and must not authorize automatic retry.

- SDK usage is query-cumulative by model, not top-level per-turn usage. Split
  thinking out of output. Preserve unknown costs across later guessed/known
  snapshots; delta uses the last emitted query baseline and is omitted on a
  counter decrease. Cancellation does not erase already billed result usage.

- Usage model weekly sub-caps come from the OAuth response's `limits` array
  (`weekly_scoped`, `percent`, `scope.model.display_name`), not invented
  `seven_day_<model>` keys. Emit them as labeled Core windows alongside the
  shared quotas in the same `claude` snapshot, including zero-use windows
  without a reset. Never deduplicate quotas by percentage or reset time.

- Agent message updates expose the top-level Claude SDK assistant uuid as
  `_meta.lody.turnId`. `_meta.lody.forkAtTurn.turnId` returns that value unchanged
  and passes it directly to `resumeSessionAt`; do not maintain a message-id mapping.

## Subagent events

- Negotiate Core subagent events before routing child output. Preserve parent
  ancestry and permission attribution; never replay child content into the main
  conversation or advertise run controls backed only by legacy task IDs.

## Releasing

Releases are fully automated by release-please. There is no manual release
workflow, and the version is never chosen by hand — it follows from the commit
history.

```sh
npm run release:preflight     # verifies it is safe to release, prints the PR and version
gh pr merge <pr-number> --squash
```

The preflight is the guard-list as code; if it exits non-zero, follow what it
prints rather than merging. Full runbook, including how to recover a stalled
release: [`docs/RELEASES.md`](docs/RELEASES.md).
