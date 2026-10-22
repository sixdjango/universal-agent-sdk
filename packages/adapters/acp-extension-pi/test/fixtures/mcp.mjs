import { writeFileSync, appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "fixture", version: "1" },
  { capabilities: { tools: {} } },
);
appendFileSync("mcp-pids", `${process.pid}\n`);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Synthetic echo",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
    {
      name: "wait",
      description: "Wait for cancellation",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "error",
      description: "Fail with content",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "image",
      description: "Return an image",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === "wait") {
    writeFileSync("mcp-started", "yes");
    await new Promise((resolve) => {
      const cancel = () => {
        writeFileSync("mcp-cancelled", "yes");
        resolve();
      };
      if (extra.signal.aborted) cancel();
      else extra.signal.addEventListener("abort", cancel, { once: true });
    });
  }
  const content =
    request.params.name === "image"
      ? [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGP4z8DwHwohFABFzAf5Zsv/OQAAAABJRU5ErkJggg==",
          },
        ]
      : [
          {
            type: "text",
            text: `MCP:${process.env.MCP_FIXTURE_TAG}:${request.params.arguments?.value ?? request.params.name}`,
          },
        ];
  if (request.params.arguments?.value === "unsupported-resource")
    content.push({
      type: "resource_link",
      uri: "file:///synthetic.txt",
      name: "synthetic",
    });
  return {
    content,
    isError: request.params.name === "error",
    structuredContent: {
      tag: process.env.MCP_FIXTURE_TAG,
      secretReceived: !!process.env.MCP_FIXTURE_SECRET,
    },
  };
});
await server.connect(new StdioServerTransport());
