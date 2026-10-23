import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ContextManifest } from '@universal-agent/workflow-contract';
import type { ScopedArtifactReader } from '@universal-agent/workflow-runtime';
import { ARTIFACT_MCP_SERVER_NAME, ARTIFACT_TOOLS, type ArtifactToolResult, runArtifactTool } from './tools';

/** What ACP's `session/new` accepts in `mcpServers` (HTTP or stdio form). */
export type ArtifactMcpServer =
  | { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] };

interface Registration {
  readonly manifest: ContextManifest;
  readonly reader: ScopedArtifactReader;
}

/** Env var that tells the stdio bridge where to forward tool calls. */
export const ARTIFACT_RPC_URL_ENV = 'UA_WORKFLOW_ARTIFACT_RPC';

/**
 * The built stdio bridge: next to the bundle (`dist/index.js`), or the package's `dist/` when
 * running from source (plain node cannot run the TypeScript source).
 */
function resolveBridgeScript(): string | null {
  for (const candidate of ['./mcp-bridge.js', '../../dist/mcp-bridge.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Serves workflow artifacts to agents as MCP tools while their attempts run. One loopback
 * HTTP server per host; each attempt gets an unguessable token that scopes the tools to
 * that attempt's manifest and reader, and stops working when the attempt ends.
 *
 * - `POST /mcp/<token>`: MCP over streamable HTTP, for agents that support HTTP MCP servers.
 * - `POST /rpc/<token>`: `{ name, arguments }` -> tool result, used by the stdio bridge that
 *   agents without HTTP MCP support launch instead.
 */
export class ArtifactToolHost {
  private readonly registrations = new Map<string, Registration>();
  private server: Server | null = null;
  private baseUrl: Promise<string> | null = null;

  /** Exposes `manifest`'s artifacts until the returned `release` is called. */
  register(registration: Registration): { token: string; release(): void } {
    const token = randomBytes(24).toString('base64url');
    this.registrations.set(token, registration);
    return { token, release: () => void this.registrations.delete(token) };
  }

  /** MCP server entries for `session/new`: HTTP when the agent supports it, else the stdio bridge. */
  async mcpServers(token: string, capabilities: { http: boolean }): Promise<ArtifactMcpServer[]> {
    const base = await this.start();
    if (capabilities.http) {
      return [{ type: 'http', name: ARTIFACT_MCP_SERVER_NAME, url: `${base}/mcp/${token}`, headers: [] }];
    }
    const bridge = resolveBridgeScript();
    if (!bridge) return [];
    return [
      {
        name: ARTIFACT_MCP_SERVER_NAME,
        command: process.execPath,
        args: [bridge],
        env: [{ name: ARTIFACT_RPC_URL_ENV, value: `${base}/rpc/${token}` }],
      },
    ];
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    this.registrations.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private start(): Promise<string> {
    this.baseUrl ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err: unknown) => {
          if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      });
      // Never keeps the host process alive on its own.
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
    return this.baseUrl;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/(mcp|rpc)\/([\w-]+)$/.exec(req.url ?? '');
    const registration = match ? this.registrations.get(match[2]!) : undefined;
    if (!match || !registration) return sendJson(res, 404, { error: 'Unknown or expired workflow tool session' });

    if (match[1] === 'rpc') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      const body = (await readBody(req)) as { name?: string; arguments?: unknown } | undefined;
      const result: ArtifactToolResult = await runArtifactTool(registration, body?.name ?? '', body?.arguments);
      return sendJson(res, 200, result);
    }

    // Stateless streamable HTTP: a fresh server + transport per request.
    const mcp = createArtifactMcpServer((name, args) => runArtifactTool(registration, name, args));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
  }
}

/** An MCP server exposing the artifact tools, executing them through `call`. */
export function createArtifactMcpServer(call: (name: string, args: unknown) => Promise<ArtifactToolResult>): McpServer {
  const server = new McpServer({ name: ARTIFACT_MCP_SERVER_NAME, version: '1.0.0' });
  server.registerTool(
    'list_context_inputs',
    { description: ARTIFACT_TOOLS.list_context_inputs.description, inputSchema: ARTIFACT_TOOLS.list_context_inputs.inputSchema },
    () => call('list_context_inputs', {})
  );
  server.registerTool(
    'read_artifact',
    { description: ARTIFACT_TOOLS.read_artifact.description, inputSchema: ARTIFACT_TOOLS.read_artifact.inputSchema },
    (args) => call('read_artifact', args)
  );
  return server;
}
