import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childContext from "../src/child-context.js";
import { WORKSPACE_CONFIG_ENV } from "../src/workspace.js";

it("adds a child workspace snapshot while preserving native user prompt and registering no tools", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-child-context-"));
  const file = join(directory, "workspace.json");
  const workspace = {
    cwd: directory,
    additionalDirectories: [join(directory, "A")],
  };
  const on = vi.fn();
  const registerTool = vi.fn();
  const previous = process.env[WORKSPACE_CONFIG_ENV];
  try {
    writeFileSync(file, JSON.stringify(workspace));
    process.env[WORKSPACE_CONFIG_ENV] = file;
    childContext({ on, registerTool } as unknown as ExtensionAPI);
    writeFileSync(
      file,
      JSON.stringify({ cwd: directory, additionalDirectories: [] }),
    );
    const [event, handler] = on.mock.calls[0];
    expect(event).toBe("before_agent_start");
    const result = handler({ systemPrompt: "native user configuration" });
    expect(result.systemPrompt).toContain("native user configuration");
    expect(result.systemPrompt).toContain(JSON.stringify(workspace));
    expect(result.systemPrompt).toContain("do not ask the user");
    expect(registerTool).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env[WORKSPACE_CONFIG_ENV];
    else process.env[WORKSPACE_CONFIG_ENV] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
