import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DevinAcpProxy } from "../src/proxy.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
};

const initializeResponse = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
  },
};

describe("DevinAcpProxy", () => {
  it("passes a client initialize request to the runtime and its response back", () => {
    const proxy = new DevinAcpProxy();

    expect(proxy.handleClient(initializeRequest)).toEqual({
      toClient: [],
      toRuntime: [initializeRequest],
    });
    expect(proxy.pendingClientMethod(1)).toBe("initialize");

    expect(proxy.handleRuntime(initializeResponse)).toEqual({
      toClient: [
        {
          ...initializeResponse,
          result: {
            ...initializeResponse.result,
            agentCapabilities: {
              ...initializeResponse.result.agentCapabilities,
              _meta: {
                lody: {
                  subagentEvents: { version: 1 },
                  compaction: { version: 1 },
                  elicitation: { version: 1 },
                  usage: { version: 1 },
                },
              },
            },
          },
        },
      ],
      toRuntime: [],
    });
    expect(proxy.pendingClientMethod(1)).toBeUndefined();
  });

  it("forwards runtime session/update notifications to the client verbatim", () => {
    const proxy = new DevinAcpProxy();
    const update = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "devin-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    };

    expect(proxy.handleRuntime(update)).toEqual({
      toClient: [update],
      toRuntime: [],
    });
  });

  it("forwards session/new and session/load mcpServers verbatim, negotiated or not", () => {
    const mcpServers = [
      {
        type: "stdio",
        name: "probe-stdio",
        command: "/bin/probe",
        args: ["--serve"],
        env: [
          { name: "PROBE_FLAG", value: "1" },
          { name: "SECOND", value: "two" },
        ],
      },
      {
        type: "http",
        name: "probe-http",
        url: "http://127.0.0.1:8765/mcp",
        headers: [
          { name: "Authorization", value: "Bearer probe-token" },
          { name: "X-Probe", value: "1" },
        ],
      },
      {
        type: "sse",
        name: "probe-sse",
        url: "http://127.0.0.1:8766/sse",
        headers: [{ name: "X-Probe", value: "2" }],
      },
    ];

    for (const negotiated of [false, true]) {
      const proxy = new DevinAcpProxy();
      proxy.handleClient({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: negotiated
            ? { _meta: { lody: { subagentEvents: { version: 1 } } } }
            : {},
        },
      });

      for (const method of ["session/new", "session/load"] as const) {
        const request =
          method === "session/new"
            ? {
                jsonrpc: "2.0",
                id: 2,
                method,
                params: { cwd: "/work", mcpServers },
              }
            : {
                jsonrpc: "2.0",
                id: 3,
                method,
                params: {
                  sessionId: "devin-session",
                  cwd: "/work",
                  mcpServers,
                },
              };
        const out = proxy.handleClient(request);
        expect(out.toClient).toEqual([]);
        expect(out.toRuntime).toHaveLength(1);
        expect((out.toRuntime[0] as typeof request).params.mcpServers).toEqual(
          mcpServers,
        );
      }
    }
  });

  it("passes runtime reverse requests and client responses through without touching pending", () => {
    const proxy = new DevinAcpProxy();

    const promptRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: { sessionId: "devin-session", prompt: [] },
    };
    proxy.handleClient(promptRequest);
    expect(proxy.pendingClientMethod(7)).toBe("session/prompt");

    // Both directions own separate id spaces; a reverse request may reuse the id.
    const reverseRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { sessionId: "devin-session", options: [] },
    };
    expect(proxy.handleRuntime(reverseRequest)).toEqual({
      toClient: [reverseRequest],
      toRuntime: [],
    });

    const clientResponse = {
      jsonrpc: "2.0",
      id: 7,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    };
    expect(proxy.handleClient(clientResponse)).toEqual({
      toClient: [],
      toRuntime: [clientResponse],
    });
    expect(proxy.pendingClientMethod(7)).toBe("session/prompt");

    const promptResponse = {
      jsonrpc: "2.0",
      id: 7,
      result: { stopReason: "end_turn" },
    };
    expect(proxy.handleRuntime(promptResponse)).toEqual({
      toClient: [promptResponse],
      toRuntime: [],
    });
    expect(proxy.pendingClientMethod(7)).toBeUndefined();
  });
});

