import { readFile } from "node:fs/promises";
import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  TextContentSchema,
  ImageContentSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const outputSchema = z.toJSONSchema(
  CallToolResultSchema.extend({
    content: z.array(z.union([TextContentSchema, ImageContentSchema])),
  }).pick({ content: true, structuredContent: true, isError: true }),
) as ToolDefinition["outputSchema"];

export const MCP_CONFIG_ENV = "LODY_PI_MCP_CONFIG";
type StdioServer = Extract<McpServer, { command: string }>;

/** Loaded in Pi: native tools own calls and cancellation; the SDK owns transport. */
export async function registerMcpTools(pi: ExtensionAPI): Promise<void> {
  const configPath = process.env[MCP_CONFIG_ENV];
  if (!configPath) throw new Error("Missing Lody Pi runtime configuration");
  const servers = JSON.parse(
    await readFile(configPath, "utf8"),
  ) as StdioServer[];
  const clients: Client[] = [];
  const tools = new Set<string>();
  const close = async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  };
  pi.on("session_shutdown", close);
  pi.on("session_start", () => {
    // Native resume restores the transcript's declared loadout after registering
    // extensions. This activation's selected MCP tools may not exist in that
    // transcript. Add their direct declarations through the native API, keeping
    // every non-MCP selection and native filtering/codemode projection intact.
    // Old request tools are absent from the newly loaded extension registry.
    const selected = pi
      .getAllTools()
      .filter(
        (tool) =>
          tools.has(tool.name) &&
          (tool.exposure === undefined ||
            tool.exposure === "direct" ||
            tool.exposure === "model-only"),
      )
      .map((tool) => tool.name);
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...selected])]);
  });
  // Pi's tool result hook preserves the MCP error flag.
  pi.on("tool_result", (event) => {
    if (
      tools.has(event.toolName) &&
      event.details &&
      typeof event.details === "object" &&
      "isError" in event.details &&
      event.details.isError === true
    )
      return { isError: true };
  });
  try {
    for (const server of servers) {
      const client = new Client({ name: "lody-pi", version: "0.1.0" });
      clients.push(client);
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: Object.fromEntries(
          server.env.map(({ name, value }) => [name, value]),
        ),
        cwd: process.cwd(),
        stderr: "ignore",
      });
      await client.connect(transport, { timeout: 30_000 });
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        for (const tool of page.tools) {
          const name = `mcp_${server.name}_${tool.name}`.replace(
            /[^a-zA-Z0-9_-]/g,
            "_",
          );
          if (name.length > 64 || tools.has(name))
            throw new Error(
              "MCP tool names must be unique and at most 64 characters",
            );
          tools.add(name);
          pi.registerTool({
            name,
            label: `${server.name}: ${tool.name}`,
            description: tool.description ?? tool.name,
            parameters: tool.inputSchema as ToolDefinition["parameters"],
            outputSchema,
            async execute(_id, args, signal) {
              // The SDK validates this schema but types the result as a compatibility union.
              const result = (await client.callTool(
                {
                  name: tool.name,
                  arguments: args as Record<string, unknown>,
                },
                CallToolResultSchema,
                { signal },
              )) as CallToolResult;
              const content = result.content.map((block) => {
                if (block.type !== "text" && block.type !== "image")
                  throw new Error(
                    `Unsupported MCP content type: ${block.type}. Pi V1 supports text and images only.`,
                  );
                return block;
              });
              if (result.structuredContent)
                content.push({
                  type: "text",
                  text: JSON.stringify(result.structuredContent),
                });
              return {
                content,
                details: { isError: result.isError === true },
                // Codemode receives structuredContent for tools with an output
                // schema; keep the MCP blocks so scripts can call image().
                structuredContent: z.json().parse({
                  content: result.content,
                  ...(result.structuredContent
                    ? { structuredContent: result.structuredContent }
                    : {}),
                  isError: result.isError === true,
                }),
              };
            },
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
  } catch {
    await close();
    // Configuration can contain credentials; don't put SDK/command errors in history.
    throw new Error(
      "MCP initialization failed; check server configuration and tool names",
    );
  }
}
