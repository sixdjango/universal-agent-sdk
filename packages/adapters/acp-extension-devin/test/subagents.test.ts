import { describe, expect, it } from "vitest";

import { isLodySubagentEvent } from "acp-extension-core";

import { DevinAcpProxy } from "../src/proxy.js";

const SESSION = "devin-session";
const NOW = 1_700_000_000;

function makeProxy() {
  let n = 0;
  const proxy = new DevinAcpProxy({
    newId: () => `run-${++n}`,
    now: () => NOW,
  });
  return proxy;
}

const negotiatedCaps = {
  _meta: { lody: { subagentEvents: { version: 1 } }, other: "keep" },
};

function initialize(proxy: DevinAcpProxy, caps: unknown = negotiatedCaps) {
  proxy.handleClient({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: caps },
  });
  return proxy.handleRuntime({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: { "cognition.ai/chains": true },
      },
    },
  });
}

function newSession(proxy: DevinAcpProxy, sessionId = SESSION) {
  proxy.handleClient({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/work", mcpServers: [] },
  });
  proxy.handleRuntime({ jsonrpc: "2.0", id: 2, result: { sessionId } });
}

function update(params: Record<string, unknown>, sessionId = SESSION) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: params },
  };
}

function eventsOf(output: { toClient: unknown[] }) {
  return output.toClient
    .filter(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { method?: string }).method === "_lody/subagents/event",
    )
    .map((m) => (m as { params: unknown }).params);
}

function rootUpdatesOf(output: { toClient: unknown[] }) {
  return output.toClient
    .filter(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { method?: string }).method === "session/update",
    )
    .map((m) => (m as { params: { update: unknown } }).params.update);
}

function started(
  agentId: string,
  extra: Record<string, unknown> = {},
  ctx?: string,
) {
  return update({
    sessionUpdate: "tool_call_update",
    toolCallId: agentId,
    status: "in_progress",
    _meta: {
      "cognition.ai/subagent_started": {
        agentId,
        title: "Count things",
        task: "Count the things",
        profile: "General",
        depth: 1,
        isBackground: false,
        model: "Fixture Model",
        ...extra,
      },
      ...(ctx
        ? { "cognition.ai/subagent_context": { parentAgentId: ctx } }
        : {}),
    },
  });
}

function completed(agentId: string, extra: Record<string, unknown> = {}) {
  return update({
    sessionUpdate: "tool_call_update",
    toolCallId: agentId,
    status: "completed",
    _meta: {
      "cognition.ai/subagent_completed": {
        agentId,
        success: true,
        summary: "done",
        depth: 1,
        ...extra,
      },
    },
  });
}

function childCtx(agentId: string) {
  return { "cognition.ai/subagent_context": { parentAgentId: agentId } };
}

function textUpdate(text: string, meta?: Record<string, unknown>) {
  return update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(meta ? { _meta: meta } : {}),
  });
}

function toolUpdate(
  id: string,
  kind: "tool_call" | "tool_call_update",
  meta?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return update({
    sessionUpdate: kind,
    toolCallId: id,
    ...(kind === "tool_call"
      ? {
          title: "Ran ls",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "ls" },
        }
      : { status: extra["status"] ?? "in_progress" }),
    ...(meta ? { _meta: meta } : {}),
  });
}