describe("runtime manifest", () => {
  const manifestPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "runtime-manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    officialRuntime: Record<string, string>;
    privateWireContract: Record<string, string>;
  };

  it("pins the official Devin runtime", () => {
    expect(manifest.officialRuntime).toEqual({
      package: "devin",
      version: "3000.11.3",
      minimumSupportedVersion: "3000.11.1",
    });
  });

  it("adapts the official runtime wire contract", () => {
    const contract = manifest.privateWireContract;
    expect(contract.sidekickToolCallMeta).toBe("cognition.ai/sidekick");
    expect(contract.sidekickToolCallIdPrefix).toBe("sk::");
    expect(contract.subagentContextMeta).toBe("cognition.ai/subagent_context");
    expect(contract.subagentStartedMeta).toBe("cognition.ai/subagent_started");
    expect(contract.subagentCompletedMeta).toBe(
      "cognition.ai/subagent_completed",
    );
    expect(contract.subagentSupportClientCapability).toBe(
      "cognition.ai/subagentSupport",
    );
    expect(contract.rootAgentId).toBe("root");
    expect(contract.sidekickAgentId).toBe("sidekick");
    expect(contract.toolNameMeta).toBe("cognition.ai/toolName");
    expect(contract.inferenceToolNameMeta).toBe(
      "cognition.ai/inferenceToolName",
    );
    expect(contract.compactionNotificationMethod).toBe(
      "_cognition.ai/compaction",
    );
    expect(contract.compactionSessionIdField).toBe("sessionId");
    expect(contract.compactionStatusField).toBe("status");
    expect(contract.compactionSummaryField).toBe("summary");
    expect(contract.compactionStartedStatus).toBe("started");
    expect(contract.compactionCompletedStatus).toBe("completed");
    expect(contract.compactionFailedStatus).toBe("failed");
    expect(contract.compactionManualCommand).toBe("/compact");
    expect(contract.usageInputTokensMeta).toBe("cognition.ai/inputTokens");
    expect(contract.usageOutputTokensMeta).toBe("cognition.ai/outputTokens");
    expect(contract.usageCachedReadTokensMeta).toBe(
      "cognition.ai/cachedReadTokens",
    );
    expect(contract.usageCachedWriteTokensMeta).toBe(
      "cognition.ai/cachedWriteTokens",
    );
    expect(contract.usageTotalCreditCostMeta).toBe(
      "cognition.ai/totalCreditCost",
    );
    expect(contract.usageTotalAcuCostMeta).toBe("cognition.ai/totalAcuCost");
    expect(contract.usageResponseDimensionsMeta).toBe(
      "cognition.ai/responseDimensions",
    );
  });
});

