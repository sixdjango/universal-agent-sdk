import { QUESTION_PREFIX } from "../src/builtin-tools.js";
import type { PiStream } from "../src/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, normalize } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { PiRpcConnection, initializeResponse } from "../src/connection.js";
import {
  LODY_EXTENSION_METHODS,
  LODY_SUBAGENT_EVENT_METHOD,
  isLodySubagentEvent,
  type SessionUsageUpdate,
} from "acp-extension-core";

const nativeDirectory = mkdtempSync(join(tmpdir(), "lody-pi-connection-"));
const nativeSession = join(nativeDirectory, "pi-session.jsonl");
writeFileSync(
  nativeSession,
  JSON.stringify({
    type: "session",
    version: 3,
    id: "fixture",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work",
  }) + "\n",
);
afterAll(() => rmSync(nativeDirectory, { recursive: true, force: true }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const model = {
  provider: "fixture",
  id: "one",
  name: "Fixture",
};
const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { total: 0.01 },
};

/** Synthetic wire peer. Writes never await a running prompt or a question. */
function peer() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      output = controller;
    },
  });
  const commands: Record<string, unknown>[] = [];
  const replies: Record<string, unknown>[] = [];
  const promptReceived = deferred();
  const accepted = deferred();
  const questionAnswered = deferred<Record<string, unknown>>();
  const state = {
    sessionFile: nativeSession,
    model,
    thinkingLevel: "off",
  };
  const emit = (value: unknown) =>
    output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  let defaultPrompt: Record<string, unknown> | undefined;
  const finish = () => {
    emit({ type: "agent_settled" });
    if (defaultPrompt) {
      reply(defaultPrompt);
      defaultPrompt = undefined;
    }
  };
  let onPrompt = (request: Record<string, unknown>) => {
    defaultPrompt = request;
    reply(request);
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
  };
  let onAbort = (request: Record<string, unknown>) => {
    finish();
    reply(request);
  };
  let onClearQueue = (request: Record<string, unknown>) => reply(request, {});
  let onCompact = (request: Record<string, unknown>) => reply(request, {});
  let onState = (request: Record<string, unknown>) => reply(request, state);
  let onStats = (request: Record<string, unknown>) =>
    reply(request, {
      tokens: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
      cost: 0.02,
    });
  function reply(
    request: Record<string, unknown>,
    data?: unknown,
    error?: string,
  ) {
    emit({
      type: "response",
      id: request.id,
      command: request.type,
      success: !error,
      data:
        data === undefined && request.type === "prompt" && !error
          ? { disposition: "started" }
          : data,
      error,
    });
  }
  let onSession = (request: Record<string, unknown>) =>
    reply(request, { cancelled: false });
  let onModel = (request: Record<string, unknown>) => {
    state.model = { ...model, id: String(request.modelId) };
    state.thinkingLevel = "off";
    reply(request, state.model);
  };
  let onModels = (request: Record<string, unknown>) =>
    reply(request, { models: [model, { ...model, id: "two" }] });
  let onEntries = (request: Record<string, unknown>) =>
    reply(request, { entries: [], leafId: null });
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      const request: Record<string, unknown> = JSON.parse(
        new TextDecoder().decode(bytes),
      );
      commands.push(request);
      switch (request.type) {
        case "new_session":
        case "switch_session":
          onSession(request);
          emit({
            type: "extension_ui_request",
            method: "notify",
            message:
              "lody-rpc:" +
              JSON.stringify({
                type: "lody_steer_ready",
                version: 1,
                command: "lody-steer",
                sessionFile: state.sessionFile,
              }),
          });
          break;
        case "get_state":
          onState(request);
          if (commands.some((command) => command.type === "prompt"))
            accepted.resolve();
          break;
        case "get_session_stats":
          onStats(request);
          break;
        case "get_available_models":
          onModels(request);
          break;
        case "get_available_thinking_levels":
          reply(request, {
            levels: state.model.id === "one" ? ["off", "high"] : ["off"],
          });
          break;
        case "set_model":
          onModel(request);
          break;
        case "get_entries":
          onEntries(request);
          break;
        case "set_thinking_level":
          state.thinkingLevel = String(request.level);
          reply(request);
          break;
        case "prompt":
          onPrompt(request);
          promptReceived.resolve();
          break;
        case "abort":
          onAbort(request);
          break;
        case "compact":
          onCompact(request);
          break;
        case "clear_queue":
          onClearQueue(request);
          break;
        case "extension_ui_response":
          replies.push(request);
          questionAnswered.resolve(request);
          break;
        default:
          throw new Error(`Unexpected Pi wire method: ${String(request.type)}`);
      }
    },
  });
  const stream: PiStream = { readable, writable };
  emit({
    type: "extension_ui_request",
    method: "notify",
    message:
      "lody-rpc:" +
      JSON.stringify({
        type: "lody_steer_ready",
        version: 1,
        command: "lody-steer",
        sessionFile: state.sessionFile,
      }),
  });
  const updates: acp.SessionNotification[] = [];
  const usages: SessionUsageUpdate[] = [];
  let client: PiRpcConnection | undefined;
  const host = {
    subagentEvents: false,
    configureMcp: async (_servers: acp.McpServer[]) => {},
    configureWorkspace: async (
      _workspace: import("../src/workspace.js").Workspace,
    ) => {},
    update: async (notification: acp.SessionNotification) => {
      updates.push(notification);
    },
    extension: async (_method: string, _params: Record<string, unknown>) => {},
    usage: (value: SessionUsageUpdate) => usages.push(value),
    question: async (): Promise<acp.CreateElicitationResponse> => ({
      action: "accept",
      content: { answer: "chosen" },
    }),
  };
  return {
    setCompact(handler: typeof onCompact) {
      onCompact = handler;
    },
    setState(handler: typeof onState) {
      onState = handler;
    },
    setStats(handler: typeof onStats) {
      onStats = handler;
    },
    setSession(handler: typeof onSession) {
      onSession = handler;
    },
    setModel(handler: typeof onModel) {
      onModel = handler;
    },
    setModels(handler: typeof onModels) {
      onModels = handler;
    },
    setEntries(handler: typeof onEntries) {
      onEntries = handler;
    },
    get client() {
      return (client ??= new PiRpcConnection(stream, host));
    },
    stream,
    readable,
    writable,
    updates,
    usages,
    host,
    emit,
    finish,
    commands,
    state,
    replies,
    questionAnswered,
    reply,
    promptReceived,
    accepted,
    setAbort: (handler: typeof onAbort) => {
      onAbort = handler;
    },
    setClearQueue: (handler: typeof onClearQueue) => {
      onClearQueue = handler;
    },
    setPrompt: (handler: typeof onPrompt) => {
      onPrompt = handler;
    },
    close: () => output.close(),
  };
}
async function start(p: ReturnType<typeof peer>) {
  await p.client.initialize({ protocolVersion: 1 });
  return p.client.newSession({ cwd: "/work", mcpServers: [] });
}
const prompt = {
  sessionId: nativeSession,
  prompt: [{ type: "text" as const, text: "hello" }],
};
const text = (value: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: value },
});
/** Accounting fields Pi puts on every assistant message. */
const response = (responseId: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  provider: "fixture",
  model: "one",
  responseId,
  timestamp: 1,
  usage,
  ...extra,
});
const lodyEvent = (payload: Record<string, unknown>) => ({
  type: "extension_ui_request",
  method: "notify",
  message: "lody-rpc:" + JSON.stringify(payload),
});