describe("negotiation", () => {
  it("passes everything through unnegotiated but still advertises subagentEvents", () => {
    const proxy = makeProxy();
    const initOut = initialize(proxy, { fs: { readTextFile: false } });

    const caps = (
      initOut.toClient[0] as {
        result: { agentCapabilities: { _meta: Record<string, unknown> } };
      }
    ).result.agentCapabilities._meta;
    expect(caps["cognition.ai/chains"]).toBe(true);
    expect(caps["lody"]).toEqual({
      subagentEvents: { version: 1 },
      compaction: { version: 1 },
      elicitation: { version: 1 },
      usage: { version: 1 },
    });

    newSession(proxy);
    const u = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "agent-a",
      _meta: {
        "cognition.ai/subagent_started": { agentId: "agent-a", title: "t" },
      },
    });
    expect(proxy.handleRuntime(u).toClient).toEqual([u]);
  });

  it("injects cognition.ai/subagentSupport into the forwarded initialize", () => {
    const proxy = makeProxy();
    const out = proxy.handleClient({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: negotiatedCaps,
      },
    });
    const fwd = out.toRuntime[0] as {
      params: {
        clientCapabilities: { _meta: Record<string, unknown>; fs?: unknown };
      };
    };
    expect(
      fwd.params.clientCapabilities._meta["cognition.ai/subagentSupport"],
    ).toBe(true);
    expect(fwd.params.clientCapabilities._meta["lody"]).toEqual({
      subagentEvents: { version: 1 },
    });
    expect(fwd.params.clientCapabilities._meta["other"]).toBe("keep");
  });
});

describe("run_subagent lifecycle", () => {
  function liveChild(proxy: DevinAcpProxy, agentId = "agent-a") {
    return proxy.handleRuntime(started(agentId));
  }

  it("translates a full subagent lifecycle", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);

    const out = liveChild(proxy);
    const evts = eventsOf(out);
    expect(rootUpdatesOf(out)).toEqual([]);
    expect(evts).toHaveLength(1);
    expect(isLodySubagentEvent(evts[0])).toBe(true);
    expect(evts[0]).toMatchObject({
      type: "snapshot",
      runId: "run-1",
      sessionId: SESSION,
      snapshot: {
        state: "running",
        parentRunId: null,
        name: "General",
        description: "Count things",
        modelId: "Fixture Model",
        startedAtEpochSeconds: NOW,
        support: {
          stream: ["text", "thought", "tool", "plan"],
          progress: true,
          outputRead: "none",
          cancel: false,
        },
      },
    });

    // child tool call → output, not root
    const tc = toolUpdate("functions.exec:0#deadbeef", "tool_call", {
      "cognition.ai/inferenceToolName": "exec",
      ...childCtx("agent-a"),
    });
    const tcOut = proxy.handleRuntime(tc);
    expect(eventsOf(tcOut)).toHaveLength(1);
    expect(eventsOf(tcOut)[0]).toMatchObject({
      type: "output",
      runId: "run-1",
    });
    expect(rootUpdatesOf(tcOut)).toEqual([]);
    for (const e of eventsOf(tcOut)) expect(isLodySubagentEvent(e)).toBe(true);

    // child usage → progress
    const uOut = proxy.handleRuntime(
      update({
        sessionUpdate: "usage_update",
        used: 1234,
        size: 200000,
        _meta: childCtx("agent-a"),
      }),
    );
    expect(eventsOf(uOut)[0]).toMatchObject({
      type: "progress",
      progress: { contextTokens: 1234, contextWindowTokens: 200000 },
    });
    expect(rootUpdatesOf(uOut)).toEqual([]);

    // completed → closing snapshot, dropped from root
    const cOut = proxy.handleRuntime(completed("agent-a"));
    expect(eventsOf(cOut)[0]).toMatchObject({
      type: "snapshot",
      snapshot: {
        state: "completed",
        summary: "done",
        endedAtEpochSeconds: NOW,
      },
    });
    expect(rootUpdatesOf(cOut)).toEqual([]);

    // late child output dropped
    const late = proxy.handleRuntime(
      toolUpdate("functions.exec:0#deadbeef", "tool_call_update", {
        ...childCtx("agent-a"),
      }),
    );
    expect(eventsOf(late)).toEqual([]);
    expect(rootUpdatesOf(late)).toEqual([]);
  });

  it("marks failed completions with reason from summary", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    liveChild(proxy);
    const out = proxy.handleRuntime(
      completed("agent-a", { success: false, summary: "boom" }),
    );
    expect(eventsOf(out)[0]).toMatchObject({
      type: "snapshot",
      snapshot: {
        state: "failed",
        summary: "boom",
        reason: { code: "error", message: "boom" },
      },
    });
  });

  it("buffers child updates arriving before started and replays them in order", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);

    const pre = proxy.handleRuntime(textUpdate("early", childCtx("agent-a")));
    expect(eventsOf(pre)).toEqual([]);
    expect(rootUpdatesOf(pre)).toEqual([]);

    const out = liveChild(proxy);
    const evts = eventsOf(out);
    expect(evts[0]).toMatchObject({
      type: "snapshot",
      snapshot: { state: "running" },
    });
    expect(evts[1]).toMatchObject({ type: "output" });
    for (const e of evts) expect(isLodySubagentEvent(e)).toBe(true);
  });

  it("marks outputIncomplete when the pre-start buffer overflows", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    for (let i = 0; i < 70; i++) {
      proxy.handleRuntime(textUpdate(`chunk-${i}`, childCtx("agent-b")));
    }
    const evts = eventsOf(liveChild(proxy, "agent-b"));
    expect(
      evts.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { type: string }).type === "snapshot" &&
          (e as { snapshot?: { outputIncomplete?: boolean } }).snapshot
            ?.outputIncomplete === true,
      ),
    ).toBe(true);
  });

  it("nests parentRunId from the child context", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    liveChild(proxy, "agent-a"); // run-1
    const out = proxy.handleRuntime(started("agent-b", {}, "agent-a"));
    expect(eventsOf(out)[0]).toMatchObject({
      type: "snapshot",
      runId: "run-2",
      snapshot: { parentRunId: "run-1" },
    });
  });

  it("keeps a background auto-denied tool failure as run output, not root", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    liveChild(proxy, "agent-bg");

    // background agents get approval-requiring tools denied without a
    // permission request; the failed update still belongs to the run
    const denied = proxy.handleRuntime(
      toolUpdate(
        "call_denied",
        "tool_call_update",
        { ...childCtx("agent-bg") },
        { status: "failed" },
      ),
    );
    const evts = eventsOf(denied);
    expect(evts).toHaveLength(1);
    expect(isLodySubagentEvent(evts[0])).toBe(true);
    expect(evts[0]).toMatchObject({
      type: "output",
      runId: "run-1",
      update: { sessionUpdate: "tool_call_update", status: "failed" },
    });
    expect(rootUpdatesOf(denied)).toEqual([]);
  });

  it("gives a reused agentId a new run after termination", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    liveChild(proxy, "agent-a");
    proxy.handleRuntime(completed("agent-a"));
    const out = liveChild(proxy, "agent-a");
    expect(eventsOf(out)[0]).toMatchObject({
      runId: "run-2",
      type: "snapshot",
    });
  });
});

