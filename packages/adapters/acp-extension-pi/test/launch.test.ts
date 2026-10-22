import { spawn } from "cross-spawn";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PI_PATH_ENV, UA_PI_PATH_ENV, resolvePiLaunch } from "../src/launch.js";

describe("resolvePiLaunch", () => {
  it("falls back to the packaged Pi CLI run by the current Node", () => {
    const launch = resolvePiLaunch(
      ["--mode", "rpc"],
      {},
      () => "/pkg/bundle/cli.js",
    );
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["/pkg/bundle/cli.js", "--mode", "rpc"]);
  });

  it("spawns a user-supplied executable verbatim with plain args via UA_PI_PATH or LODY_PI_PATH", () => {
    const launchUa = resolvePiLaunch(
      [
        "--mode",
        "rpc",
        "--append-system-prompt",
        'You are a "subagent" & echo PWNED',
      ],
      { [UA_PI_PATH_ENV]: "/usr/local/bin/pi with space" },
    );
    expect(launchUa.command).toBe("/usr/local/bin/pi with space");

    const launch = resolvePiLaunch(
      [
        "--mode",
        "rpc",
        "--append-system-prompt",
        'You are a "subagent" & echo PWNED',
      ],
      { [PI_PATH_ENV]: "/usr/local/bin/pi with space" },
    );
    expect(launch.command).toBe("/usr/local/bin/pi with space");
    expect(launch.args).toContain('You are a "subagent" & echo PWNED');
  });

  it("ignores blank overrides", () => {
    const launch = resolvePiLaunch(
      ["--mode", "rpc"],
      { [PI_PATH_ENV]: "   " },
      () => "/pkg/bundle/cli.js",
    );
    expect(launch.args[0]).toBe("/pkg/bundle/cli.js");
  });
});

// Windows-only: verify cross-spawn delivers args verbatim through a `.cmd` shim.
describe.skipIf(process.platform !== "win32")(
  "Windows .cmd shim argument fidelity",
  () => {
    it("delivers args verbatim, including %VAR% and shell metacharacters", async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-shim-test-"));
      const outputPath = join(directory, "argv.json");
      const recorderPath = join(directory, "recorder.mjs");
      const shimPath = join(directory, "recorder.cmd");

      writeFileSync(
        recorderPath,
        'import { writeFileSync } from "node:fs";\n' +
          "writeFileSync(process.env.RECORDER_OUT, JSON.stringify(process.argv.slice(2)));\n",
      );
      // Mirrors the npm-generated .cmd shim: forwards the raw command line.
      writeFileSync(
        shimPath,
        `@echo off\r\n"${process.execPath}" "%~dp0recorder.mjs" %*\r\n`,
      );

      const args = [
        "--append-system-prompt",
        'You are a "subagent" & echo PWNED',
        "--",
        "Please explain why %PATH% is different here",
      ];
      const { command, args: launchArgs } = resolvePiLaunch(args, {
        [PI_PATH_ENV]: shimPath,
      });

      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, launchArgs, {
          env: { ...process.env, RECORDER_OUT: outputPath },
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
        );
      });

      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(args);
    });
  },
);
