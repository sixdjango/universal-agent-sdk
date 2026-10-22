# Resolve YOLO tool permissions inside the Grok adapter

Status: implemented
Translation: pending

## Abstract

Grok can request tool approval even while YOLO is selected. The adapter now answers
new permission requests directly, preferring allow_once and falling back to
allow_always, so hosts never render these requests as pending. Auto is removed;
legacy startup Auto restores as Ask and live Auto requests fail without changing
policy. Persistent allow options may create native grants, and adapter-resolved
requests no longer create host permission-history entries.

## Ownership and boundaries

This supersedes the previous native-request passthrough decision for new YOLO tool
requests. Requests already forwarded remain client-owned. Questions, mode-switch
approvals, unknown sessions, and requests without usable allow options remain
interactive. The [Plan approval contract](2026-09-08-plan-approval.md) is preserved.
Only ACP option kinds authorize selection; labels and id substrings do not.
Reverse request ids remain independent of pending client requests.

Ask and Always Approve explicitly disable autoMode at startup. The adapter still
uses the official client-scoped notification for live permission changes; its
accepted policy is not an acknowledgement from the runtime. Version 0.1.3
invalidates host capability caches without changing dependency resolution.

## Validation

Based on main f3f59e1 and Core 0.1.1. All 57 deterministic adapter tests pass in a
scratch copy with the current Core compiled locally. Syntax build, formatting,
and diff checks pass. Tests include Plan approval, startup/restore, permission
switches, AllowAlways fallback, client isolation, and bidirectional id collisions.
No authenticated model turn or package publication was performed.
