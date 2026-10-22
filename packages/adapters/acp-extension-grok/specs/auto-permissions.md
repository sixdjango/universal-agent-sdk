# Grok Auto permissions

Status: draft
Translation: current

[中文](auto-permissions.zh.md)

Users can request Ask, Auto, or Always Approve independently of Plan mode. Auto
asks the official Grok runtime to classify tool actions. The wrapper does not
implement its own classifier or automatically approve requests left interactive
by Grok. Questions and Plan implementation decisions require explicit answers.

Auto is offered only when the runtime reports the manifest's verified minimum
Auto version or newer during initialization. Unknown/older versions reject Auto,
including restored selections, before creating or copying a session. A stable
client identifier is required. New/load/resume/fork seed both permission flags;
missing selections inherit this wrapper's client policy, otherwise Ask. Changes
use the existing client-scoped native notification. Switching away from YOLO
stops the wrapper's automatic approval of new requests immediately; pending host
requests remain owned by the host.

The config value represents the requested policy. Grok's native switch has no
acknowledgement or effective-state query. Its own gate can disable Auto and leave
the runtime in Ask. The option description must state this possibility. Neither
version support nor an accepted config setter proves Auto is active. The wrapper
must not override the gate, duplicate native policy resolution, or invent an
effective-state signal. An effective-state control requires an upstream protocol
contract that is currently absent.

A host must send the standard config setter for a running session or carry the
selection into its next session/turn submission. Editing a host's draft is not a
runtime switch. Host catalogs and runtime distribution belong to the host release;
this standalone adapter does not publish or update those artifacts.

## Evidence and validation

- [Adapter](../src/proxy.js), [deterministic tests](../test/proxy.test.js).
- [Native probe](../scripts/probe-auto-permissions.mjs): real official binary,
  isolated settings/history, synthetic loopback sampling, observed native mode,
  classifier invocation, interactive requests, and actual tool execution.
- [Decision and limits](../.agents/notes/implemented/feature/2026-10-07-native-auto-permissions.md).