function skTool(id: string, status?: string) {
  return update({
    sessionUpdate: status === undefined ? "tool_call" : "tool_call_update",
    toolCallId: id,
    ...(status === undefined
      ? {
          title: "Ran ls",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "ls" },
        }
      : { status }),
    _meta: {
      "cognition.ai/inferenceToolName": "exec",
      "cognition.ai/sidekick": true,
    },
  });
}

describe("sidekick", () => {
  it("infers a Sidekick run, closes it when root resumes, reopens on next activity", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);

    // sidekick usage alone never opens a run — it is stashed
    const uOut = proxy.handleRuntime(
      update({
        sessionUpdate: "usage_update",
        used: 500,
        size: 262000,
        _meta: childCtx("sidekick"),
      }),
    );
    expect(eventsOf(uOut)).toEqual([]);
    expect(rootUpdatesOf(uOut)).toEqual([]);

    // first sk tool opens the run: snapshot then the stashed progress, then output
    const t1 = proxy.handleRuntime(skTool("sk::call_aaa#1"));
    const evts = eventsOf(t1);
    expect(evts[0]).toMatchObject({
      type: "snapshot",
      runId: "run-1",
      snapshot: {
        state: "running",
        parentRunId: null,
        name: "Sidekick",
        support: { stream: ["tool"], progress: true },
      },
    });
    expect(evts[1]).toMatchObject({
      type: "progress",
      progress: { contextTokens: 500, contextWindowTokens: 262000 },
    });
    expect(evts[2]).toMatchObject({ type: "output", runId: "run-1" });
    expect(rootUpdatesOf(t1)).toEqual([]);
    for (const e of evts) expect(isLodySubagentEvent(e)).toBe(true);

    const t2 = proxy.handleRuntime(skTool("sk::call_aaa#1", "completed"));
    expect(eventsOf(t2)).toHaveLength(1);

    // root message arrives after tools done → close first, then forward
    const mOut = proxy.handleRuntime(textUpdate("done"));
    const evts2 = eventsOf(mOut);
    expect(evts2[0]).toMatchObject({
      type: "snapshot",
      snapshot: { state: "completed", endedAtEpochSeconds: NOW },
    });
    const roots = rootUpdatesOf(mOut);
    expect(roots).toHaveLength(1);
    // ordering: closing snapshot precedes the root update
    const kinds = mOut.toClient.map((m) => (m as { method?: string }).method);
    expect(kinds).toEqual(["_lody/subagents/event", "session/update"]);

    // next sidekick activity → new run
    const again = proxy.handleRuntime(skTool("sk::call_bbb#1"));
    expect(eventsOf(again)[0]).toMatchObject({
      type: "snapshot",
      runId: "run-2",
      snapshot: { state: "running", name: "Sidekick" },
    });
  });

  it("defers close while sidekick tools are in flight", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);

    proxy.handleRuntime(skTool("sk::call_x#1")); // opens run, in-flight
    const mid = proxy.handleRuntime(textUpdate("root says hi"));
    // root activity while in-flight: forwarded, no close yet
    expect(rootUpdatesOf(mid)).toHaveLength(1);
    expect(eventsOf(mid)).toEqual([]);

    const end = proxy.handleRuntime(skTool("sk::call_x#1", "completed"));
    const evts = eventsOf(end);
    expect(evts[0]).toMatchObject({ type: "output" });
    expect(evts[1]).toMatchObject({
      type: "snapshot",
      snapshot: { state: "completed" },
    });
  });

  it("drops late updates for tools of a closed sidekick run", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(skTool("sk::call_late#1"));
    proxy.handleRuntime(skTool("sk::call_late#1", "completed"));
    proxy.handleRuntime(textUpdate("hi")); // closes the run
    const late = proxy.handleRuntime(skTool("sk::call_late#1", "in_progress"));
    expect(eventsOf(late)).toEqual([]);
    expect(rootUpdatesOf(late)).toEqual([]);
  });

  it("drops late updates for tools of an earlier closed sidekick run", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    // run 1
    proxy.handleRuntime(skTool("sk::call_first#1"));
    proxy.handleRuntime(skTool("sk::call_first#1", "completed"));
    proxy.handleRuntime(textUpdate("one")); // closes run-1
    // run 2
    proxy.handleRuntime(skTool("sk::call_second#1"));
    proxy.handleRuntime(skTool("sk::call_second#1", "completed"));
    proxy.handleRuntime(textUpdate("two")); // closes run-2
    const late = proxy.handleRuntime(skTool("sk::call_first#1", "in_progress"));
    expect(eventsOf(late)).toEqual([]);
    expect(rootUpdatesOf(late)).toEqual([]);
  });

  it("does not reopen a run for trailing sidekick usage after close", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(skTool("sk::call_z#1"));
    proxy.handleRuntime(skTool("sk::call_z#1", "completed"));
    proxy.handleRuntime(textUpdate("bye")); // closes the run
    const trailing = proxy.handleRuntime(
      update({
        sessionUpdate: "usage_update",
        used: 900,
        size: 262000,
        _meta: childCtx("sidekick"),
      }),
    );
    expect(eventsOf(trailing)).toEqual([]);
    expect(rootUpdatesOf(trailing)).toEqual([]);
  });

  it("does not leak a stale deferral flag into the next run", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    const promptDone = () =>
      proxy.handleRuntime({
        jsonrpc: "2.0",
        id: 9,
        result: { stopReason: "end_turn" },
      });
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId: SESSION, prompt: [{ type: "text", text: "p1" }] },
    });

    // prompt1: sidekick tool in flight + root text sets the deferral flag,
    // prompt end closes the run and must clear the flag
    proxy.handleRuntime(skTool("sk::call_p1#1"));
    proxy.handleRuntime(textUpdate("root interjects"));
    const closed = promptDone();
    expect(eventsOf(closed)[0]).toMatchObject({
      type: "snapshot",
      snapshot: { state: "completed" },
    });

    // prompt2: a completed update inside the next run must not close it
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 10,
      method: "session/prompt",
      params: { sessionId: SESSION, prompt: [{ type: "text", text: "p2" }] },
    });
    const opened = proxy.handleRuntime(skTool("sk::call_p2#1"));
    expect(eventsOf(opened)[0]).toMatchObject({
      type: "snapshot",
      runId: "run-2",
      snapshot: { state: "running" },
    });
    const done = proxy.handleRuntime(skTool("sk::call_p2#1", "completed"));
    expect(eventsOf(done)).toEqual([
      expect.objectContaining({ type: "output" }),
    ]);
    // next tool stays in the same run, no close in between
    const next = proxy.handleRuntime(skTool("sk::call_p2b#1"));
    const nextEvents = eventsOf(next);
    expect(nextEvents).toHaveLength(1);
    expect(nextEvents[0]).toMatchObject({ type: "output", runId: "run-2" });
  });
});

