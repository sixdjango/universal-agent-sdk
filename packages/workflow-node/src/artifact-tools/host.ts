import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  ARTIFACT_MCP_SERVER_NAME,
  ARTIFACT_TOOLS,
  type ArtifactToolName,
  type ArtifactToolResult,
  runArtifactTool,
  type WorkflowToolContext,
} from './tools';

/** What ACP's `session/new` accepts in `mcpServers` (HTTP or stdio form). */
export type ArtifactMcpServer =
  | { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] };

type Registration = WorkflowToolContext;

/** Env var that tells the stdio bridge where to forward tool calls. */
export const ARTIFACT_RPC_URL_ENV = 'UA_WORKFLOW_ARTIFACT_RPC';
/** Env var that tells the `ua-workflow` CLI where this step's tools are. */
export const WORKFLOW_RPC_URL_ENV = 'UA_WORKFLOW_RPC';

/** The built CLI, found like the bridge. */
function resolveCliScript(): string | null {
  for (const candidate of ['./workflow-cli.js', '../../dist/workflow-cli.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

/** A directory with `ua-workflow` launchers (POSIX shell and Windows) for the built CLI. */
let shimDir: string | null | undefined;
function cliShimDir(): string | null {
  if (shimDir !== undefined) return shimDir;
  const cli = resolveCliScript();
  if (!cli) return (shimDir = null);
  const dir = mkdtempSync(join(tmpdir(), 'ua-workflow-cli-'));
  writeFileSync(join(dir, 'ua-workflow'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'ua-workflow.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);
  return (shimDir = dir);
}

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

  /** Exposes a step's tools (its artifacts and/or its data) until `release` is called. */
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

  /** Where the CLI (and anything else speaking `{ name, arguments }`) calls this step's tools. */
  async rpcUrl(token: string): Promise<string> {
    return `${await this.start()}/rpc/${token}`;
  }

  /**
   * Environment for a process (a script, or an agent's shell) to use this step's tools: the
   * RPC URL and `ua-workflow` on its PATH. Merge it over the process's own environment.
   */
  async cliEnv(token: string, basePath = process.env.PATH ?? ''): Promise<Record<string, string>> {
    const url = await this.rpcUrl(token);
    const dir = cliShimDir();
    const cli = resolveCliScript();
    return {
      [WORKFLOW_RPC_URL_ENV]: url,
      ...(cli ? { UA_WORKFLOW_CLI: cli } : {}),
      ...(dir ? { PATH: basePath ? `${dir}${delimiter}${basePath}` : dir } : {}),
    };
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

/** An MCP server exposing the step tools (artifacts and data), executing them through `call`. */
export function createArtifactMcpServer(call: (name: string, args: unknown) => Promise<ArtifactToolResult>): McpServer {
  const server = new McpServer({ name: ARTIFACT_MCP_SERVER_NAME, version: '1.0.0' });
  for (const name of Object.keys(ARTIFACT_TOOLS) as ArtifactToolName[]) {
    const tool = ARTIFACT_TOOLS[name];
    const shape = tool.inputSchema as z.ZodRawShape;
    server.registerTool(name, { description: tool.description, inputSchema: shape }, (args: unknown) => call(name, args ?? {}));
  }
  return server;
}