describe("native Pi connection", () => {
  it("completes handled input without a model event and admits the next prompt", async () => {
    const p = peer();
    await start(p);
    p.setPrompt((request) => p.reply(request, { disposition: "handled" }));
    expect(await p.client.prompt(prompt)).toEqual({ stopReason: "end_turn" });
    p.setPrompt((request) => {
      p.reply(request, { disposition: "started" });
      p.emit({ type: "agent_start" });
      p.finish();
    });
    expect(await p.client.prompt(prompt)).toEqual({ stopReason: "end_turn" });
    p.close();
  });

  it("publishes negotiated child histories without legacy task cards or accounting deltas", async () => {
    const p = peer();
    p.host.subagentEvents = true;
    const events: Record<string, unknown>[] = [];
    const done = deferred();
    p.host.extension = async (method, event) => {
      if (method !== LODY_SUBAGENT_EVENT_METHOD) return;
      events.push(event);
      if (
        event.type === "snapshot" &&
        (event.snapshot as { state: string }).state === "cancelled"
      )
        done.resolve();
    };
    await start(p);
    const emit = (payload: unknown) =>
      p.emit({
        type: "extension_ui_request",
        method: "notify",
        message: "lody-rpc:" + JSON.stringify(payload),
      });
    const task = {
      taskId: "child",
      parentToolCallId: "spawn",
      status: "in_progress",
      description: "Inspect sources",
    };
    emit({ type: "lody_subagent", event: "started", task, state: "running" });
    emit({
      type: "lody_subagent_output",
      taskId: "child",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Found it" },
      },
    });
    emit({
      type: "lody_subagent_output",
      taskId: "child",
      event: {
        type: "tool_execution_start",
        toolCallId: "read",
        toolName: "read",
        args: { path: "a.ts" },
      },
    });
    emit({
      type: "lody_subagent",
      event: "updated",
      task: { ...task, lastToolName: "read" },
      state: "running",
    });
    emit({
      type: "lody_subagent_output",
      taskId: "child",
      event: {
        type: "tool_execution_end",
        toolCallId: "read",
        toolName: "read",
        result: { content: [{ type: "text", text: "Source" }] },
      },
    });
    emit({
      type: "lody_subagent",
      event: "updated",
      task: { ...task, status: "failed", error: "Cancelled" },
      state: "killed",
    });
    await done.promise;
    expect(events.every(isLodySubagentEvent)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "snapshot",
      "output",
      "output",
      "progress",
      "output",
      "snapshot",
    ]);
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
    expect(events[0]).toMatchObject({
      sessionId: nativeSession,
      snapshot: { parentRunId: null, parentToolCallId: "spawn" },
    });
    expect(
      p.updates.some((event) =>
        ["tool_call", "tool_call_update"].includes(event.update.sessionUpdate),
      ),
    ).toBe(false);
    expect(p.usages).toEqual([]);
    p.client.close();
  });
  describe("keeps each native content block contiguous", () => {
    const block = (type: string, delta?: string) => ({
      type: "message_update",
      assistantMessageEvent: {
        type,
        ...(delta === undefined ? {} : { delta }),
      },
    });
    const chunk = (update: acp.SessionNotification["update"]) =>
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      update.content.type === "text"
        ? [
            [
              update.sessionUpdate === "agent_message_chunk"
                ? "text"
                : "thought",
              update.content.text,
            ],
          ]
        : [];
    const chunks = (p: ReturnType<typeof peer>) =>
      p.updates.flatMap((n) => chunk(n.update));
    /** Runs one prompt whose default first assistant message streams `events`. */
    async function stream(
      events: Record<string, unknown>[],
      stopReason = "stop",
    ) {
      const p = peer();
      await start(p);
      const done = p.client.prompt(prompt);
      await p.promptReceived.promise;
      for (const event of events) p.emit(event);
      p.emit({ type: "message_end", message: response("r1", { stopReason }) });
      p.finish();
      const result = await done;
      p.close();
      return { chunks: chunks(p), updates: p.updates, result };
    }

    it("defers reasoning that resumes inside a text run", async () => {
      const { chunks: emitted } = await stream([
        block("thinking_start"),
        block("thinking_delta", "a"),
        block("text_start"),
        block("text_delta", "这个"),
        block("thinking_delta", "b"),
        block("text_delta", " alpine"),
        block("text_end"),
      ]);
      expect(emitted).toEqual([
        ["thought", "a"],
        ["text", "这个"],
        ["text", " alpine"],
        ["thought", "b"],
      ]);
    });

    it("defers reasoning that first becomes visible after text starts", async () => {
      // pi-ai can open a metadata-only thinking block before any text.
      const { chunks: emitted } = await stream([
        block("thinking_start"),
        block("text_start"),
        block("text_delta", "这个"),
        block("thinking_delta", "late"),
        block("text_delta", " alpine"),
      ]);
      expect(emitted).toEqual([
        ["text", "这个"],
        ["text", " alpine"],
        ["thought", "late"],
      ]);
    });

    it("releases reasoning deferred during one text run as one chunk", async () => {
      const { chunks: emitted } = await stream([
        block("text_delta", "a"),
        block("thinking_delta", "x"),
        block("text_delta", "b"),
        block("thinking_delta", "y"),
        block("text_end"),
        block("thinking_end"),
      ]);
      expect(emitted).toEqual([
        ["text", "a"],
        ["text", "b"],
        ["thought", "xy"],
      ]);
    });

    it("releases deferred reasoning before a tool call", async () => {
      const { updates } = await stream([
        block("text_delta", "Run it"),
        block("thinking_delta", "b"),
        block("toolcall_start"),
        {
          type: "tool_execution_start",
          toolCallId: "read",
          toolName: "read",
          args: { path: "a.ts" },
        },
      ]);
      const order = ["agent_message_chunk", "agent_thought_chunk", "tool_call"];
      expect(
        updates
          .map((n) => n.update.sessionUpdate)
          .filter((kind) => order.includes(kind)),
      ).toEqual(order);
    });

    it("releases deferred reasoning at message_end when the stream aborts before *_end", async () => {
      const { chunks: emitted, result } = await stream(
        [
          block("thinking_delta", "a"),
          block("text_delta", "partial"),
          block("thinking_delta", "late"),
        ],
        "aborted",
      );
      expect(result).toEqual({ stopReason: "cancelled" });
      expect(emitted).toEqual([
        ["thought", "a"],
        ["text", "partial"],
        ["thought", "late"],
      ]);
    });

    it("drains deferred reasoning before reporting a provider error", async () => {
      const p = peer();
      await start(p);
      const done = p.client.prompt(prompt);
      const failed = expect(done).rejects.toThrow("synthetic stream failure");
      await p.promptReceived.promise;
      p.emit(block("thinking_delta", "a"));
      p.emit(block("text_delta", "partial"));
      p.emit(block("thinking_delta", "late"));
      p.emit({
        type: "message_end",
        message: response("r1", {
          stopReason: "error",
          errorMessage: "synthetic stream failure",
        }),
      });
      p.finish();
      await failed;
      expect(chunks(p)).toEqual([
        ["thought", "a"],
        ["text", "partial"],
        ["thought", "late"],
      ]);
      p.close();
    });

    it("keeps sequential blocks in arrival order", async () => {
      const { chunks: emitted } = await stream([
        block("thinking_delta", "a"),
        block("thinking_delta", "b"),
        block("thinking_end"),
        block("text_delta", "c"),
        block("text_delta", "d"),
        block("text_end"),
      ]);
      expect(emitted).toEqual([
        ["thought", "a"],
        ["thought", "b"],
        ["text", "c"],
        ["text", "d"],
      ]);
    });

    it("never carries a text run into the next assistant message", async () => {
      const { chunks: emitted } = await stream([
        block("thinking_delta", "a"),
        block("text_delta", "b"),
        block("thinking_delta", "c"),
        {
          type: "message_end",
          message: response("r0", { stopReason: "stop" }),
        },
        { type: "message_start", message: { role: "assistant" } },
        block("thinking_delta", "d"),
        block("text_delta", "e"),
      ]);
      expect(emitted).toEqual([
        ["thought", "a"],
        ["text", "b"],
        ["thought", "c"],
        ["thought", "d"],
        ["text", "e"],
      ]);
    });

    it("sequences negotiated subagent output per child message", async () => {
      const p = peer();
      p.host.subagentEvents = true;
      const outputs: { update: unknown; messageId?: unknown }[] = [];
      const done = deferred();
      p.host.extension = async (method, event) => {
        if (method !== LODY_SUBAGENT_EVENT_METHOD) return;
        if (event.type === "output")
          outputs.push({ update: event.update, messageId: event.messageId });
        if (
          event.type === "snapshot" &&
          (event.snapshot as { state: string }).state === "completed"
        )
          done.resolve();
      };
      await start(p);
      const task = {
        taskId: "child",
        status: "in_progress",
        description: "Inspect sources",
      };
      const child = (messageId: string, event: unknown) =>
        p.emit(
          lodyEvent({
            type: "lody_subagent_output",
            taskId: "child",
            messageId,
            event,
          }),
        );
      p.emit(
        lodyEvent({
          type: "lody_subagent",
          event: "started",
          task,
          state: "running",
        }),
      );
      child("m1", block("thinking_delta", "a"));
      child("m1", block("text_delta", "x"));
      child("m1", block("thinking_delta", "b"));
      child("m1", block("text_delta", "y"));
      // An aborted child message ends without *_end; the next message flushes it.
      child("m2", block("text_delta", "z"));
      p.emit(
        lodyEvent({
          type: "lody_subagent",
          event: "updated",
          task: { ...task, status: "completed" },
          state: "completed",
        }),
      );
      await done.promise;
      expect(
        outputs.map(({ update, messageId }) => [
          messageId,
          ...chunk(update as acp.SessionNotification["update"]).flat(),
        ]),
      ).toEqual([
        ["m1", "thought", "a"],
        ["m1", "text", "x"],
        ["m1", "text", "y"],
        ["m1", "thought", "b"],
        ["m2", "text", "z"],
      ]);
      p.client.close();
    });
  });
  it.each(["reply-error", "eof"])(
    "distinguishes optional initial stats failure from a dead Pi transport (%s)",
    async (failure) => {
      const p = peer();
      p.setStats((request) => {
        if (failure === "eof") p.close();
        else p.reply(request, undefined, "Stats unavailable");
      });
      const result = start(p);
      if (failure === "eof") {
        await expect(result).rejects.toThrow("Pi RPC connection closed");
        await expect(p.client.prompt(prompt)).rejects.toThrow();
      } else {
        await expect(result).resolves.toMatchObject({
          sessionId: prompt.sessionId,
        });
        p.close();
      }
    },
  );

  it.each([false, true])(
    "preserves final length but clears it after a successful retry (%s)",
    async (retry) => {
      const p = peer();
      await start(p);
      p.setPrompt((request) => {
        p.emit({ type: "agent_start" });
        p.emit({
          type: "message_end",
          message: { role: "assistant", stopReason: "length" },
        });
        if (retry) {
          p.emit({ type: "message_start", message: { role: "assistant" } });
          p.emit({
            type: "message_end",
            message: { role: "assistant", stopReason: "stop" },
          });
        }
        p.finish();
        p.reply(request);
      });
      expect(await p.client.prompt(prompt)).toEqual({
        stopReason: retry ? "end_turn" : "max_tokens",
      });
      p.close();
    },
  );

  it.each([false, true])(
    "keeps accepted Stop authoritative while stats is pending (failed=%s)",
    async (failed) => {
      const p = peer();
      await start(p);
      const stats = deferred<Record<string, unknown>>();
      p.setStats((request) => stats.resolve(request));
      const result = p.client.prompt({
        ...prompt,
        prompt: [{ type: "text", text: "/stats" }],
      });
      const request = await stats.promise;
      const stopped = p.client.cancel({ sessionId: prompt.sessionId });
      p.reply(
        request,
        {
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        },
        failed ? "Stats failed" : undefined,
      );
      expect(await result).toEqual({ stopReason: "cancelled" });
      await stopped;
      expect(
        p.updates.some((n) => n.update.sessionUpdate === "agent_message_chunk"),
      ).toBe(false);
      p.close();
    },
  );

  it.each(["stop", "length", "error", "aborted"])(
    "keeps %s authoritative when post-turn model options disappear",
    async (outcome) => {
      const p = peer();
      await start(p);
      p.setPrompt((request) => {
        p.setModels((query) => p.reply(query, { models: [] }));
        if (outcome !== "handled") {
          p.emit({ type: "agent_start" });
          p.emit({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: outcome,
              errorMessage: "Model failed",
            },
          });
          p.finish();
        }
        p.reply(request);
      });
      const result = p.client.prompt(prompt);
      if (outcome === "error")
        await expect(result).rejects.toThrow("Model failed");
      else
        expect(await result).toEqual({
          stopReason:
            outcome === "length"
              ? "max_tokens"
              : outcome === "aborted"
                ? "cancelled"
                : "end_turn",
        });
      p.close();
    },
  );

  it("does not hide a failed ACP configuration notification as an optional refresh failure", async () => {
    const p = peer();
    await start(p);
    p.host.update = async ({ update }) => {
      if (update.sessionUpdate === "config_option_update")
        throw new Error("ACP output closed");
    };
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.finish();
      p.reply(request);
    });
    await expect(p.client.prompt(prompt)).rejects.toThrow("ACP output closed");
    p.close();
  });

  it("uses Pi context snapshots instead of assistant usage, preserving unknown occupancy", async () => {
    const p = peer();
    await start(p);
    for (const tokens of [321, null]) {
      p.updates.length = 0;
      p.setStats((query) =>
        p.reply(query, {
          tokens: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
          cost: 0.02,
          contextUsage: { tokens, contextWindow: 8192 },
        }),
      );
      p.setPrompt((request) => {
        p.emit({ type: "agent_start" });
        p.emit({ ...text("answer"), usage: { ...usage, totalTokens: 0 } });
        p.emit({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop", usage },
        });
        p.emit({
          type: "tool_execution_start",
          toolCallId: "next-tool",
          toolName: "bash",
          args: { command: "echo next" },
        });
        p.finish();
        p.reply(request);
      });
      expect(await p.client.prompt(prompt)).toEqual({ stopReason: "end_turn" });
      const snapshots = p.updates
        .map((n) => n.update)
        .filter((u) => u.sessionUpdate === "usage_update");
      if (tokens === null) expect(snapshots).toEqual([]);
      else {
        expect(snapshots.length).toBeGreaterThan(0);
        for (const snapshot of snapshots)
          expect(snapshot).toMatchObject({ used: tokens, size: 8192 });
        const events = p.updates.map((n) => n.update.sessionUpdate);
        expect(events.indexOf("usage_update")).toBeLessThan(
          events.indexOf("tool_call"),
        );
      }
    }
    p.close();
  });

  it("does not start a prompt midway through model configuration", async () => {
    const p = peer();
    await p.client.initialize({ protocolVersion: 1 });
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    const entered = deferred<Record<string, unknown>>();
    p.setModel((request) => entered.resolve(request));
    const setting = p.client.setSessionConfigOption({
      sessionId: prompt.sessionId,
      configId: "model",
      value: "fixture/two",
    });
    const command = await entered.promise;
    const turn = p.client.prompt(prompt).then(
      () => "completed",
      () => "refused",
    );
    const verdict = await Promise.race([
      turn,
      p.promptReceived.promise.then(() => "sent mid-configuration"),
    ]);
    if (verdict !== "refused") p.finish();
    p.state.model = { ...model, id: "two" };
    p.reply(command, p.state.model);
    await Promise.all([turn, setting]);
    p.close();
    expect(verdict).toBe("refused");
  });

  it("invalidates old identity when replacement startup configuration fails", async () => {
    const p = peer();
    await p.client.initialize({ protocolVersion: 1 });
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    p.setSession((request) => {
      p.state.sessionFile = "/work/next.jsonl";
      p.reply(request, { cancelled: false });
    });
    await expect(
      p.client.newSession({
        cwd: "/work",
        mcpServers: [],
        _meta: {
          lody: {
            sessionConfig: { configOptionValues: { model: "missing/model" } },
          },
        },
      }),
    ).rejects.toThrow("unavailable");
    await expect(p.client.prompt({ ...prompt, sessionId: "" })).rejects.toThrow(
      "does not match",
    );
    const oldTurn = p.client.prompt(prompt).then(
      () => "completed",
      () => "refused",
    );
    const verdict = await Promise.race([
      oldTurn,
      p.promptReceived.promise.then(() => "sent to replaced session"),
    ]);
    if (verdict !== "refused") p.finish();
    await oldTurn;
    p.close();
    expect(verdict).toBe("refused");
  });

  it("refuses an old-session prompt while native session replacement is in flight", async () => {
    const p = peer();
    await p.client.initialize({ protocolVersion: 1 });
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    const entered = deferred<Record<string, unknown>>();
    p.setSession((request) => {
      p.state.sessionFile = "/work/next.jsonl";
      entered.resolve(request);
    });
    const replacing = p.client.newSession({ cwd: "/work", mcpServers: [] });
    const command = await entered.promise;
    const oldTurn = p.client.prompt(prompt).then(
      () => "completed",
      () => "refused",
    );
    const verdict = await Promise.race([
      oldTurn,
      p.promptReceived.promise.then(() => "sent to replaced session"),
    ]);
    if (verdict !== "refused") p.finish();
    p.reply(command, { cancelled: false });
    await Promise.all([oldTurn, replacing]);
    p.close();
    expect(verdict).toBe("refused");
  });

  it("hands off a steer only when its tagged message is applied, before any following output", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    await p.accepted.promise;
    const queued = deferred();
    p.setPrompt((request) => {
      p.reply(request);
      queued.resolve();
    });
    const applied = deferred();
    const released = deferred();
    const applications: unknown[] = [];
    p.host.extension = async (method, params) => {
      applications.push(params.steerId);
      expect(method).toBe(LODY_EXTENSION_METHODS.sessionSteerApplied);
      expect(params.sessionId).toBe(prompt.sessionId);
      if (params.steerId === "steer-1") {
        applied.resolve();
        await released.promise;
      }
    };
    const steered = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
      sessionId: prompt.sessionId,
      steerId: "steer-1",
      prompt: [{ type: "text", text: "change direction" }],
    });
    await queued.promise;
    p.emit({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "change direction" }],
      },
    });
    p.emit(text("old owner"));
    p.emit({
      type: "message_start",
      message: {
        role: "custom",
        customType: "lody-steer",
        details: { steerId: "steer-1" },
        content: "change direction",
      },
    });
    p.emit(text("new owner"));
    await applied.promise;
    await expect(steered).resolves.toEqual({ outcome: "injected" });
    expect(
      p.updates
        .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
        .map((n) => n.update),
    ).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "old owner" },
      },
    ]);
    // A second identical instruction has its own identity, even during the first lease.
    p.setPrompt((request) => {
      p.reply(request);
      p.emit({
        type: "message_start",
        message: {
          role: "custom",
          customType: "lody-steer",
          details: { steerId: "steer-2" },
          content: "change direction",
        },
      });
      p.emit(text("second owner"));
      p.finish();
    });
    const second = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
      sessionId: prompt.sessionId,
      steerId: "steer-2",
      prompt: [{ type: "text", text: "change direction" }],
    });
    released.resolve();
    await expect(second).resolves.toEqual({ outcome: "injected" });
    expect(applications).toEqual(["steer-1", "steer-2"]);
    await expect(done).resolves.toEqual({ stopReason: "end_turn" });
    expect(
      p.updates.some(
        (n) =>
          n.update.sessionUpdate === "agent_message_chunk" &&
          n.update.content.type === "text" &&
          n.update.content.text === "new owner",
      ),
    ).toBe(true);
    p.close();
  });

  it("preserves an idle refusal arriving after settlement so the host can requeue", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    await p.accepted.promise;
    p.setPrompt((request) => {
      p.finish();
      p.emit({
        type: "extension_ui_request",
        method: "notify",
        message:
          "lody-rpc:" +
          JSON.stringify({ type: "lody_steer_refused", steerId: "late" }),
      });
      p.reply(request);
    });
    await expect(
      p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
        sessionId: prompt.sessionId,
        steerId: "late",
        prompt: prompt.prompt,
      }),
    ).rejects.toMatchObject({ code: -32600 });
    await done;
    p.close();
  });

  it("clears a steer stranded at natural settlement before allowing the next prompt", async () => {
    const p = peer();
    await start(p);
    let stranded = true;
    p.setClearQueue((request) => {
      stranded = false;
      p.reply(request, {});
    });
    const done = p.client.prompt(prompt);
    await p.accepted.promise;
    const queued = deferred();
    p.setPrompt((request) => {
      p.reply(request);
      queued.resolve();
    });
    const steer = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
      sessionId: prompt.sessionId,
      steerId: "settlement-race",
      prompt: prompt.prompt,
    });
    const rejected = expect(steer).rejects.toMatchObject({ code: -32600 });
    await queued.promise;
    p.finish();
    await done;
    await rejected;
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.emit(text(stranded ? "old steer" : "new prompt"));
      p.finish();
      p.reply(request);
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(
      p.updates.findLast(
        (n) => n.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toMatchObject({
      update: { content: { text: "new prompt" } },
    });
    p.close();
  });

  it.each([false, true])(
    "classifies cancelled steer after abort drains (applied=%s)",
    async (applied) => {
      const p = peer();
      await start(p);
      const done = p.client.prompt(prompt);
      await p.accepted.promise;
      const queued = deferred();
      const notifications: unknown[] = [];
      p.host.extension = async (_method, params) => {
        notifications.push(params);
      };
      p.setPrompt((request) => {
        p.reply(request);
        queued.resolve();
      });
      const steer = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
        sessionId: prompt.sessionId,
        steerId: "cancel-race",
        prompt: prompt.prompt,
      });
      const result = steer.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await queued.promise;
      p.setAbort((request) => {
        if (applied)
          p.emit({
            type: "message_start",
            message: {
              role: "custom",
              customType: "lody-steer",
              details: { steerId: "cancel-race" },
            },
          });
        p.finish();
        p.reply(request);
      });
      await p.client.cancel({ sessionId: prompt.sessionId });
      if (applied) {
        expect(await result).toMatchObject({ value: { outcome: "injected" } });
        expect(notifications).toEqual([
          { sessionId: prompt.sessionId, steerId: "cancel-race" },
        ]);
      } else {
        expect(await result).toMatchObject({ error: { code: -32600 } });
        expect(notifications).toEqual([]);
      }
      await expect(done).resolves.toEqual({ stopReason: "cancelled" });
      p.close();
    },
  );

  it.each(["cancel", "eof"] as const)(
    "settles pending steer on %s without applying it to a later turn",
    async (reason) => {
      const p = peer();
      await start(p);
      const done = p.client.prompt(prompt);
      void done.catch(() => undefined);
      await p.promptReceived.promise;
      await p.accepted.promise;
      const queued = deferred();
      p.setPrompt((request) => {
        p.reply(request);
        queued.resolve();
      });
      const steer = p.client.request(LODY_EXTENSION_METHODS.sessionSteer, {
        sessionId: prompt.sessionId,
        steerId: "pending",
        prompt: prompt.prompt,
      });
      const rejected = expect(steer).rejects.toThrow();
      await queued.promise;
      if (reason === "cancel") {
        await p.client.cancel({ sessionId: prompt.sessionId });
        await done;
        p.close();
      } else {
        p.close();
        await expect(done).rejects.toThrow("closed");
      }
      await rejected;
    },
  );

  it("keeps tool generation distinct from execution, accounts every response, and waits through retry to settled", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    p.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end" },
    });
    p.emit({
      type: "tool_execution_start",
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "a.ts", oldText: "old", newText: "new" },
    });
    p.emit({
      type: "tool_execution_end",
      toolCallId: "edit-1",
      toolName: "edit",
      isError: false,
      result: { content: [{ type: "text", text: "edited" }] },
    });
    p.emit({ ...text("first"), usage });
    p.emit({ ...text(" attempt"), usage });
    p.emit({
      type: "message_end",
      message: response("r1", {
        stopReason: "error",
        errorMessage: "retryable",
      }),
    });
    p.emit({ type: "agent_end", willRetry: true });
    p.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "retryable",
    });
    p.emit({ type: "message_start", message: { role: "assistant" } });
    p.emit(text("recovered"));
    p.emit({
      type: "message_end",
      message: response("r2", { stopReason: "stop" }),
    });
    p.emit({ type: "auto_retry_end", success: true, attempt: 1 });
    p.emit({ type: "compaction_start", reason: "threshold" });
    p.emit({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "summary request failed",
    });
    p.emit({
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "threshold",
    });
    p.emit({ type: "summarization_retry_finished" });
    p.emit({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 3000, estimatedTokensAfter: 300 },
      aborted: false,
      willRetry: false,
    });
    p.finish();
    await expect(done).resolves.toEqual({ stopReason: "end_turn" });
    const history = p.updates.filter(
      (n) =>
        n.update.sessionUpdate !== "usage_update" &&
        !n.update._meta?.lody?.activity &&
        n.update.sessionUpdate !== "config_option_update",
    );
    expect(history.map((n) => n.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "agent_message_chunk",
    ]);
    expect(history[0]?.update).toMatchObject({
      kind: "edit",
      rawInput: {
        file_path: resolve("/work", "a.ts"),
        old_string: "old",
        new_string: "new",
      },
      locations: [{ path: resolve("/work", "a.ts") }],
    });
    expect(history[1]?.update).toMatchObject({
      status: "completed",
      rawOutput: { content: [{ type: "text", text: "edited" }] },
    });
    // The failed attempt spent tokens too; each response counts once.
    expect(p.usages.map((u) => u.delta?.usage.inputTokens)).toEqual([10, 10]);
    expect(p.usages.at(-1)?.modelUsage?.["fixture/one"]).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 2,
      costUSD: 0.02,
    });
    const activities = p.updates.filter((n) => n.update._meta?.lody?.activity);
    expect(
      activities.map((n) => [
        n.update.sessionUpdate,
        "status" in n.update && n.update.status,
      ]),
    ).toEqual([
      ["tool_call", "in_progress"],
      ["tool_call_update", "completed"],
      ["tool_call", "in_progress"],
      ["tool_call", "in_progress"],
      ["tool_call_update", "completed"],
      ["tool_call_update", "completed"],
    ]);
    expect(activities[2]?.update._meta?.lody?.activity).toMatchObject({
      kind: "context_compaction",
      automatic: true,
    });
    p.close();
  });

  it.each(["before", "after", "model-error"])(
    "keeps extension diagnostics separate from the result: %s",
    async (phase) => {
      const p = peer();
      await start(p);
      const diagnostic = () =>
        p.emit({
          type: "extension_error",
          event: phase === "before" ? "input" : "agent_end",
          error: "Extension callback failed",
        });
      p.setPrompt((request) => {
        if (phase === "before" || phase === "handled") diagnostic();
        if (phase === "handled") {
          p.reply(request);
          return;
        }
        p.emit({ type: "agent_start" });
        p.emit({ type: "message_start", message: { role: "assistant" } });
        p.emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: phase === "model-error" ? "error" : "stop",
            errorMessage: "Model failed",
          },
        });
        if (phase === "after" || phase === "model-error") diagnostic();
        p.finish();
        p.reply(request);
      });
      const result = p.client.prompt(prompt);
      if (phase === "model-error")
        await expect(result).rejects.toThrow("Model failed");
      else await expect(result).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        p.updates.map(({ update }) => update._meta?.lody?.notice),
      ).toContainEqual({
        level: "warning",
        message: "Extension callback failed",
        source: "pi",
      });
      p.setPrompt((request) => {
        p.emit({ type: "agent_start" });
        p.reply(request);
        p.finish();
      });
      await expect(p.client.prompt(prompt)).resolves.toEqual({
        stopReason: "end_turn",
      });
      p.close();
    },
  );

  it("fails a settled model error even after partial text, but allows a later prompt", async () => {
    const p = peer();
    await start(p);
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.reply(request);
      p.emit(text("partial"));
      p.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 1,
        delayMs: 100,
        errorMessage: "Model unavailable",
      });
      p.emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Model unavailable",
        },
      });
      p.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "Model unavailable",
      });
      p.finish();
    });
    await expect(p.client.prompt(prompt)).rejects.toThrow("Model unavailable");
    expect(
      p.updates.find((n) => n.update.sessionUpdate === "tool_call_update")
        ?.update,
    ).toMatchObject({
      status: "failed",
      _meta: { lody: { activity: { failureReason: "Model unavailable" } } },
    });
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.reply(request);
      p.finish();
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    p.close();
  });

  it("clears queues before abort and rejects concurrent prompts", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    await expect(p.client.prompt(prompt)).rejects.toThrow("active prompt");
    await p.client.cancel({ sessionId: prompt.sessionId });
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    expect(
      p.commands
        .filter((c) => c.type === "clear_queue" || c.type === "abort")
        .map((c) => c.type),
    ).toEqual(["clear_queue", "abort"]);
    p.close();
  });

  it("holds cancel and the next input behind the same settlement barrier", async () => {
    const p = peer();
    await start(p);
    const stats = deferred<Record<string, unknown>>();
    p.setStats(stats.resolve);
    const done = p.client.prompt(prompt);
    await p.accepted.promise;
    const cancelled = p.client.cancel({ sessionId: prompt.sessionId });
    const repeated = p.client.cancel({ sessionId: prompt.sessionId });
    const request = await stats.promise;
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.reply(request);
      p.finish();
    });
    const next = p.client.prompt(prompt);
    // If admission rejects while stats are pending, this assertion fails even though
    // the old run has already reached Pi's settled event.
    const nextResult = expect(next).resolves.toEqual({
      stopReason: "end_turn",
    });
    p.reply(request, {
      tokens: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
      cost: 0.02,
    });
    p.setStats((request) => p.reply(request));
    await Promise.all([cancelled, repeated, nextResult]);
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    expect(p.commands.filter((c) => c.type === "abort")).toHaveLength(1);
    p.setStats((request) => p.reply(request));
    await p.client.newSession({ cwd: "/work", mcpServers: [] });
    p.close();
  });

  it("cancels input during initial state lookup without dispatching a model request", async () => {
    const p = peer();
    await start(p);
    const accepted = deferred<Record<string, unknown>>();
    p.setState((request) => accepted.resolve(request));
    const idleAbort = deferred();
    p.setAbort((request) => {
      p.reply(request);
      idleAbort.resolve();
    });
    const done = p.client.prompt(prompt);
    const request = await accepted.promise;
    const cancelled = p.client.cancel({ sessionId: prompt.sessionId });
    await idleAbort.promise;
    p.setState((request) => p.reply(request, p.state));
    p.reply(request, p.state);
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    await cancelled;
    expect(p.commands.some((command) => command.type === "prompt")).toBe(false);
    p.close();
  });

  it("rejects an in-flight run on EOF rather than treating the acknowledgement as completion", async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    p.close();
    await expect(done).rejects.toThrow("closed");
  });

  it("resumes exactly the native file and refreshes the thinking ladder after switching models", async () => {
    const p = peer();
    await start(p);
    await p.client.resumeSession({
      sessionId: prompt.sessionId,
      cwd: "/work",
      mcpServers: [],
    });
    expect(p.commands.find((c) => c.type === "switch_session")).toMatchObject({
      sessionPath: prompt.sessionId,
    });
    const response = await p.client.setSessionConfigOption({
      sessionId: prompt.sessionId,
      configId: "model",
      value: "fixture/two",
    });
    expect(
      response.configOptions.find((option) => option.id === "thinking"),
    ).toMatchObject({
      currentValue: "off",
      options: [{ name: "off", value: "off" }],
    });
    await expect(
      p.client.setSessionConfigOption({
        sessionId: prompt.sessionId,
        configId: "thinking",
        value: "high",
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      p.client.resumeSession({
        sessionId: "legacy-pi-acp",
        cwd: "/work",
        mcpServers: [],
      }),
    ).rejects.toThrow("native session file");
    const missing = join(nativeDirectory, "deleted.jsonl");
    for (const open of ["resumeSession", "loadSession"] as const)
      await expect(
        p.client[open]({ sessionId: missing, cwd: "/work", mcpServers: [] }),
      ).rejects.toThrow("ENOENT");
    expect(p.commands.filter((c) => c.type === "switch_session")).toHaveLength(
      1,
    );
    p.close();
  });

  it("replaces workspace roots on each activation and rejects invalid attach before any mutation", async () => {
    const p = peer();
    const workspaces: unknown[] = [];
    p.host.configureWorkspace = async (value) => {
      workspaces.push(value);
    };
    await p.client.newSession({
      cwd: "/work",
      mcpServers: [],
      additionalDirectories: ["/A"],
    });
    await p.client.resumeSession({
      sessionId: nativeSession,
      cwd: "/work",
      additionalDirectories: ["/B"],
    });
    await p.client.loadSession({
      sessionId: nativeSession,
      cwd: "/work",
      mcpServers: [],
      additionalDirectories: [],
    });
    await p.client.resumeSession({ sessionId: nativeSession, cwd: "/work" });
    expect(workspaces).toEqual([
      { cwd: normalize("/work"), additionalDirectories: [normalize("/A")] },
      { cwd: normalize("/work"), additionalDirectories: [normalize("/B")] },
      { cwd: normalize("/work"), additionalDirectories: [] },
      { cwd: normalize("/work"), additionalDirectories: [] },
    ]);
    const commands = p.commands.length;
    for (const open of ["loadSession", "resumeSession"] as const) {
      await expect(
        p.client[open]({
          sessionId: nativeSession,
          cwd: "/different",
          mcpServers: [],
          additionalDirectories: ["/C"],
        }),
      ).rejects.toThrow("cwd");
      await expect(
        p.client[open]({
          sessionId: nativeSession,
          cwd: "/work",
          mcpServers: [],
          additionalDirectories: ["relative"],
        }),
      ).rejects.toThrow("absolute");
    }
    expect(p.commands).toHaveLength(commands);
    expect(workspaces).toHaveLength(4);
    // Failed preflight leaves the prior activation addressable and configured.
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    p.finish();
    await expect(done).resolves.toEqual({ stopReason: "end_turn" });
    p.close();
  });

  it("loads a native file by replaying only its current branch", async () => {
    const p = peer();
    const entry = (id: string, parentId: string | null, fields: object) => ({
      id,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      ...fields,
    });
    const message = (id: string, parentId: string | null, value: object) =>
      entry(id, parentId, { type: "message", message: value });
    const todos = [{ id: 1, text: "Ship", done: false }];
    p.setEntries((request) =>
      p.reply(request, {
        leafId: "a3",
        entries: [
          message("u1", null, {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", data: "aW1n", mimeType: "image/png" },
            ],
          }),
          message("abandoned", "u1", {
            role: "assistant",
            content: [{ type: "text", text: "old branch" }],
          }),
          message("a1", "u1", {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "look first" },
              { type: "text", text: "Reading" },
              {
                type: "toolCall",
                id: "t1",
                name: "read",
                arguments: { path: "a.ts" },
              },
              {
                type: "toolCall",
                id: "t2",
                name: "todo",
                arguments: { action: "add" },
              },
              {
                type: "toolCall",
                id: "t3",
                name: "bash",
                arguments: { command: "x" },
              },
            ],
          }),
          message("r1", "a1", {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "read",
            content: [{ type: "text", text: "file" }],
            isError: false,
          }),
          message("r2", "r1", {
            role: "toolResult",
            toolCallId: "t2",
            toolName: "todo",
            content: [{ type: "text", text: "{}" }],
            details: { todos },
            isError: false,
          }),
          entry("c1", "r2", {
            type: "compaction",
            summary: "internal",
            firstKeptEntryId: "u1",
            tokensBefore: 1,
          }),
          entry("s1", "c1", {
            type: "custom_message",
            customType: "lody-steer",
            content: [{ type: "text", text: "also this" }],
            display: true,
          }),
          message("a3", "s1", {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
          }),
        ],
      }),
    );
    p.setSession((request) => {
      p.reply(request, { cancelled: false });
      // Native resume reconstructs the latest checklist before the replay starts.
      p.emit({
        type: "extension_ui_request",
        method: "notify",
        message: "lody-rpc:" + JSON.stringify({ type: "lody_todos", todos }),
      });
    });
    await p.client.initialize({ protocolVersion: 1 });
    const response = await p.client.loadSession({
      sessionId: prompt.sessionId,
      cwd: "/work",
      mcpServers: [],
    });
    expect(response.configOptions).toBeDefined();
    expect(p.commands.find((c) => c.type === "switch_session")).toMatchObject({
      sessionPath: prompt.sessionId,
    });
    const plan = [{ content: "Ship", priority: "medium", status: "pending" }];
    expect(p.updates.map((u) => u.update)).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "image", data: "aW1n", mimeType: "image/png" },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "look first" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Reading" },
      },
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        kind: "read",
        status: "completed",
        locations: [{ path: resolve("/work", "a.ts") }],
        content: [{ type: "content", content: { type: "text", text: "file" } }],
      }),
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        status: "completed",
      }),
      { sessionUpdate: "plan", entries: plan },
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "t3",
        status: "failed",
      }),
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "also this" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done" },
      },
    ]);
    p.close();
  });

  it("compacts with custom instructions and accounts the summary call on the session model", async () => {
    const p = peer();
    await start(p);
    p.setCompact((request) => {
      p.emit({ type: "compaction_start", reason: "manual" });
      p.emit({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        result: {
          tokensBefore: 2000,
          estimatedTokensAfter: 200,
          usage: { ...usage, input: 1500, cost: { total: 0.03 } },
        },
      });
      p.reply(request, { summary: "synthetic" });
    });
    p.setStats((request) =>
      p.reply(request, {
        tokens: { input: 50, output: 20, cacheRead: 4, cacheWrite: 2 },
        cost: 0.03,
        contextUsage: { tokens: null, contextWindow: 4096 },
      }),
    );
    await expect(
      p.client.prompt({
        ...prompt,
        prompt: [{ type: "text", text: "/compact keep the test results" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(p.commands.find((c) => c.type === "compact")).toMatchObject({
      customInstructions: "keep the test results",
    });
    const activity = p.updates.filter((n) => n.update._meta?.lody?.activity);
    expect(activity.map((n) => n.update)).toMatchObject([
      {
        sessionUpdate: "tool_call",
        status: "in_progress",
        _meta: {
          lody: { activity: { kind: "context_compaction", automatic: false } },
        },
      },
      {
        sessionUpdate: "tool_call_update",
        status: "completed",
        _meta: {
          lody: { activity: { usedTokensBefore: 2000, usedTokensAfter: 200 } },
        },
      },
    ]);
    // No response ran yet in this activation, so the configured model is used.
    expect(p.usages.at(-1)?.modelUsage?.["fixture/one"]).toMatchObject({
      inputTokens: 1500,
      costUSD: 0.03,
    });
    expect(
      p.updates.filter((n) => n.update.sessionUpdate === "usage_update"),
    ).toEqual([]);
    p.close();
  });

  it("reports failed and cancelled compaction without success text and can continue", async () => {
    const p = peer();
    await start(p);
    const compact = {
      ...prompt,
      prompt: [{ type: "text" as const, text: "/compact" }],
    };
    p.setCompact((request) => {
      p.emit({ type: "compaction_start", reason: "manual" });
      p.emit({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        errorMessage: "Summary unavailable",
        willRetry: false,
      });
      p.reply(request, undefined, "Summary unavailable");
    });
    await expect(p.client.prompt(compact)).rejects.toThrow(
      "Summary unavailable",
    );
    const entered = deferred<Record<string, unknown>>();
    p.setCompact(entered.resolve);
    const done = p.client.prompt(compact);
    const command = await entered.promise;
    p.setAbort((request) => {
      p.emit({ type: "compaction_start", reason: "manual" });
      p.emit({
        type: "compaction_end",
        reason: "manual",
        aborted: true,
        willRetry: false,
      });
      p.reply(command, undefined, "Compaction cancelled");
      p.reply(request);
    });
    await p.client.cancel({ sessionId: prompt.sessionId });
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    expect(
      p.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk"),
    ).toEqual([]);
    expect(
      p.updates
        .filter((n) => n.update.sessionUpdate === "tool_call_update")
        .map((n) => n.update),
    ).toMatchObject([
      {
        status: "failed",
        _meta: { lody: { activity: { failureReason: "Summary unavailable" } } },
      },
      {
        status: "failed",
        _meta: { lody: { activity: { failureReason: "Cancelled" } } },
      },
    ]);
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.reply(request);
      p.emit({ type: "compaction_start", reason: "overflow" });
      p.emit({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: true,
        errorMessage: "Automatic summary unavailable",
      });
      p.emit(text("Pi continued after the failed automatic summary"));
      p.finish();
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(
      p.updates
        .filter((n) => n.update.sessionUpdate === "tool_call_update")
        .at(-1)?.update,
    ).toMatchObject({
      status: "failed",
      _meta: {
        lody: {
          activity: {
            automatic: true,
            failureReason: "Automatic summary unavailable",
          },
        },
      },
    });
    p.close();
  });

  it("scopes live per-response usage per activation, with subagents and model provenance", async () => {
    const p = peer();
    await start(p);
    p.setPrompt((request) => {
      p.emit({ type: "agent_start" });
      p.emit({
        type: "message_end",
        message: response("a", { stopReason: "stop" }),
      });
      p.emit(
        lodyEvent({
          type: "lody_usage",
          taskId: "task-1",
          message: response("child", { provider: "other", model: "mini" }),
        }),
      );
      // A repeated report of one response merges instead of adding.
      p.emit({
        type: "message_end",
        message: response("a", { stopReason: "stop" }),
      });
      p.finish();
      p.reply(request);
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(p.usages).toHaveLength(2);
    expect(p.usages[1]?.modelUsage).toMatchObject({
      "fixture/one": { inputTokens: 10, outputTokens: 5 },
      "other/mini": { inputTokens: 10 },
    });
    expect(p.usages[1]?.delta?.modelUsage).toMatchObject({
      "fixture/one": { inputTokens: 0 },
      "other/mini": { inputTokens: 10 },
    });
    const firstScope = p.usages[0]?._meta?.lody?.usageScopeId;
    expect(p.usages[1]?._meta?.lody?.usageScopeId).toBe(firstScope);

    // A resumed activation counts only live responses, under a new scope.
    await p.client.resumeSession({
      sessionId: prompt.sessionId,
      cwd: "/work",
      mcpServers: [],
    });
    await expect(p.client.prompt(prompt)).resolves.toEqual({
      stopReason: "end_turn",
    });
    const resumed = p.usages.at(-1);
    expect(resumed?._meta?.lody?.usageScopeId).not.toBe(firstScope);
    expect(resumed?.modelUsage?.["fixture/one"]?.inputTokens).toBe(10);
    p.close();
  });

  it("keeps stats for context occupancy only, never replaying resumed history as usage", async () => {
    const p = peer();
    let input = 20;
    p.setStats((request) =>
      p.reply(request, {
        tokens: { input, output: 10, cacheRead: 4, cacheWrite: 2 },
        cost: 0.02,
        contextUsage: {
          tokens: 64,
          contextWindow: 4096,
        },
      }),
    );
    await start(p);
    expect(initializeResponse().agentCapabilities?._meta?.lody?.usage).toEqual({
      version: 1,
    });
    await p.client.resumeSession({
      sessionId: prompt.sessionId,
      cwd: "/work",
      mcpServers: [],
    });
    input = 30;
    await p.client.setSessionConfigOption({
      sessionId: prompt.sessionId,
      configId: "model",
      value: "fixture/two",
    });
    // Stats are a sum over the current context: after resume they already hold
    // history, and compaction or retries lower them. They never become usage.
    expect(p.usages).toEqual([]);
    expect(p.updates.at(-1)?.update).toEqual({
      sessionUpdate: "usage_update",
      used: 64,
      size: 4096,
    });
    p.close();
  });

  it("cancels a pending questionnaire before its host answers and ignores the late answer", async () => {
    const p = peer();
    await start(p);
    const seen = deferred();
    const answer = deferred<acp.CreateElicitationResponse>();
    p.host.question = async () => {
      seen.resolve();
      return answer.promise;
    };
    let command!: Record<string, unknown>;
    p.setPrompt((request) => {
      command = request;
      p.reply(request);
      p.emit({ type: "agent_start" });
      p.emit({
        type: "extension_ui_request",
        id: "held",
        method: "input",
        title:
          QUESTION_PREFIX +
          JSON.stringify({
            toolCallId: "question-tool",
            questions: [
              {
                id: "q",
                header: "Input",
                question: "Continue?",
                options: [],
                allowCustomAnswer: true,
              },
            ],
          }),
      });
    });
    const done = p.client.prompt(prompt);
    await seen.promise;
    const cancelled = p.client.cancel({ sessionId: prompt.sessionId });
    await p.questionAnswered.promise;
    const cancelledBeforeAnswer = p.replies.some(
      (r) => r.id === "held" && r.cancelled === true,
    );
    answer.resolve({ action: "accept", content: { q0: "too late" } });
    await p.questionAnswered.promise;
    p.reply(command);
    await expect(done).resolves.toEqual({ stopReason: "cancelled" });
    await cancelled;
    expect(cancelledBeforeAnswer).toBe(true);
    expect(p.replies.filter((r) => r.id === "held")).toEqual([
      { type: "extension_ui_response", id: "held", cancelled: true },
    ]);
    p.close();
  });

  it("rejects startup questionnaires and unsupported dialogs without blocking the wire", async () => {
    const p = peer();
    await start(p);
    p.emit({
      type: "extension_ui_request",
      id: "startup",
      method: "input",
      title:
        QUESTION_PREFIX +
        JSON.stringify({
          toolCallId: "question-tool",
          questions: [
            {
              id: "q",
              header: "Input",
              question: "Continue?",
              options: [],
              allowCustomAnswer: true,
            },
          ],
        }),
    });
    await expect(p.questionAnswered.promise).resolves.toMatchObject({
      id: "startup",
      cancelled: true,
    });
    p.close();
    const active = peer();
    await start(active);
    const done = active.client.prompt(prompt);
    await active.promptReceived.promise;
    active.emit({
      type: "extension_ui_request",
      id: "in-turn",
      method: "select",
      title: "Choose",
      options: ["chosen", "other"],
    });
    await expect(active.questionAnswered.promise).resolves.toMatchObject({
      id: "in-turn",
      cancelled: true,
    });
    active.emit(text("working"));
    active.finish();
    await done;
    expect(
      active.updates.some(
        (n) => n.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(true);
    active.close();
  });
});
