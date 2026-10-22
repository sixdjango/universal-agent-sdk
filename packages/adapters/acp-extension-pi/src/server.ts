import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSideConnection,
  RequestError,
  type Agent,
  type Stream,
} from "@agentclientprotocol/sdk";
import {
  LODY_EXTENSION_METHODS,
  normalizeLodyExtensionMethod,
  supportsLodySubagentEvents,
} from "acp-extension-core";
import { PiStderrDiagnostics } from "./diagnostics.js";
import { PiRpcConnection, initializeResponse } from "./connection.js";
import { PI_EXTENSIONS_ENV, parsePiLaunchArgs } from "./extensions.js";
import { resolvePiLaunch } from "./launch.js";
import { MCP_CONFIG_ENV } from "./mcp.js";
import {
  forkPiSession,
  listPiSessions,
  validateSessionCwd,
} from "./sessions.js";
import { validateWorkspace, WORKSPACE_CONFIG_ENV } from "./workspace.js";

const SHUTDOWN_GRACE_MS = 1_000;

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", exited);
      resolve();
    }, SHUTDOWN_GRACE_MS);
    const exited = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", exited);
  });
}

/** Drain accepted ACP requests through their actual response writes before exit. */
function drainingStream(stream: Stream) {
  const pending = new Set<unknown>();
  let disconnected = false;
  let drained: (() => void) | undefined;
  const settle = () => {
    if (disconnected || pending.size === 0) drained?.();
  };
  const disconnect = () => {
    disconnected = true;
    settle();
  };
  const tracked: Stream = {
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          if ("method" in message && "id" in message) pending.add(message.id);
          controller.enqueue(message);
        },
      }),
    ),
    writable: new WritableStream({
      async write(message) {
        const writer = stream.writable.getWriter();
        try {
          await writer.write(message);
          if (!("method" in message) && "id" in message) {
            pending.delete(message.id);
            settle();
          }
        } catch (error) {
          disconnect();
          throw error;
        } finally {
          writer.releaseLock();
        }
      },
      abort: disconnect,
    }),
  };
  return {
    stream: tracked,
    disconnect,
    drain: () =>
      disconnected || pending.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            drained = resolve;
          }),
  };
}