describe("compaction lifecycle translation", () => {
  let nextId = 0;
  beforeEach(() => {
    nextId = 0;
  });
  const compaction = (
    sessionId: unknown,
    status: string,
    summary?: unknown,
  ) => ({
    jsonrpc: "2.0",
    method: "_cognition.ai/compaction",
    params: {
      sessionId,
      status,
      ...(summary !== undefined ? { summary } : {}),
    },
  });
  const newProxy = () => new DevinAcpProxy({ newId: () => `id-${++nextId}` });
  const initialize = (proxy: DevinAcpProxy, negotiated = false) => {
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: negotiated
          ? { _meta: { lody: { subagentEvents: { version: 1 } } } }
          : {},
      },
    });
    proxy.handleRuntime(initializeResponse);
  };
  const newSession = (proxy: DevinAcpProxy, sessionId: string) => {
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/w", mcpServers: [] },
    });
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId, configOptions: [] },
    });
  };
  const toolUpdates = (out: { toClient: { params?: unknown }[] }) =>
    out.toClient.map(
      (message) =>
        (message as { params: { update: Record<string, unknown> } }).params
          .update,
    );
  const toolUpdate = (out: { toClient: { params?: unknown }[] }) =>
    toolUpdates(out).at(-1);
  const compactPrompt = (
    proxy: DevinAcpProxy,
    sessionId: string,
    text = "/compact",
  ) =>
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    });

  it("advertises subagentEvents and compaction while preserving all other meta", () => {
    const proxy = newProxy();
    const clientRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true },
          _meta: { other: { keep: true } },
        },
      },
    };
    // unnegotiated: the client request reaches the runtime byte-identical
    expect(proxy.handleClient(clientRequest)).toEqual({
      toClient: [],
      toRuntime: [clientRequest],
    });
    const runtimeResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          _meta: {
            "cognition.ai/chains": true,
            lody: { other: { version: 1 } },
          },
        },
        authMethods: [],
      },
    };
    expect(proxy.handleRuntime(runtimeResponse)).toEqual({
      toClient: [
        {
          ...runtimeResponse,
          result: {
            ...runtimeResponse.result,
            agentCapabilities: {
              ...runtimeResponse.result.agentCapabilities,
              _meta: {
                "cognition.ai/chains": true,
                lody: {
                  other: { version: 1 },
                  subagentEvents: { version: 1 },
                  compaction: { version: 1 },
                  elicitation: { version: 1 },
                  usage: { version: 1 },
                },
              },
            },
          },
        },
      ],
      toRuntime: [],
    });
  });

  it("renders started/completed as one Core activity with the summary in content", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");

    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });

    const done = proxy.handleRuntime(
      compaction("s1", "completed", "Summarized turns 1-5."),
    );
    const updates = toolUpdates(done);
    expect(updates[0]).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "devin-compaction-id-1",
      title: "Compact context",
      kind: "other",
      status: "in_progress",
      _meta: { lody: { activity: { version: 1, kind: "context_compaction" } } },
    });
    expect(updates[1]).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "devin-compaction-id-1",
      status: "completed",
      _meta: { lody: { activity: { version: 1, kind: "context_compaction" } } },
      content: [
        {
          type: "content",
          content: { type: "text", text: "Summarized turns 1-5." },
        },
      ],
    });
  });

  it("follows the real order: /compact ACK first, started, a later prompt ACK, then completed", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");

    // The /compact prompt resolves before any compaction lifecycle arrives.
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "/compact" }] },
    });
    const ack = { jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } };
    expect(proxy.handleRuntime(ack)).toEqual({
      toClient: [ack],
      toRuntime: [],
    });

    expect(
      toolUpdate(proxy.handleRuntime(compaction("s1", "started"))),
    ).toMatchObject({ toolCallId: "devin-compaction-id-1" });

    // A prompt completing mid-compaction emits no synthetic terminal.
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] },
    });
    const ack2 = { jsonrpc: "2.0", id: 6, result: { stopReason: "end_turn" } };
    expect(proxy.handleRuntime(ack2)).toEqual({
      toClient: [ack2],
      toRuntime: [],
    });

    expect(
      toolUpdate(proxy.handleRuntime(compaction("s1", "completed", "done"))),
    ).toMatchObject({
      toolCallId: "devin-compaction-id-1",
      status: "completed",
    });
  });

  it("forwards session/cancel untouched, reports native failed on the same id, keeps the canceled display text", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    proxy.handleRuntime(compaction("s1", "started"));

    const cancel = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "s1" },
    };
    expect(proxy.handleClient(cancel)).toEqual({
      toClient: [],
      toRuntime: [cancel],
    });

    const failed = toolUpdates(proxy.handleRuntime(compaction("s1", "failed")));
    expect(failed[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "devin-compaction-id-1",
      status: "in_progress",
    });
    expect(failed[1]).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "devin-compaction-id-1",
      status: "failed",
      _meta: {
        lody: { activity: { version: 1, kind: "context_compaction" } },
      },
    });

    const display = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Compaction canceled." },
          _meta: { "cognition.ai/displayMessage": true },
        },
      },
    };
    expect(proxy.handleRuntime(display)).toEqual({
      toClient: [display],
      toRuntime: [],
    });
  });

  it("suppresses a duplicate start and orphan terminals, and mints a fresh id next round", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");

    proxy.handleRuntime(compaction("s1", "started"));
    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
    proxy.handleRuntime(compaction("s1", "completed", "one"));
    // terminal after the run already closed: consumed, no second card
    expect(proxy.handleRuntime(compaction("s1", "failed"))).toEqual({
      toClient: [],
      toRuntime: [],
    });

    proxy.handleRuntime(compaction("s1", "started"));
    const second = proxy.handleRuntime(compaction("s1", "failed"));
    expect(toolUpdate(second)).toMatchObject({
      toolCallId: "devin-compaction-id-2",
      status: "failed",
    });
  });

  it("tracks interleaved compactions on two sessions independently", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    newSession(proxy, "s2");

    const a = proxy.handleRuntime(compaction("s1", "started"));
    const b = proxy.handleRuntime(compaction("s2", "started"));
    expect(a).toEqual({ toClient: [], toRuntime: [] });
    expect(b).toEqual({ toClient: [], toRuntime: [] });

    const bDone = toolUpdates(
      proxy.handleRuntime(compaction("s2", "completed", "B")),
    );
    expect(bDone[0]).toMatchObject({
      toolCallId: "devin-compaction-id-2",
      status: "in_progress",
    });
    expect(bDone[1]).toMatchObject({
      toolCallId: "devin-compaction-id-2",
      status: "completed",
    });
    const aDone = toolUpdates(proxy.handleRuntime(compaction("s1", "failed")));
    expect(aDone[0]).toMatchObject({
      toolCallId: "devin-compaction-id-1",
      status: "in_progress",
    });
    expect(aDone[1]).toMatchObject({
      toolCallId: "devin-compaction-id-1",
      status: "failed",
    });
  });

  it("passes through malformed or out-of-scope notifications verbatim", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    const cases = [
      { jsonrpc: "2.0", method: "_cognition.ai/compaction" },
      { jsonrpc: "2.0", method: "_cognition.ai/compaction", params: [] },
      {
        jsonrpc: "2.0",
        method: "_cognition.ai/compaction",
        params: { sessionId: "s1" },
      },
      compaction(null, "started"),
      compaction(42, "started"),
      compaction("", "started"),
      compaction("s1", "unknown"),
      compaction("never-admitted", "started"),
    ];
    for (const msg of cases) {
      expect(proxy.handleRuntime(msg)).toEqual({
        toClient: [msg],
        toRuntime: [],
      });
    }
  });

  it.each([{ summary: undefined }, { summary: 42 }])(
    "manual /compact completes normally when summary is absent or non-string (%j)",
    ({ summary }) => {
      const proxy = newProxy();
      initialize(proxy);
      newSession(proxy, "s1");
      compactPrompt(proxy, "s1");
      proxy.handleRuntime(compaction("s1", "started"));
      const update = toolUpdate(
        proxy.handleRuntime(compaction("s1", "completed", summary)),
      );
      expect(update).toMatchObject({
        toolCallId: "devin-compaction-id-1",
        status: "completed",
      });
      expect(update).not.toHaveProperty("content");
    },
  );

  it("suppresses a burst of replayed no-summary compaction pairs", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");

    for (let i = 0; i < 11; i++) {
      expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
        toClient: [],
        toRuntime: [],
      });
      expect(proxy.handleRuntime(compaction("s1", "completed"))).toEqual({
        toClient: [],
        toRuntime: [],
      });
    }
    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
    expect(proxy.handleRuntime(compaction("s1", "completed", "   "))).toEqual({
      toClient: [],
      toRuntime: [],
    });

    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
    const updates = toolUpdates(
      proxy.handleRuntime(compaction("s1", "completed", "real summary")),
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      status: "in_progress",
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
    });
    expect(updates[0]?.toolCallId).toBe(updates[1]?.toolCallId);
  });

  it("disarms manual compaction when the next prompt is ordinary", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    compactPrompt(proxy, "s1");
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [{ type: "text", text: "continue" }],
      },
    });

    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
    expect(proxy.handleRuntime(compaction("s1", "completed"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
  });

  it.each(["session/load", "session/resume"])(
    "disarms manual compaction when %s starts",
    (method) => {
      const proxy = newProxy();
      initialize(proxy);
      newSession(proxy, "s1");
      compactPrompt(proxy, "s1");
      proxy.handleClient({
        jsonrpc: "2.0",
        id: 6,
        method,
        params: { sessionId: "s1", cwd: "/w", mcpServers: [] },
      });
      proxy.handleRuntime({ jsonrpc: "2.0", id: 6, result: {} });
      expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
        toClient: [],
        toRuntime: [],
      });
    },
  );

  it("shows a hidden compaction if /compact arrives before its terminal", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
    compactPrompt(proxy, "s1");
    const updates = toolUpdates(
      proxy.handleRuntime(compaction("s1", "completed")),
    );
    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      status: "in_progress",
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
    });
    expect(updates[0]?.toolCallId).toBe(updates[1]?.toolCallId);
  });

  it("disarms manual compaction when the prompt fails", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    compactPrompt(proxy, "s1");
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32000, message: "prompt failed" },
    });
    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
  });

  it("recognizes only a single /compact text block as manual", () => {
    for (const [text, armed] of [
      [" /compact ", true],
      ["/compact focus", true],
      ["/compactx", false],
    ] as const) {
      const proxy = newProxy();
      initialize(proxy);
      newSession(proxy, "s1");
      compactPrompt(proxy, "s1", text);
      const started = proxy.handleRuntime(compaction("s1", "started"));
      expect(started.toClient).toHaveLength(armed ? 1 : 0);
    }

    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [
          { type: "text", text: "/" },
          { type: "text", text: "compact" },
        ],
      },
    });
    expect(proxy.handleRuntime(compaction("s1", "started")).toClient).toEqual(
      [],
    );
  });

  it.each(["session/load", "session/resume"])(
    "during %s replay no synthetic activity; success admits the session",
    (method) => {
      const proxy = newProxy();
      initialize(proxy);
      // already-admitted session entering another replay window
      newSession(proxy, "s2");
      proxy.handleClient({
        jsonrpc: "2.0",
        id: 3,
        method,
        params: { sessionId: "s2", cwd: "/w", mcpServers: [] },
      });
      const replayed = compaction("s2", "started");
      expect(proxy.handleRuntime(replayed)).toEqual({
        toClient: [replayed],
        toRuntime: [],
      });
      proxy.handleRuntime({ jsonrpc: "2.0", id: 3, result: {} });
      expect(proxy.handleRuntime(compaction("s2", "started"))).toEqual({
        toClient: [],
        toRuntime: [],
      });
      const live = toolUpdates(
        proxy.handleRuntime(compaction("s2", "completed", "live")),
      );
      expect(live[0]).toMatchObject({
        toolCallId: "devin-compaction-id-1",
        status: "in_progress",
      });
      expect(live[1]).toMatchObject({
        toolCallId: "devin-compaction-id-1",
        status: "completed",
      });
    },
  );

  it.each(["session/load", "session/resume"])(
    "a fresh session is admitted on a successful %s",
    (method) => {
      const proxy = newProxy();
      initialize(proxy);
      proxy.handleClient({
        jsonrpc: "2.0",
        id: 3,
        method,
        params: { sessionId: "fresh-session", cwd: "/w", mcpServers: [] },
      });
      const replayed = compaction("fresh-session", "started");
      expect(proxy.handleRuntime(replayed)).toEqual({
        toClient: [replayed],
        toRuntime: [],
      });
      proxy.handleRuntime({ jsonrpc: "2.0", id: 3, result: {} });
      expect(
        proxy.handleRuntime(compaction("fresh-session", "started")),
      ).toEqual({ toClient: [], toRuntime: [] });
      const live = toolUpdates(
        proxy.handleRuntime(compaction("fresh-session", "completed", "s")),
      );
      expect(live[0]).toMatchObject({
        toolCallId: "devin-compaction-id-1",
        status: "in_progress",
      });
      expect(live[1]).toMatchObject({
        toolCallId: "devin-compaction-id-1",
        status: "completed",
      });
    },
  );

  it("a failed load releases the replay mark but admits nothing", () => {
    const proxy = newProxy();
    initialize(proxy, true);
    newSession(proxy, "s-existing");
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: "s-existing", cwd: "/w", mcpServers: [] },
    });
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "not found" },
    });
    // admitted session: error released the replay mark, so lifecycle translates
    compactPrompt(proxy, "s-existing");
    expect(
      toolUpdate(proxy.handleRuntime(compaction("s-existing", "started"))),
    ).toMatchObject({ status: "in_progress" });
    // unknown session after a failed load: still unadmitted, raw passthrough
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 4,
      method: "session/load",
      params: { sessionId: "s-unknown", cwd: "/w", mcpServers: [] },
    });
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32000, message: "not found" },
    });
    const raw = compaction("s-unknown", "started");
    expect(proxy.handleRuntime(raw)).toEqual({
      toClient: [raw],
      toRuntime: [],
    });
  });

  it("translates compaction without subagent opt-in and forwards other updates", () => {
    const proxy = newProxy();
    initialize(proxy); // unnegotiated
    newSession(proxy, "s1");
    expect(proxy.handleRuntime(compaction("s1", "started"))).toEqual({
      toClient: [],
      toRuntime: [],
    });
    expect(
      toolUpdate(proxy.handleRuntime(compaction("s1", "completed", "done"))),
    ).toMatchObject({ status: "completed" });
    // unrelated session/update rows still pass through verbatim
    const plain = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        },
      },
    };
    expect(proxy.handleRuntime(plain)).toEqual({
      toClient: [plain],
      toRuntime: [],
    });
  });
});

