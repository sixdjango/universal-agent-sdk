# Grok plan approval transport

Status: implemented
Translation: pending

## Abstract

The Core boolean Plan toggle did not translate Grok's native plan approval request.
Lody ignored the private method, returned an empty response, and Grok treated it as
cancellation. The adapter now presents the plan and decision using standard ACP,
while Lody excludes mode-switch decisions from its Grok Always Approve policy.
Provider-specific request/response translation stays inside the wrapper.

## Contract and decisions

Grok sends `x.ai/exit_plan_mode` with `sessionId`, `toolCallId`, and nullable
`planContent`. Gateway envelopes also wrap the params and result. The bridge retains
the request id independently of client-originated requests, publishes markdown
`plan_update` when supported, and otherwise places text on a `switch_mode` tool.
Approval uses `session/request_permission`. Revision feedback uses an optional
standard form elicitation with Core metadata; clients without forms keep planning
without feedback. Abandon is explicit. Errors and cancellation never approve.
Native mode notifications update the Core boolean option without changing permission.

The host must not auto-answer `switch_mode` decisions, including already waiting
requests when Always Approve is enabled. The adapter and host changes must roll out
together. This uses existing Core/ACP contracts; no new Core RPC is introduced.

## Evidence and validation

Upstream inspected at xai-org/grok-build commit
`72a61251fcffb464bcc687aeb5a998e5a98ec0c9`: exit_plan_mode/types.rs,
acp_session_impl/tool_calls.rs, and leader/server_tests.rs in crates/codegen.
Deterministic proxy tests cover decisions, envelopes, feedback, fallback clients,
empty plans, cancellation, request-id directionality, and mode synchronization.
Host tests cover new and waiting plan decisions under Always Approve.
No live authenticated Grok turn or runtime publication is included.
