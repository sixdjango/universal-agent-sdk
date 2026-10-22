import { describe, expect, it } from "vitest";
import type { ChildProcess, spawn } from "node:child_process";

import { spawnDevinRuntime } from "../src/runtime-process.js";

describe("spawnDevinRuntime", () => {
  it("launches the official Devin runtime over ACP stdio", () => {
    const child = {} as ChildProcess;
    const env = { DEVIN_TEST_ENV: "enabled" } as NodeJS.ProcessEnv;
    let spawnArgs: unknown;

    const result = spawnDevinRuntime("/opt/devin/bin/devin", {
      env,
      spawnImpl: ((...args: unknown[]) => {
        spawnArgs = args;
        return child;
      }) as unknown as typeof spawn,
    });

    expect(result).toBe(child);
    expect(spawnArgs).toEqual([
      "/opt/devin/bin/devin",
      ["acp"],
      {
        env,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      },
    ]);
  });
});
