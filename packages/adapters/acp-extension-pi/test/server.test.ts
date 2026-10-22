import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Agent, Stream } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agent: undefined as Agent | undefined,
  realProtocol: false,
  runtimes: [] as any[],
  launches: [] as any[],
  validateCwd: vi.fn(),
  fork: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock("@agentclientprotocol/sdk", async (original) => {
  const actual = await original<typeof import("@agentclientprotocol/sdk")>();
  return {
    ...actual,
    AgentSideConnection: class {
      signal = new AbortController().signal;
      constructor(factory: any, stream: Stream) {
        if (mocks.realProtocol)
          return new actual.AgentSideConnection(factory, stream);
        mocks.agent = factory({
          sessionUpdate: vi.fn(),
          extNotification: vi.fn(),
        });
      }
    },
  };
});
vi.mock("cross-spawn", () => ({
  default: (_command: string, _args: string[], options: any) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    mocks.launches.push({ options, child });
    return child;
  },
}));
vi.mock("../src/launch.js", () => ({
  resolvePiLaunch: () => ({ command: "pi", args: [] }),
}));
vi.mock("../src/sessions.js", () => ({
  listPiSessions: vi.fn(),
  validateSessionCwd: mocks.validateCwd,
  forkPiSession: mocks.fork,
}));
vi.mock("../src/connection.js", () => ({
  initializeResponse: () => ({}),
  PiRpcConnection: class {
    id = `/session-${mocks.runtimes.length}.jsonl`;
    busy = false;
    constructor(
      _stream: any,
      public host: any,
    ) {
      mocks.runtimes.push(this);
    }
    initialize = mocks.initialize;
    close = vi.fn();
    newSession = vi.fn(async (request) => {
      await this.host.configureWorkspace({
        cwd: request.cwd,
        additionalDirectories: request.additionalDirectories ?? [],
      });
      return { sessionId: this.id };
    });
    resumeSession = vi.fn(async (request) => {
      await this.host.configureWorkspace({
        cwd: request.cwd,
        additionalDirectories: request.additionalDirectories ?? [],
      });
      this.id = request.sessionId;
      return {};
    });
    loadSession = vi.fn(async (request) => this.resumeSession(request));
    prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    cancel = vi.fn();
    setSessionConfigOption = vi.fn();
    request = vi.fn();
    withIdle = vi.fn(async (action) => {
      if (this.busy) throw new Error("active prompt");
      return action();
    });
  },
}));
import { serve } from "../src/server.js";

const running: ReturnType<typeof serve>[] = [];
const start = () => {
  const server = serve({
    readable: new ReadableStream(),
    writable: new WritableStream(),
  });
  running.push(server);
  return mocks.agent!;
};
const workspace = (index: number) =>
  JSON.parse(
    readFileSync(
      mocks.launches[index].options.env.LODY_PI_WORKSPACE_CONFIG,
      "utf8",
    ),
  );
beforeEach(() => {
  mocks.realProtocol = false;
  mocks.runtimes.length = 0;
  mocks.launches.length = 0;
  mocks.validateCwd.mockReset().mockResolvedValue(undefined);
  mocks.fork.mockReset().mockResolvedValue("/fork.jsonl");
  mocks.initialize.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const { child } of mocks.launches) {
    child.stderr.unpipe(process.stderr);
    child.stderr.destroy();
    child.stdout.destroy();
    child.stdin.destroy();
  }
});