/** Each native session owns a runtime; the native file path is its routing key. */
export function serve(stream: Stream, piArgs: string[] = []) {
  const parsed = parsePiLaunchArgs(piArgs);
  const output = drainingStream(stream);
  type OwnedRuntime = {
    child: ChildProcess;
    pi: PiRpcConnection;
    configDirectory: string;
    stopping?: Promise<void>;
  };
  const ownedRuntimes = new Set<OwnedRuntime>();
  const sessions = new Map<string, PiRpcConnection>();
  let subagentEvents = false;
  let closing: Promise<void> | undefined;
  let lifecycleBusy = false;
  let piExitedUnexpectedly = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const stop = (owned: OwnedRuntime): Promise<void> => {
    if (owned.stopping) return owned.stopping;
    owned.stopping = Promise.resolve().then(async () => {
      owned.pi.close();
      try {
        const child = owned.child;
        if (!child.pid) return;
        if (process.platform === "win32") child.stdin?.end();
        else {
          // Pi stops tracked detached tools before awaiting shutdown hooks.
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* Already exited. */
          }
        }
        await waitForExit(child);
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
          await waitForExit(child);
        }
      } finally {
        rmSync(owned.configDirectory, { recursive: true, force: true });
        ownedRuntimes.delete(owned);
      }
    });
    return owned.stopping;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      try {
        await Promise.all([...ownedRuntimes].map(stop));
        await output.drain();
      } finally {
        resolveClosed();
      }
    });
    return closing;
  };
  const lifecycle = async <T>(action: () => Promise<T>): Promise<T> => {
    if (closing) throw new Error("ACP connection closed");
    if (lifecycleBusy)
      throw new Error("Pi session lifecycle operation already in progress");
    lifecycleBusy = true;
    try {
      return await action();
    } finally {
      lifecycleBusy = false;
    }
  };
  const connection = new AgentSideConnection((client): Agent => {
    const get = (sessionId: string) => {
      if (closing) throw new Error("ACP connection closed");
      const pi = sessions.get(sessionId);
      if (!pi)
        throw RequestError.invalidRequest(
          undefined,
          "Create or resume this session first",
        );
      return pi;
    };
    const start = async (workspace: ReturnType<typeof validateWorkspace>) => {
      if (closing) throw new Error("ACP connection closed");
      const configDirectory = mkdtempSync(join(tmpdir(), "lody-pi-config-"));
      const configPath = join(configDirectory, "servers.json");
      const workspacePath = join(configDirectory, "workspace.json");
      writeFileSync(configPath, "[]", { mode: 0o600 });
      writeFileSync(workspacePath, JSON.stringify(workspace), { mode: 0o600 });
      const extensionEntryUrl = (() => {
        const siblingUrl = new URL("./extension.js", import.meta.url);
        if (existsSync(fileURLToPath(siblingUrl))) return siblingUrl;
        try {
          return new URL(import.meta.resolve("@universal-agent/acp-extension-pi/dist/extension.js"));
        } catch {
          return siblingUrl;
        }
      })();
      const { command, args: launchArgs } = resolvePiLaunch([
        ...parsed.args,
        "--mode",
        "rpc",
        "--no-extensions",
        "-e",
        "builtin:codemode",
        "-e",
        fileURLToPath(extensionEntryUrl),
      ]);
      const child = spawn(command, launchArgs, {
        cwd: workspace.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          [MCP_CONFIG_ENV]: configPath,
          [WORKSPACE_CONFIG_ENV]: workspacePath,
          [PI_EXTENSIONS_ENV]: JSON.stringify(parsed.extensions),
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      child.once("exit", () => {
        if (owned.stopping) return;
        if (!closing) {
          piExitedUnexpectedly = true;
          process.exitCode = 1;
        }
        void close();
      });
      child.once("error", (error) => {
        console.error("[acp-extension-pi] Failed to launch Pi:", error);
        process.exitCode = 1;
        void close();
      });
      const diagnostics = new PiStderrDiagnostics(
        () => !closing || piExitedUnexpectedly,
      );
      child.stderr!.setEncoding("utf8");
      child.stderr!.pipe(process.stderr, { end: false });
      child.stderr!.on("data", (chunk) => diagnostics.append(chunk));
      const pi = new PiRpcConnection(
        {
          writable: Writable.toWeb(child.stdin!),
          readable: Readable.toWeb(child.stdout!),
        },
        {
          subagentEvents,
          configureWorkspace: async (nextWorkspace) => {
            if (closing) throw new Error("ACP connection closed");
            writeFileSync(workspacePath, JSON.stringify(nextWorkspace), {
              mode: 0o600,
            });
          },
          configureMcp: async (servers) => {
            // Configuration exclusion keeps this write before the next runtime loads it.
            if (closing) throw new Error("ACP connection closed");
            writeFileSync(configPath, JSON.stringify(servers), {
              mode: 0o600,
            });
          },
          update: (notification) => client.sessionUpdate(notification),
          // Notifications are sent in Pi event order. Lody owns the application lease
          // and gates session updates after the matching Core notification arrives.
          extension: (method, params) => client.extNotification(method, params),
          usage: (usage) => {
            void client
              .extNotification(LODY_EXTENSION_METHODS.sessionUsageUpdate, {
                ...usage,
              })
              .catch(close);
          },
          question: (request) => client.unstable_createElicitation(request),
        },
        (error) => diagnostics.decorateError(error),
      );
      const owned: OwnedRuntime = { child, pi, configDirectory };
      ownedRuntimes.add(owned);
      try {
        await Promise.race([
          pi.initialize({ protocolVersion: 1 }),
          new Promise<never>((_resolve, reject) => child.once("error", reject)),
        ]);
        diagnostics.stop();
        if (closing) throw new Error("ACP connection closed");
        return owned;
      } catch (error) {
        // Failure to initialize the native transport/required extension is fatal,
        // even if our cleanup stops Pi before its unexpected exit is observed.
        if (!closing) {
          piExitedUnexpectedly = true;
          process.exitCode = 1;
        }
        // Let the request reject before shutdown resolves `closed` (the
        // executable exits then), so ACP can deliver the startup diagnostics.
        void close();
        throw diagnostics.decorateError(error);
      }
    };
    const activate = async <T>(
      workspace: ReturnType<typeof validateWorkspace>,
      action: (pi: PiRpcConnection) => Promise<T>,
      identity: (result: T) => string,
    ): Promise<T> => {
      const owned = await start(workspace);
      try {
        const result = await action(owned.pi);
        sessions.set(identity(result), owned.pi);
        return result;
      } catch (error) {
        await stop(owned);
        throw error;
      }
    };
    const validate = (request: { mcpServers?: unknown[] }) => {
      if (
        request.mcpServers?.some(
          (server) =>
            !server || typeof server !== "object" || !("command" in server),
        )
      )
        throw RequestError.invalidRequest(
          undefined,
          "Pi supports stdio MCP servers only",
        );
    };
    return {
      initialize: async (request) => {
        subagentEvents = supportsLodySubagentEvents(request.clientCapabilities);
        return initializeResponse();
      },
      authenticate: async () => {
        throw RequestError.invalidRequest(
          undefined,
          "Authenticate through Pi on the execution machine",
        );
      },
      newSession: (request) =>
        lifecycle(async () => {
          validate(request);
          const workspace = validateWorkspace(request);
          return activate(
            workspace,
            (pi) => pi.newSession(request),
            (result) => result.sessionId,
          );
        }),
      resumeSession: (request) =>
        lifecycle(async () => {
          validate(request);
          const workspace = validateWorkspace(request);
          await validateSessionCwd(request.sessionId, workspace.cwd);
          const existing = sessions.get(request.sessionId);
          if (existing) return existing.resumeSession(request);
          return activate(
            workspace,
            (pi) => pi.resumeSession(request),
            () => request.sessionId,
          );
        }),
      loadSession: (request) =>
        lifecycle(async () => {
          validate(request);
          const workspace = validateWorkspace(request);
          await validateSessionCwd(request.sessionId, workspace.cwd);
          const existing = sessions.get(request.sessionId);
          if (existing) return existing.loadSession(request);
          return activate(
            workspace,
            (pi) => pi.loadSession(request),
            () => request.sessionId,
          );
        }),
      unstable_forkSession: (request) =>
        lifecycle(async () => {
          validate(request);
          const workspace = validateWorkspace(request);
          const fork = async () => {
            const sessionId = await forkPiSession(
              request.sessionId,
              workspace.cwd,
            );
            return activate(
              workspace,
              async (pi) => ({
                ...(await pi.resumeSession({ ...request, sessionId })),
                sessionId,
              }),
              () => sessionId,
            );
          };
          const source = sessions.get(request.sessionId);
          return source ? source.withIdle(fork) : fork();
        }),
      listSessions: listPiSessions,
      prompt: async (request) => get(request.sessionId).prompt(request),
      cancel: async (request) => get(request.sessionId).cancel(request),
      setSessionConfigOption: async (request) =>
        get(request.sessionId).setSessionConfigOption(request),
      extMethod: async (method, params) => {
        if (!params || typeof params.sessionId !== "string")
          throw RequestError.invalidRequest(
            undefined,
            "A sessionId is required",
          );
        return get(params.sessionId).request(
          normalizeLodyExtensionMethod(method),
          params,
        );
      },
    };
  }, output.stream);
  connection.signal.addEventListener(
    "abort",
    () => {
      output.disconnect();
      void close();
    },
    {
      once: true,
    },
  );
  return { connection, close, closed };
}