describe("usage accounting translation", () => {
  let scope = 0;
  beforeEach(() => {
    scope = 0;
  });
  const newProxy = () => new DevinAcpProxy({ newId: () => `scope-${++scope}` });
  const initialize = (proxy: DevinAcpProxy, negotiated = false) => {
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: negotiated
          ? { _meta: { lody: { subagentEvents: { version: 1 } } } }
          : {},
      },
    });
    proxy.handleRuntime(initializeResponse);
  };
  const newSession = (
    proxy: DevinAcpProxy,
    sessionId: string,
    configOptions: unknown[] = [],
  ) => {
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/w", mcpServers: [] },
    });
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId, configOptions },
    });
  };
  const modelOption = (value: string) => ({
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: value,
    options: [],
  });
  const usageUpdate = (
    sessionId: string,
    meta: Record<string, unknown>,
    used = 110,
    size = 262000,
  ) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "usage_update", used, size, _meta: meta },
    },
  });
  const counters = {
    "cognition.ai/inputTokens": 100,
    "cognition.ai/outputTokens": 10,
  };
  const lodyUsageMessages = (out: { toClient: { method?: string }[] }) =>
    out.toClient.filter((m) => m.method === "_lody/session/usage_update");

  it("emits Core accounting for admitted sessions and still forwards the raw update", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    const raw = usageUpdate("s1", counters);
    const out = proxy.handleRuntime(raw);
    expect(out.toClient).toHaveLength(2);
    expect(out.toClient[0]).toEqual(raw);
    const [notification] = lodyUsageMessages(out);
    expect(notification).toMatchObject({
      jsonrpc: "2.0",
      method: "_lody/session/usage_update",
      params: {
        sessionId: "s1",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          contextWindow: 262000,
        },
        modelUsage: {
          devin: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
          },
        },
        delta: {
          modelUsage: {
            devin: {
              inputTokens: 100,
              outputTokens: 10,
            },
          },
        },
        _meta: { lody: { usageScopeId: "scope-1" } },
      },
    });
  });

  it("accounts each request once across an untagged row and its context twin", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    const untagged = usageUpdate("s1", counters);
    const tagged = usageUpdate("s1", {
      ...counters,
      "cognition.ai/subagent_context": { parentAgentId: "root" },
    });
    expect(lodyUsageMessages(proxy.handleRuntime(untagged))).toHaveLength(1);
    const out = proxy.handleRuntime(tagged);
    expect(out.toClient).toEqual([tagged]);
  });

  it("keys modelUsage by the session model option and follows switches", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1", [modelOption("swe-2-high")]);
    const first = proxy.handleRuntime(usageUpdate("s1", counters));
    expect(lodyUsageMessages(first)[0]?.params?.modelUsage).toHaveProperty(
      "swe-2-high",
    );
    proxy.handleRuntime({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [modelOption("gpt-6-astra-medium")],
        },
      },
    });
    const second = proxy.handleRuntime(
      usageUpdate("s1", {
        "cognition.ai/inputTokens": 50,
        "cognition.ai/outputTokens": 5,
      }),
    );
    const notification = lodyUsageMessages(second)[0];
    expect(notification?.params?.modelUsage).toMatchObject({
      "swe-2-high": { inputTokens: 100, outputTokens: 10 },
      "gpt-6-astra-medium": { inputTokens: 50, outputTokens: 5 },
    });
  });

  it("accounts usage for negotiated clients and keeps a single root update", () => {
    const proxy = newProxy();
    initialize(proxy, true);
    newSession(proxy, "s1");
    const raw = usageUpdate("s1", counters);
    const out = proxy.handleRuntime(raw);
    expect(lodyUsageMessages(out)).toHaveLength(1);
    const rootUpdates = out.toClient.filter(
      (m) => m.method === "session/update",
    );
    expect(rootUpdates).toEqual([raw]);
  });

  it("skips child-run usage and rows without token counters", () => {
    const proxy = newProxy();
    initialize(proxy);
    newSession(proxy, "s1");
    const child = usageUpdate("s1", {
      ...counters,
      "cognition.ai/subagent_context": { parentAgentId: "agent-9" },
    });
    expect(proxy.handleRuntime(child).toClient).toEqual([child]);
    const bare = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "usage_update", used: 5, size: 262000 },
      },
    };
    expect(proxy.handleRuntime(bare).toClient).toEqual([bare]);
  });

  it("ignores usage before admission and during a load replay window", () => {
    const proxy = newProxy();
    initialize(proxy);
    const early = usageUpdate("unknown", counters);
    expect(proxy.handleRuntime(early).toClient).toEqual([early]);

    proxy.handleClient({
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: "s2", cwd: "/w", mcpServers: [] },
    });
    const replayed = usageUpdate("s2", counters);
    expect(proxy.handleRuntime(replayed).toClient).toEqual([replayed]);
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 3,
      result: { sessionId: "s2", configOptions: [modelOption("swe-2-high")] },
    });
    const live = usageUpdate("s2", {
      "cognition.ai/inputTokens": 42,
      "cognition.ai/outputTokens": 7,
    });
    const out = proxy.handleRuntime(live);
    expect(lodyUsageMessages(out)).toHaveLength(1);
    expect(lodyUsageMessages(out)[0]?.params?.modelUsage).toHaveProperty(
      "swe-2-high",
    );
  });
});
