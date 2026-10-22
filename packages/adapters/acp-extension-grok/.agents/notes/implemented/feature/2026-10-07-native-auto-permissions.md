# Restore native Auto with Grok 1.0.46

Status: implemented
Translation: current

[中文](2026-10-07-native-auto-permissions.zh.md)

## Abstract

Auto was removed while fixing YOLO permission UI behavior; the old integration
had no reliable runtime acknowledgement and no authenticated turn verification.
This change pins official Grok 1.0.46 and restores Auto through its native startup
flags and client-scoped notification, with a separate verified version floor.
The official binary passes an isolated loopback-model probe that observes actual
mode, classification, and tool execution. The protocol still cannot acknowledge
effective Auto state, so the displayed selection explicitly remains a requested
policy and Grok's gate may fall back to Ask.

## Decision and ownership

This partially supersedes [the September fallback decision](../bug-fix/2026-09-09-yolo-permission-fallback.md):
Auto returns; YOLO's adapter fallback, explicit Plan approval, and host ownership
of forwarded requests remain. It implements the [draft Auto spec](../../../../specs/auto-permissions.md).
The historical failure was not a demonstrated defect in Grok's Auto classifier.
The host's draft-only selector and pending-history UI were separate concerns.

The runtime pin is 1.0.46, baseline compatibility remains 1.0.34, and Auto requires
a reported version of at least 1.0.46. Old/unknown versions reject Auto before
creation/forking instead of claiming success or silently restoring Ask. Adapter
0.1.4 invalidates permission capability caches. No dependencies changed.

All startup paths explicitly seed `yoloMode` and `autoMode`, including inherited
client selections on replacement and explicit false values. Runtime notifications
preserve the client identifier. Auto passes native permission requests through;
it never invokes YOLO's allow-option fallback. Standard Plan/model changes do not
alter the requested policy. No new host RPC, stream, subscription, or production
hook is introduced.

Grok's settings notification contains a remote flag rather than the full resolved
gate, and session info omits effective permission mode. Neither is a substitute
for acknowledgement. The adapter therefore describes Auto as requested, does not
mirror native configuration precedence, and does not force the gate on. This
retains a visible limitation instead of inventing an effective-state contract.
Host static catalogs, the input-box submission behavior, and managed runtime
publication require host integration; this repository does not change them.

## Validation

- 91 deterministic adapter/process tests pass; syntax build/typecheck pass.
- `probe-auto-permissions.mjs` uses the production entry point and official macOS
  arm64 1.0.46 (`grok 1.0.46 (2765805b9442)`), with binary SHA-256
  `e8daa302364c9c3b6a5546d511cfbd1ab5e5d407a9b04282f660665ea405f9f3`.
- A loopback Chat Completions fixture supplies tool calls and classifier verdicts.
  The harmless write-redirection command forces a classifier side query; a routine
  Python command did not, because the native classifier's heuristic pre-pass
  allowed it. Merely observing a successful command is insufficient verification.
- The probe asserts actual native mode from test-only hook events, classifier
  calls, permissions delivered to the client, and marker-file execution. It covers
  new, warm/cold load/resume, fork with continued source use, all three mode
  transitions, classifier allow/block/unavailable, and gate-disabled startup/live
  Auto falling back to interactive Ask.
- No real credentials, user histories, hosted inference, or account charges are
  involved. Hosted classifier quality, other platforms, and host UI integration
  are not validated. The integration probe is opt-in, separate from the offline
  deterministic suite, and uses protocol completion rather than sleeps.
- Parent Lody `docs status/check` commands are unavailable in this standalone
  package (no docs script; local pnpm launcher also lacks its cached entry point).
  Local Markdown links and diff whitespace are checked directly.
