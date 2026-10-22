import spawn from "cross-spawn";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { LodySubagentTask, LodyTaskMeta } from "acp-extension-core";
import { z } from "zod";
import { PI_EXTENSIONS_ENV } from "./extensions.js";
import { resolvePiLaunch } from "./launch.js";

const MAX_OUTPUT = 64 * 1024;
type Task = {
  info: LodySubagentTask;
  output: string;
  finished: Promise<void>;
  cancel: () => Promise<void>;
};

/** The process owner supplies identity, terminal status and cancellation to Lody. */
export function registerSubagents(
  pi: ExtensionAPI,
  emit: (ctx: ExtensionContext, event: unknown) => void,
) {
  const tasks = new Map<string, Task>();
  pi.on("session_shutdown", async () => {
    await Promise.all([...tasks.values()].map((task) => task.cancel()));
    tasks.clear();
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a focused task to an isolated Pi agent and wait for its result. It cannot ask the user or spawn further subagents; return missing information to the main agent.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        description: { type: "string" },
        model: {
          type: "string",
          description:
            "Optional provider/model-id of an available Pi model. Omit to use the current model.",
        },
      },
      required: ["task", "description"],
    } as ToolDefinition["parameters"],
    async execute(parentToolCallId, input, signal, _update, ctx) {
      const args = z
        .object({
          task: z.string().min(1),
          description: z.string().min(1),
          model: z.string().min(1).optional(),
        })
        .parse(input);
      if (signal?.aborted) throw new Error("Subagent cancelled before launch");
      const model = args.model
        ? resolveModel(ctx, args.model)
        : ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
      if (!model) throw new Error("Select a model before starting a subagent");
      const id = randomUUID();
      const extensions: string[] = JSON.parse(
        process.env[PI_EXTENSIONS_ENV] ?? "[]",
      );
      const { command, args: launchArgs } = resolvePiLaunch([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "-e",
        "builtin:codemode",
        ...extensions.flatMap((path) => ["-e", path]),
        "--model",
        model,
        "--thinking",
        pi.getThinkingLevel(),
        "-e",
        fileURLToPath(new URL("./child-context.js", import.meta.url)),
        "--",
        args.task,
      ]);
      const proc = spawn(command, launchArgs, {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Stay in the parent Pi process group so adapter shutdown also kills
        // children if Pi cannot finish its cooperative shutdown hook.
        detached: false,
        windowsHide: true,
      });
      let finish!: () => void;
      let cancellation: Promise<void> | undefined;
      let forced: ReturnType<typeof setTimeout> | undefined;
      let failed = false;
      let buffer = "";
      let messageId = randomUUID();
      let lastToolName: string | undefined;
      const info: LodySubagentTask = {
        taskId: id,
        description: args.description,
        status: "running",
        modelId: model,
        startedAtEpochSeconds: Date.now() / 1000,
        endedAtEpochSeconds: null,
      };
      const publish = (event: "started" | "updated" = "updated") => {
        const meta: LodyTaskMeta = {
          version: 1,
          taskId: id,
          kind: "subagent",
          parentToolCallId,
          description: info.description,
          modelId: info.modelId,
          status:
            info.status === "running"
              ? "in_progress"
              : info.status === "completed"
                ? "completed"
                : "failed",
          startedAtEpochSeconds: info.startedAtEpochSeconds,
          ...(info.endedAtEpochSeconds === null
            ? {}
            : { endedAtEpochSeconds: info.endedAtEpochSeconds }),
          ...(info.stopReason ? { error: info.stopReason } : {}),
          ...(lastToolName ? { lastToolName } : {}),
        };
        emit(ctx, {
          type: "lody_subagent",
          event,
          task: meta,
          state: info.status,
        });
      };
      const kill = (force: boolean) => {
        if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid)
          return;
        if (process.platform === "win32") {
          const killer = spawn(
            join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/pid", String(proc.pid), "/T", ...(force ? ["/F"] : [])],
            { stdio: "ignore", windowsHide: true },
          );
          killer.on("error", () => proc.kill(force ? "SIGKILL" : "SIGTERM"));
        } else {
          try {
            proc.kill(force ? "SIGKILL" : "SIGTERM");
          } catch {
            /* Already exited. */
          }
        }
      };
      const task: Task = {
        info,
        output: "",
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        cancel: () => {
          if (info.status !== "running") return task.finished;
          cancellation ??= (async () => {
            kill(false);
            forced = setTimeout(() => kill(true), 1000);
            await task.finished;
          })();
          return cancellation;
        },
      };
      tasks.set(id, task);
      publish("started");
      const append = (text: string) => {
        task.output = (task.output + text).slice(-MAX_OUTPUT);
      };
      proc.stderr!.on("data", (chunk) => append(String(chunk)));
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) {
          failed = true;
          void task.cancel();
          return;
        }
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_start") messageId = randomUUID();
            if (
              [
                "message_update",
                "tool_execution_start",
                "tool_execution_update",
                "tool_execution_end",
              ].includes(event.type)
            ) {
              emit(ctx, {
                type: "lody_subagent_output",
                taskId: id,
                messageId,
                event,
              });
            }
            if (
              event.type === "message_update" &&
              event.assistantMessageEvent?.type === "text_delta"
            ) {
              append(String(event.assistantMessageEvent.delta ?? ""));
            }
            if (event.type === "tool_execution_start") {
              lastToolName = String(event.toolName);
              publish();
            }
            if (
              event.type === "message_end" &&
              event.message?.role === "assistant"
            ) {
              // Child usage is live-only (--no-session); forward just its accounting fields.
              const { provider, model, responseId, timestamp, usage } =
                event.message;
              emit(ctx, {
                type: "lody_usage",
                taskId: id,
                message: {
                  role: "assistant",
                  provider,
                  model,
                  responseId,
                  timestamp,
                  usage,
                },
              });
              append("\n");
              failed = ["error", "aborted", "length"].includes(
                event.message.stopReason,
              );
              if (failed) {
                info.stopReason =
                  event.message.errorMessage ?? event.message.stopReason;
              } else info.stopReason = undefined;
            }
          } catch {
            failed = true;
            append("Invalid Pi subagent output\n");
            void task.cancel();
          }
        }
      });
      proc.on("error", (error) => {
        failed = true;
        info.stopReason = error.message;
      });
      const abort = () => {
        void task.cancel();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      proc.once("close", (code) => {
        if (forced) clearTimeout(forced);
        signal?.removeEventListener("abort", abort);
        info.status = cancellation
          ? "killed"
          : failed || code !== 0
            ? "failed"
            : "completed";
        info.endedAtEpochSeconds = Date.now() / 1000;
        if (info.status === "killed") info.stopReason = "Cancelled";
        else if (info.status === "failed")
          info.stopReason ??= `Pi exited with code ${code}`;
        publish();
        finish();
      });
      await task.finished;
      return {
        content: [
          {
            type: "text" as const,
            text:
              [info.stopReason, task.output].filter(Boolean).join("\n") ||
              "Subagent completed without text output",
          },
        ],
        details: {
          taskId: id,
          status: info.status,
          isError: info.status !== "completed",
        },
      };
    },
  });
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "subagent" &&
      (event.details as { isError?: boolean } | undefined)?.isError
    )
      return { isError: true };
  });
  return async (request: {
    op: string;
    taskId?: string;
    activeOnly?: boolean;
    tail?: number;
  }) => {
    if (request.op === "list")
      return {
        tasks: [...tasks.values()]
          .filter(
            (task) => !request.activeOnly || task.info.status === "running",
          )
          .map((task) => task.info),
      };
    const task = tasks.get(request.taskId ?? "");
    if (!task) throw new Error("Unknown Pi subagent task");
    if (request.op === "cancel") {
      await task.cancel();
      return {};
    }
    if (request.op === "output")
      return {
        output: task.output.slice(
          -Math.max(1, Math.min(request.tail ?? MAX_OUTPUT, MAX_OUTPUT)),
        ),
      };
    throw new Error("Unsupported subagent operation");
  };
}

function resolveModel(ctx: ExtensionContext, requested: string): string {
  const available = ctx.modelRegistry.getAvailable();
  const slash = requested.indexOf("/");
  const provider = requested.slice(0, slash);
  const match = available.find(
    (model) =>
      slash > 0 &&
      model.provider === provider &&
      model.id === requested.slice(slash + 1),
  );
  if (match) return `${match.provider}/${match.id}`;
  const sameProvider = available.filter((model) => model.provider === provider);
  const hint = sameProvider.length
    ? `Available ${provider} models: ${list(sameProvider.map((model) => model.id))}`
    : `Available providers: ${list([...new Set(available.map((model) => model.provider))])}`;
  throw new Error(
    `Model "${requested}" is not an available provider/model-id. ${hint}`,
  );
}

const MAX_HINTS = 20;

function list(names: string[]): string {
  if (!names.length) return "none";
  const shown = names.slice(0, MAX_HINTS).join(", ");
  return names.length > MAX_HINTS
    ? `${shown} and ${names.length - MAX_HINTS} more`
    : shown;
}