describe("native session runtime ownership", () => {
  it("routes independent new sessions and keeps activation directory replacement private", async () => {
    const agent = start();
    const first = await agent.newSession({
      cwd: "/main",
      mcpServers: [],
      additionalDirectories: ["/a"],
    });
    const second = await agent.newSession({
      cwd: "/other",
      mcpServers: [],
      additionalDirectories: ["/sibling"],
    });
    for (const roots of [["/b"], [], undefined]) {
      await agent.resumeSession!({
        sessionId: first.sessionId,
        cwd: "/main",
        mcpServers: [],
        additionalDirectories: roots,
      });
      expect(workspace(0).additionalDirectories).toEqual(roots ?? []);
      expect(workspace(1).additionalDirectories).toEqual(["/sibling"]);
    }
    await agent.prompt({ sessionId: first.sessionId, prompt: [] });
    await agent.prompt({ sessionId: second.sessionId, prompt: [] });
    expect(mocks.runtimes).toHaveLength(2);
    expect(mocks.runtimes[0].prompt).toHaveBeenCalledWith({
      sessionId: first.sessionId,
      prompt: [],
    });
    expect(mocks.runtimes[1].prompt).toHaveBeenCalledWith({
      sessionId: second.sessionId,
      prompt: [],
    });
  });

  it("validates workspace and persisted cwd before spawning or reconfiguring load/resume", async () => {
    const agent = start();
    await expect(
      agent.newSession({ cwd: "relative", mcpServers: [] }),
    ).rejects.toThrow();
    expect(mocks.launches).toHaveLength(0);
    await agent.newSession({
      cwd: "/main",
      mcpServers: [],
      additionalDirectories: ["/a"],
    });
    mocks.validateCwd.mockRejectedValue(new Error("cwd mismatch"));
    for (const method of [agent.loadSession!, agent.resumeSession!]) {
      await expect(
        method({
          sessionId: "/session-0.jsonl",
          cwd: "/wrong",
          mcpServers: [],
        }),
      ).rejects.toThrow("cwd mismatch");
      await expect(
        method({ sessionId: "/cold.jsonl", cwd: "/wrong", mcpServers: [] }),
      ).rejects.toThrow("cwd mismatch");
    }
    expect(mocks.launches).toHaveLength(1);
    expect(mocks.runtimes[0].resumeSession).not.toHaveBeenCalled();
    expect(workspace(0).additionalDirectories).toEqual(["/a"]);
  });

  it("forks into an independent target cwd without replacing a live source; busy source rejects before native fork", async () => {
    const agent = start();
    const source = await agent.newSession({
      cwd: "/main",
      mcpServers: [],
      additionalDirectories: ["/a"],
    });
    mocks.runtimes[0].busy = true;
    const targetCwd = resolve("fork-target");
    const request = {
      sessionId: source.sessionId,
      cwd: targetCwd,
      mcpServers: [],
      additionalDirectories: ["/b"],
    };
    await expect(agent.unstable_forkSession!(request)).rejects.toThrow(
      "active prompt",
    );
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(mocks.launches).toHaveLength(1);
    mocks.runtimes[0].busy = false;
    const fork = await agent.unstable_forkSession!(request);
    expect(fork.sessionId).toBe("/fork.jsonl");
    expect(mocks.fork).toHaveBeenCalledWith(source.sessionId, targetCwd);
    expect(mocks.runtimes[0].resumeSession).not.toHaveBeenCalled();
    expect(workspace(0)).toEqual({
      cwd: "/main",
      additionalDirectories: ["/a"],
    });
    expect(workspace(1)).toEqual({
      cwd: targetCwd,
      additionalDirectories: ["/b"],
    });
    await agent.prompt({ sessionId: source.sessionId, prompt: [] });
    await agent.prompt({ sessionId: fork.sessionId, prompt: [] });
    expect(
      mocks.runtimes.every((pi) => pi.prompt.mock.calls.length === 1),
    ).toBe(true);
  });

  it("cold-loads once, rejects competing lifecycle requests, and closes every private runtime", async () => {
    const agent = start();
    let ready!: () => void;
    mocks.initialize.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const loading = agent.loadSession!({
      sessionId: "/cold.jsonl",
      cwd: "/main",
      mcpServers: [],
      additionalDirectories: ["/cold-root"],
    });
    await expect(
      agent.newSession({ cwd: "/main", mcpServers: [] }),
    ).rejects.toThrow("lifecycle");
    ready();
    await loading;
    await agent.loadSession!({
      sessionId: "/cold.jsonl",
      cwd: "/main",
      mcpServers: [],
    });
    expect(mocks.launches).toHaveLength(1);
    expect(workspace(0).additionalDirectories).toEqual([]);
    await agent.newSession({ cwd: "/main", mcpServers: [] });
    const files = mocks.launches.map(
      (launch) => launch.options.env.LODY_PI_WORKSPACE_CONFIG,
    );
    await running[0].close();
    expect(files.every((file) => !existsSync(file))).toBe(true);
    expect(mocks.runtimes.every((pi) => pi.close.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it("fails the whole ACP connection on unexpected Pi exit and cleans sibling runtimes", async () => {
    const previousExitCode = process.exitCode;
    try {
      const agent = start();
      const first = await agent.newSession({ cwd: "/main", mcpServers: [] });
      await agent.newSession({ cwd: "/other", mcpServers: [] });
      mocks.launches[0].child.emit("exit", 1, null);
      await running[0].closed;
      expect(process.exitCode).toBe(1);
      expect(
        mocks.runtimes.every((pi) => pi.close.mock.calls.length === 1),
      ).toBe(true);
      await expect(
        agent.prompt({ sessionId: first.sessionId, prompt: [] }),
      ).rejects.toThrow("closed");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
  it("fails the connection when native startup initialization fails before Pi exits", async () => {
    const previousExitCode = process.exitCode;
    try {
      const agent = start();
      const source = await agent.newSession({ cwd: "/main", mcpServers: [] });
      mocks.initialize.mockRejectedValueOnce(
        new Error("Required extension failed"),
      );
      await expect(
        agent.newSession({ cwd: "/other", mcpServers: [] }),
      ).rejects.toThrow("Required extension failed");
      await running[0].closed;
      expect(process.exitCode).toBe(1);
      expect(mocks.runtimes).toHaveLength(2);
      expect(
        mocks.runtimes.every((pi) => pi.close.mock.calls.length === 1),
      ).toBe(true);
      await expect(
        agent.prompt({ sessionId: source.sessionId, prompt: [] }),
      ).rejects.toThrow("closed");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("keeps sibling sessions alive when configuration fails after successful native startup", async () => {
    const previousExitCode = process.exitCode;
    const agent = start();
    const source = await agent.newSession({ cwd: "/main", mcpServers: [] });
    mocks.initialize.mockImplementationOnce(async () => {
      mocks.runtimes
        .at(-1)
        .newSession.mockRejectedValueOnce(new Error("Invalid configuration"));
      return {};
    });
    await expect(
      agent.newSession({ cwd: "/other", mcpServers: [] }),
    ).rejects.toThrow("Invalid configuration");
    expect(process.exitCode).toBe(previousExitCode);
    expect(mocks.runtimes[0].close).not.toHaveBeenCalled();
    expect(mocks.runtimes[1].close).toHaveBeenCalledOnce();
    await expect(
      agent.prompt({ sessionId: source.sessionId, prompt: [] }),
    ).resolves.toEqual({ stopReason: "end_turn" });
  });
  it("rejects startup with extension diagnostics before shutdown completes", async () => {
    const previousExitCode = process.exitCode;
    try {
      const agent = start();
      const events: string[] = [];
      void running[0].closed.then(() => events.push("closed"));
      mocks.initialize.mockImplementationOnce(async () => {
        const stderr = mocks.launches.at(-1).child.stderr;
        stderr.unpipe(process.stderr);
        stderr.emit(
          "data",
          "Failed to load extension synthetic-failure.ts: fixture error\n",
        );
        throw new Error("Required extension did not initialize");
      });
      await expect(
        agent.newSession({ cwd: "/main", mcpServers: [] }).catch((error) => {
          events.push("rejected");
          throw error;
        }),
      ).rejects.toThrow(
        "Failed to load extension synthetic-failure.ts: fixture error",
      );
      await running[0].closed;
      expect(events).toEqual(["rejected", "closed"]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
  it("waits for the real SDK startup error response write before resolving closed", async () => {
    const previousExitCode = process.exitCode;
    mocks.realProtocol = true;
    let releaseWrite!: () => void;
    let responseStarted!: (message: any) => void;
    const response = new Promise<any>((resolve) => {
      responseStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const inbound = new TransformStream();
    const server = serve({
      readable: inbound.readable,
      writable: new WritableStream({
        async write(message) {
          responseStarted(message);
          await writeGate;
        },
      }),
    });
    running.push(server);
    let closed = false;
    void server.closed.then(() => {
      closed = true;
    });
    mocks.initialize.mockImplementationOnce(async () => {
      const stderr = mocks.launches.at(-1).child.stderr;
      stderr.unpipe(process.stderr);
      stderr.emit(
        "data",
        "Failed to load extension conflict.ts: Tool todo conflicts with packaged extension\n",
      );
      throw new Error("Required extension did not initialize");
    });
    const writer = inbound.writable.getWriter();
    try {
      await writer.write({
        jsonrpc: "2.0",
        id: 7,
        method: "session/new",
        params: { cwd: "/main", mcpServers: [] },
      });
      const message = await response;
      expect(message.id).toBe(7);
      expect(message.error.data.details).toContain("Tool todo conflicts with");
      expect(closed).toBe(false);
      releaseWrite();
      await server.closed;
      expect(closed).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      releaseWrite();
      await writer.close();
      writer.releaseLock();
      process.exitCode = previousExitCode;
    }
  });
});