describe("prompt end", () => {
  function promptDone(proxy: DevinAcpProxy, result: unknown) {
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId: SESSION, prompt: [{ type: "text", text: "x" }] },
    });
    if (result && typeof result === "object" && "error" in result) {
      return proxy.handleRuntime({
        jsonrpc: "2.0",
        id: 9,
        error: (result as { error: unknown }).error,
      });
    }
    return proxy.handleRuntime({ jsonrpc: "2.0", id: 9, result });
  }

  function openSidekick(proxy: DevinAcpProxy) {
    proxy.handleRuntime(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "sk::call_p#1",
        title: "Ran ls",
        kind: "execute",
        status: null,
        rawInput: {},
        _meta: { "cognition.ai/sidekick": true },
      }),
    );
  }

  it("closes a live sidekick run completed on end_turn, before the response", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    openSidekick(proxy);
    const out = promptDone(proxy, { stopReason: "end_turn" });
    const first = out.toClient[0] as { params: unknown };
    expect(isLodySubagentEvent(first.params)).toBe(true);
    expect(first.params).toMatchObject({
      type: "snapshot",
      snapshot: { state: "completed" },
    });
    expect(out.toClient[1]).toMatchObject({ id: 9 });
  });

  it("closes cancelled on stopReason cancelled", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    openSidekick(proxy);
    const out = promptDone(proxy, { stopReason: "cancelled" });
    expect(eventsOf(out)[0]).toMatchObject({
      type: "snapshot",
      snapshot: { state: "cancelled", reason: { code: "cancelled" } },
    });
  });

  it("closes unknown+outputIncomplete on error responses", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    openSidekick(proxy);
    const out = promptDone(proxy, { error: { code: -32000, message: "x" } });
    expect(eventsOf(out)[0]).toMatchObject({
      type: "snapshot",
      snapshot: {
        state: "unknown",
        outputIncomplete: true,
        reason: { code: "error" },
      },
    });
  });
});

