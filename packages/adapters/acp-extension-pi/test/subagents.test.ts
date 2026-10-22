import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PI_PATH_ENV } from "../src/launch.js";
import { registerSubagents } from "../src/subagents.js";

type SubagentTool = ToolDefinition & {
  execute: (
    parentToolCallId: string,
    input: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};

// A fake Pi that records the argv it receives, then exits. Mirrors how npm
// installs Pi: a `.cmd` shim on Windows, an executable script elsewhere.
function createRecorderShim(directory: string): string {
  writeFileSync(
    join(directory, "recorder.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
      "writeFileSync(process.env.RECORDER_OUT, JSON.stringify(process.argv.slice(2)));\n",
  );

  if (process.platform === "win32") {
    const shimPath = join(directory, "recorder.cmd");
    writeFileSync(
      shimPath,
      `@echo off\r\n"${process.execPath}" "%~dp0recorder.mjs" %*\r\n`,
    );
    return shimPath;
  }

  const shimPath = join(directory, "recorder.sh");
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/recorder.mjs" "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

async function runSubagent(input: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-test-"));
  const shimPath = createRecorderShim(directory);
  const outputPath = join(directory, "argv.json");

  let tool: SubagentTool | undefined;
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((definition: SubagentTool) => {
      tool = definition;
    }),
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const events: unknown[] = [];
  registerSubagents(pi, (_ctx, event) => events.push(event));

  const previousPath = process.env[PI_PATH_ENV];
  const previousOut = process.env.RECORDER_OUT;
  process.env[PI_PATH_ENV] = shimPath;
  process.env.RECORDER_OUT = outputPath;
  try {
    await tool!.execute("call-1", input, undefined, undefined, {
      model: { provider: "test", id: "model" },
      modelRegistry: {
        getAvailable: () => [
          { provider: "test", id: "model" },
          { provider: "other", id: "vendor/large" },
          ...Array.from({ length: 25 }, (_, i) => ({
            provider: "bulk",
            id: `m${i}`,
          })),
        ],
      },
      cwd: directory,
    } as unknown as ExtensionContext);
    return {
      argv: JSON.parse(readFileSync(outputPath, "utf8")) as string[],
      events,
    };
  } finally {
    if (previousPath === undefined) delete process.env[PI_PATH_ENV];
    else process.env[PI_PATH_ENV] = previousPath;
    if (previousOut === undefined) delete process.env.RECORDER_OUT;
    else process.env.RECORDER_OUT = previousOut;
  }
}

const modelArg = (argv: string[]) => argv[argv.indexOf("--model") + 1];

describe("registerSubagents", () => {
  it("passes the raw task text to the child process without shell interpolation", async () => {
    const task = "Please explain why %PATH% is different here & echo PWNED";
    const { argv } = await runSubagent({ task, description: "test" });
    expect(argv).toContain(task);
    expect(modelArg(argv)).toBe("test/model");
  });

  it("runs the child on an explicitly selected available model", async () => {
    const { argv, events } = await runSubagent({
      task: "review",
      description: "test",
      model: "other/vendor/large",
    });
    expect(modelArg(argv)).toBe("other/vendor/large");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "lody_subagent",
        event: "started",
        task: expect.objectContaining({ modelId: "other/vendor/large" }),
      }),
    );
  });

  it("rejects an unavailable model before launching a child", async () => {
    await expect(
      runSubagent({
        task: "review",
        description: "test",
        model: "test/missing",
      }),
    ).rejects.toThrow(
      'Model "test/missing" is not an available provider/model-id. Available test models: model',
    );
    await expect(
      runSubagent({ task: "review", description: "test", model: "missing" }),
    ).rejects.toThrow("Available providers: test, other, bulk");
    await expect(
      runSubagent({ task: "review", description: "test", model: "bulk/x" }),
    ).rejects.toThrow(/: m0, m1, .*, m19 and 5 more$/);
  });
});
