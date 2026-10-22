import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CONFIG_ENV, registerMcpTools } from "../src/mcp.js";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn();
    close = vi.fn();
    listTools = async () => ({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    });
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));
const originalConfig = process.env[MCP_CONFIG_ENV];
let directory: string | undefined;
afterEach(() => {
  if (originalConfig === undefined) delete process.env[MCP_CONFIG_ENV];
  else process.env[MCP_CONFIG_ENV] = originalConfig;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function activation(
  servers: string[],
  active: string[],
  exposure = "direct",
) {
  directory ??= mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
  const config = join(directory, "servers.json");
  writeFileSync(
    config,
    JSON.stringify(
      servers.map((name) => ({
        name,
        command: "synthetic",
        args: [],
        env: [],
      })),
    ),
  );
  process.env[MCP_CONFIG_ENV] = config;
  const tools: any[] = [];
  const handlers = new Map<string, Function>();
  const setActiveTools = vi.fn();
  await registerMcpTools({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.push({ ...tool, exposure }),
    getActiveTools: () => active,
    getAllTools: () => tools,
    setActiveTools,
  } as unknown as ExtensionAPI);
  handlers.get("session_start")!();
  return setActiveTools;
}

describe("ACP MCP activation loadout", () => {
  it("adds current MCP selection absent from restored history while preserving native user tool choices", async () => {
    const update = await activation(
      ["target"],
      ["read", "user_extension_tool"],
    );
    expect(update).toHaveBeenCalledWith([
      "read",
      "user_extension_tool",
      "mcp_target_read",
    ]);
  });
  it("keeps codemode active and delegates declaration projection to native setActiveTools", async () => {
    const update = await activation(["target"], ["codemode", "read"]);
    expect(update).toHaveBeenCalledWith([
      "codemode",
      "read",
      "mcp_target_read",
    ]);
  });
  it.each(["hidden", "codemode", "deferred"])(
    "does not activate %s tools to bypass their native exposure",
    async (exposure) => {
      const update = await activation(["target"], ["codemode"], exposure);
      expect(update).toHaveBeenCalledWith(["codemode"]);
    },
  );
  it("does not add any tools for an empty selection", async () => {
    const update = await activation([], ["bash"]);
    expect(update).toHaveBeenCalledWith(["bash"]);
  });
});