describe("permission mirroring", () => {
  it("rewrites run-owned permission requests and mirrors their updates to root", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(started("agent-a"));

    const tc = toolUpdate("functions.exec:0#deadbeef", "tool_call", {
      "cognition.ai/inferenceToolName": "exec",
      ...childCtx("agent-a"),
    });
    proxy.handleRuntime(tc); // records the toolCallId on the run

    const perm = {
      jsonrpc: "2.0",
      id: 50,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "functions.exec:0#deadbeef", title: "x" },
        options: [{ optionId: "allow" }],
      },
    };
    const out = proxy.handleRuntime(perm);
    const fwd = out.toClient[0] as typeof perm;
    expect(fwd.params.toolCall.toolCallId).toBe(
      `subagent:${encodeURIComponent("run-1")}:${encodeURIComponent("functions.exec:0#deadbeef")}`,
    );
    expect(fwd.params).toMatchObject({
      sessionId: SESSION,
      _meta: {
        lody: {
          subagentRunId: "run-1",
          subagentToolCallId: "functions.exec:0#deadbeef",
        },
      },
    });

    // a later update for that id emits a root mirror alongside the run output
    const mirror = proxy.handleRuntime(
      toolUpdate("functions.exec:0#deadbeef", "tool_call_update", {
        ...childCtx("agent-a"),
      }),
    );
    const roots = rootUpdatesOf(mirror);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      toolCallId: `subagent:${encodeURIComponent("run-1")}:${encodeURIComponent("functions.exec:0#deadbeef")}`,
      _meta: {
        lody: {
          subagentRunId: "run-1",
          subagentToolCallId: "functions.exec:0#deadbeef",
        },
      },
    });
  });

  it("emits the run snapshot before a permission-first sidekick request", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    const perm = {
      jsonrpc: "2.0",
      id: 60,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "sk::call_perm#1", title: "x" },
        options: [{ optionId: "allow" }],
      },
    };
    const out = proxy.handleRuntime(perm);
    const events = eventsOf(out);
    expect(events).toHaveLength(1);
    expect(isLodySubagentEvent(events[0])).toBe(true);
    expect(events[0]).toMatchObject({
      type: "snapshot",
      runId: "run-1",
      snapshot: { state: "running", name: "Sidekick" },
    });
    // snapshot precedes the rewritten request
    const kinds = out.toClient.map((m) => (m as { method?: string }).method);
    expect(kinds).toEqual([
      "_lody/subagents/event",
      "session/request_permission",
    ]);
    const fwd = out.toClient[1] as typeof perm;
    expect(fwd.params.toolCall.toolCallId).toBe(
      `subagent:${encodeURIComponent("run-1")}:${encodeURIComponent("sk::call_perm#1")}`,
    );
    expect(fwd.params).toMatchObject({
      _meta: {
        lody: {
          subagentRunId: "run-1",
          subagentToolCallId: "sk::call_perm#1",
        },
      },
    });
  });

  it("attaches an unseen sk:: permission id to the live sidekick run", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(skTool("sk::call_live#1")); // live run, other tool
    const perm = {
      jsonrpc: "2.0",
      id: 61,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "sk::call_unseen#1" },
        options: [],
      },
    };
    const out = proxy.handleRuntime(perm);
    const fwd = out.toClient[0] as typeof perm;
    expect(fwd.params.toolCall.toolCallId).toBe(
      `subagent:${encodeURIComponent("run-1")}:${encodeURIComponent("sk::call_unseen#1")}`,
    );
  });

  it("passes permissions for non-run tools through verbatim", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    const perm = {
      jsonrpc: "2.0",
      id: 51,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "functions.exec:9#nope" },
        options: [],
      },
    };
    expect(proxy.handleRuntime(perm).toClient).toEqual([perm]);
  });

  it("rewrites a sidekick perm for an sk::exec id when the request has no meta", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    // the tool_call carried the sidekick flag; the permission request does not
    proxy.handleRuntime(skTool("sk::exec:0#abc123"));
    const perm = {
      jsonrpc: "2.0",
      id: 62,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: {
          toolCallId: "sk::exec:0#abc123",
          title: "Run command",
          _meta: { "cognition.ai/editableCommand": "ls" },
        },
        options: [{ optionId: "allow" }],
      },
    };
    const out = proxy.handleRuntime(perm);
    const fwd = out.toClient[0] as typeof perm;
    expect(fwd.params.toolCall.toolCallId).toBe(
      `subagent:${encodeURIComponent("run-1")}:${encodeURIComponent("sk::exec:0#abc123")}`,
    );
    expect(fwd.params).toMatchObject({
      _meta: {
        lody: {
          subagentRunId: "run-1",
          subagentToolCallId: "sk::exec:0#abc123",
        },
      },
    });
  });

  it("routes a context-free child permission via the earlier child tool_call", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(started("agent-a"));
    proxy.handleRuntime(
      toolUpdate("call_plainid", "tool_call", {
        "cognition.ai/inferenceToolName": "exec",
        ...childCtx("agent-a"),
      }),
    );
    // permission requests carry no subagent_context — ownership comes from
    // the toolCallId recorded on the run
    const perm = {
      jsonrpc: "2.0",
      id: 63,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "call_plainid", title: "x" },
        options: [],
      },
    };
    const out = proxy.handleRuntime(perm);
    const fwd = out.toClient[0] as typeof perm;
    expect(fwd.params.toolCall.toolCallId).toBe(
      `subagent:${encodeURIComponent("run-1")}:call_plainid`,
    );
    expect(fwd.params).toMatchObject({
      _meta: { lody: { subagentRunId: "run-1" } },
    });
  });

  it("routes a permission for a resumed agentId to the new run", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(started("agent-a")); // run-1
    proxy.handleRuntime(
      toolUpdate("call_old", "tool_call", childCtx("agent-a")),
    );
    proxy.handleRuntime(completed("agent-a"));
    proxy.handleRuntime(started("agent-a", { isBackground: false })); // run-2
    proxy.handleRuntime(
      toolUpdate("call_new", "tool_call", childCtx("agent-a")),
    );

    const perm = {
      jsonrpc: "2.0",
      id: 64,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "call_new", title: "x" },
        options: [],
      },
    };
    const fwd = proxy.handleRuntime(perm).toClient[0] as typeof perm;
    expect(fwd.params).toMatchObject({
      toolCall: {
        toolCallId: `subagent:${encodeURIComponent("run-2")}:call_new`,
      },
      _meta: { lody: { subagentRunId: "run-2" } },
    });
  });

  it("merges remembered tool display fields into a mirrored permission", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(started("agent-a"));
    proxy.handleRuntime(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_display",
        title: "List files",
        kind: "execute",
        rawInput: { command: "ls -la /work" },
        _meta: childCtx("agent-a"),
      }),
    );
    // Devin's permission request carries only the id and its own meta
    const perm = {
      jsonrpc: "2.0",
      id: 70,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: {
          toolCallId: "call_display",
          _meta: { "cognition.ai/editableCommand": "ls -la /work" },
        },
        options: [{ optionId: "allow" }],
      },
    };
    const fwd = proxy.handleRuntime(perm).toClient[0] as typeof perm;
    expect(fwd.params.toolCall).toMatchObject({
      toolCallId: `subagent:${encodeURIComponent("run-1")}:call_display`,
      title: "List files",
      kind: "execute",
      rawInput: { command: "ls -la /work" },
      _meta: { "cognition.ai/editableCommand": "ls -la /work" },
    });
  });

  it("lets a later tool_call_update title override the stored display", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(started("agent-a"));
    proxy.handleRuntime(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_override",
        title: "Initial title",
        kind: "execute",
        _meta: childCtx("agent-a"),
      }),
    );
    proxy.handleRuntime(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_override",
        title: "Updated title",
        status: "in_progress",
        _meta: childCtx("agent-a"),
      }),
    );
    const perm = {
      jsonrpc: "2.0",
      id: 71,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "call_override" },
        options: [],
      },
    };
    const fwd = proxy.handleRuntime(perm).toClient[0] as typeof perm;
    expect(fwd.params.toolCall).toMatchObject({
      title: "Updated title",
      kind: "execute",
    });
  });

  it("keeps a request-supplied title over the stored display", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(started("agent-a"));
    proxy.handleRuntime(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call_reqtitle",
        title: "Stored title",
        _meta: childCtx("agent-a"),
      }),
    );
    const perm = {
      jsonrpc: "2.0",
      id: 72,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "call_reqtitle", title: "Request title" },
        options: [],
      },
    };
    const fwd = proxy.handleRuntime(perm).toClient[0] as typeof perm;
    expect(fwd.params.toolCall["title"]).toBe("Request title");
  });

  it("merges stored display fields for a sidekick sk:: permission", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "sk::exec:0#feed42",
        title: "Run touch",
        kind: "execute",
        rawInput: { command: "touch /work/sk.txt" },
        _meta: { "cognition.ai/sidekick": true },
      }),
    );
    const perm = {
      jsonrpc: "2.0",
      id: 73,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "sk::exec:0#feed42" },
        options: [],
      },
    };
    const fwd = proxy.handleRuntime(perm).toClient[0] as typeof perm;
    expect(fwd.params.toolCall).toMatchObject({
      toolCallId: `subagent:${encodeURIComponent("run-1")}:${encodeURIComponent("sk::exec:0#feed42")}`,
      title: "Run touch",
      kind: "execute",
      rawInput: { command: "touch /work/sk.txt" },
    });
  });

  it("invents no display fields when permission precedes any tool_call", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    const out = proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 75,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "sk::exec:0#brand-new" },
        options: [],
      },
    });
    // snapshot event precedes the rewritten request; the mirrored toolCall
    // carries only the namespaced id — no fields invented
    const fwd = out.toClient[out.toClient.length - 1] as {
      params: { toolCall: Record<string, unknown> };
    };
    expect(fwd.params.toolCall).toEqual({
      toolCallId: `subagent:${encodeURIComponent("run-1")}:${encodeURIComponent("sk::exec:0#brand-new")}`,
    });
  });

  it("passes a root tool permission through while a run is live", () => {
    const proxy = makeProxy();
    initialize(proxy);
    newSession(proxy);
    proxy.handleRuntime(skTool("sk::call_root#1")); // live sidekick run
    const perm = {
      jsonrpc: "2.0",
      id: 65,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "call_roottool", title: "x" },
        options: [],
      },
    };
    expect(proxy.handleRuntime(perm).toClient).toEqual([perm]);
  });
});

describe("session admission and replay", () => {
  it("passes session/update through during a session/load replay window", () => {
    const proxy = makeProxy();
    initialize(proxy);
    // session/load request → replay window opens
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: SESSION, cwd: "/work", mcpServers: [] },
    });
    const u = update({
      sessionUpdate: "tool_call_update",
      toolCallId: "agent-a",
      _meta: { "cognition.ai/subagent_started": { agentId: "agent-a" } },
    });
    expect(proxy.handleRuntime(u).toClient).toEqual([u]);
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 3,
      result: { sessionId: SESSION },
    });
    // admitted now; started lines after the window translate again
    const post = proxy.handleRuntime(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-b",
        _meta: { "cognition.ai/subagent_started": { agentId: "agent-b" } },
      }),
    );
    expect(eventsOf(post)).toHaveLength(1);
  });

  it("passes updates for unadmitted sessions through", () => {
    const proxy = makeProxy();
    initialize(proxy);
    const u = update(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "agent-a",
        _meta: { "cognition.ai/subagent_started": { agentId: "agent-a" } },
      },
      "other-session",
    );
    expect(proxy.handleRuntime(u).toClient).toEqual([u]);
  });
});
