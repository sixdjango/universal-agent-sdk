/**
 * Stdio MCP server for agents that cannot connect to HTTP MCP servers. The workflow host
 * launches it per attempt with `UA_WORKFLOW_ARTIFACT_RPC` pointing at that attempt's tool
 * endpoint; every tool call is forwarded there, so scoping, quotas and read receipts stay
 * in the host process.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ARTIFACT_RPC_URL_ENV, createArtifactMcpServer } from './artifact-tools/host';
import type { ArtifactToolResult } from './artifact-tools/tools';

const rpcUrl = process.env[ARTIFACT_RPC_URL_ENV];
if (!rpcUrl) {
  process.stderr.write(`${ARTIFACT_RPC_URL_ENV} is not set; this bridge is started by the workflow host.\n`);
  process.exit(1);
}

const server = createArtifactMcpServer(async (name, args): Promise<ArtifactToolResult> => {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    if (!response.ok) {
      return { content: [{ type: 'text', text: `Workflow host refused the call (${response.status}): ${await response.text()}` }], isError: true };
    }
    return (await response.json()) as ArtifactToolResult;
  } catch (err) {
    return { content: [{ type: 'text', text: `Workflow host unreachable: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
