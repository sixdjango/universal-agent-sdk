import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { type AgentProfileInput, AgentProfileSchema } from '@universal-agent/workflow-contract';
import type { SqliteAgentRegistry } from '@universal-agent/workflow-agents';
import {
  type AgentRuntimeInfo,
  type CanvasLayout,
  ConversationError,
  listWorkflowConversations,
  type ConversationServiceOptions,
  type WorkflowDatabase,
  WorkflowHost,
  WorkflowHostError,
} from '@universal-agent/workflow-node';
import type { WorkflowRuntime } from '@universal-agent/workflow-runtime';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { HttpError, notFound } from './errors';
import { registerConversationRoutes } from './conversations';
import { buildOpenApiDocument } from './openapi';
import {
  ChiefMessageBody,
  CreateWorkspaceBody,
  LayoutSchema,
  RerunBody,
  RespondBody,
  SaveWorkflowBody,
  StartRunBody,
  UpdateWorkspaceBody,
  WorkspaceBindingsSchema,
} from './http-schemas';
import { createSampleWorkflow, SAMPLE_AGENTS } from './samples';
import { LOOPBACK_HOSTS, registerRequestGuards } from './security';

export interface WorkflowServerOptions {
  readonly runtime: WorkflowRuntime;
  /** The workflow-node database shared by runs, artifacts, agents and the workflow library. */
  readonly db: WorkflowDatabase;
  readonly registry: SqliteAgentRegistry;
  /** Agent clients, models and effort levels offered in pickers (e.g. `AgentRuntimeCatalog`). */
  readonly runtimeCatalog?: {
    list(): Promise<readonly AgentRuntimeInfo[]>;
    refresh(agentType: string): Promise<AgentRuntimeInfo>;
  };
  /**
   * Directory registered as the default workspace; workflows without workspace slots run
   * here (default: current directory).
   */
  readonly workdir?: string;
  /** Where per-run git worktrees go (default: `<home>/workflow/worktrees`). */
  readonly worktreesDir?: string;
  /** Directory with the built web app; omit to serve the API only. */
  readonly webDir?: string;
  /** Host names accepted in the Host header (default: loopback names only). */
  readonly allowedHosts?: readonly string[] | 'any';
  /** Resume runs left RUNNING by a previous process (default true). */
  readonly resumeInterruptedRuns?: boolean;
  /** Poll interval for live run streams (default 300 ms). */
  readonly streamPollMs?: number;
  readonly logger?: FastifyServerOptions['logger'];
  /** Core chat options; SQLite is supplied by the default Node host. */
  readonly conversationOptions?: ConversationServiceOptions;
}

export interface WorkflowServer {
  readonly app: FastifyInstance;
  /** Every route the server registered, as `{ method, url }` (Fastify `:param` style). */
  readonly routes: readonly { readonly method: string; readonly url: string }[];
  /** The transport-free services this server exposes over HTTP. */
  readonly host: WorkflowHost;
}

const HOST_ERROR_STATUS = { not_found: 404, conflict: 409, invalid: 400 } as const;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'Invalid request body', { issues: result.error.issues });
  }
  return result.data;
}

/**
 * Builds the HTTP server: JSON API under `/api`, a Server-Sent Events stream of each run's
 * log, and (when `webDir` is set) the single-page canvas app with history fallback.
 */
export async function createWorkflowServer(options: WorkflowServerOptions): Promise<WorkflowServer> {
  const app = Fastify({ logger: options.logger ?? false });
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push({ method, url: route.url });
  });
  const host = await WorkflowHost.open({
    runtime: options.runtime,
    db: options.db,
    logger: app.log,
    conversationOptions: options.conversationOptions,
    ...(options.workdir ? { workdir: options.workdir } : {}),
    ...(options.worktreesDir ? { worktreesDir: options.worktreesDir } : {}),
  });
  const { library, runs, workspaces, defaultWorkspace } = host;
  const registry = options.registry;
  const streamPollMs = options.streamPollMs ?? 300;

  registerRequestGuards(app, { allowedHosts: options.allowedHosts ?? LOOPBACK_HOSTS });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    if (error instanceof WorkflowHostError) {
      return reply
        .code(HOST_ERROR_STATUS[error.code])
        .send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    if (error instanceof ConversationError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : error.code === 'storage_failed' ? 500 : 409;
      return reply.code(status).send({ error: error.message, code: error.code });
    }
    const { statusCode, message } = error as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({ error: message ?? 'Request failed' });
    }
    app.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  /** Open SSE responses, ended when the server closes so `app.close()` doesn't hang. */
  const openStreams = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const end of openStreams) end();
    await host.close();
  });

  // ---------------------------------------------------------------------------
  // Workflows
  // ---------------------------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true }));

  const openApi = buildOpenApiDocument();
  app.get('/api/openapi.json', async (request) => ({
    ...openApi,
    servers: [{ url: `${request.protocol}://${request.headers.host ?? '127.0.0.1:4317'}` }],
  }));
  registerConversationRoutes(app, host.conversations, streamPollMs);

  app.get('/api/workflows', async () => ({ workflows: library.list() }));

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (request) => {
    const record = library.get(request.params.id);
    if (!record) throw notFound(`Workflow "${request.params.id}"`);
    return record;
  });

  app.post('/api/workflows', async (request, reply) => {
    const body = parse(SaveWorkflowBody, request.body);
    const record = library.save(body.definition, { mode: 'create', ...(body.layout ? { layout: body.layout } : {}) });
    return reply.code(201).send(record);
  });

  app.put<{ Params: { id: string } }>('/api/workflows/:id', async (request) => {
    const body = parse(SaveWorkflowBody, request.body);
    const definitionId = (body.definition as { id?: unknown } | null)?.id;
    if (definitionId !== request.params.id) {
      throw new HttpError(400, `Definition id "${String(definitionId)}" does not match "${request.params.id}"`);
    }
    return library.save(body.definition, { mode: 'update', ...(body.layout ? { layout: body.layout } : {}) });
  });

  app.put<{ Params: { id: string } }>('/api/workflows/:id/workspace-bindings', async (request) => {
    library.setWorkspaceBindings(request.params.id, parse(WorkspaceBindingsSchema, request.body));
    return library.get(request.params.id);
  });

  app.put<{ Params: { id: string } }>('/api/workflows/:id/layout', async (request, reply) => {
    library.setLayout(request.params.id, parse(LayoutSchema, request.body) as CanvasLayout);
    return reply.code(204).send();
  });

  app.post('/api/samples', async () => {
    for (const agent of SAMPLE_AGENTS) registry.register(agent);
    const sample = createSampleWorkflow();
    return library.save(sample, { mode: 'upsert' });
  });

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  app.get('/api/agents', async () => {
    const agents = await Promise.all(
      registry.listAgents().map(async (a) => ({
        ...a,
        profile: await registry.resolve(`${a.agentId}@${a.latestVersion}`),
        versions: registry.listVersions(a.agentId),
      }))
    );
    return { agents };
  });

  app.post('/api/agents', async (request, reply) => {
    const parsed = AgentProfileSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid agent profile', { issues: parsed.error.issues });
    try {
      const registered = registry.register(request.body as AgentProfileInput);
      return reply.code(registered.created ? 201 : 200).send(registered);
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
  });

  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------

  app.get('/api/workspaces', async () => ({
    workspaces: await workspaces.list(),
    defaultWorkspaceId: defaultWorkspace.id,
  }));

  app.post('/api/workspaces', async (request, reply) => {
    const body = parse(CreateWorkspaceBody, request.body);
    return reply.code(201).send(await workspaces.create(body));
  });

  app.patch<{ Params: { id: string } }>('/api/workspaces/:id', async (request) =>
    workspaces.update(request.params.id, parse(UpdateWorkspaceBody, request.body))
  );

  app.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
    host.removeWorkspace(request.params.id);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Agent clients (engines), models and effort levels
  // ---------------------------------------------------------------------------

  app.get('/api/runtimes', async () => ({ runtimes: options.runtimeCatalog ? await options.runtimeCatalog.list() : [] }));

  /** Starts the client once to read its live model / effort lists (takes a few seconds). */
  app.post<{ Params: { agentType: string } }>('/api/runtimes/:agentType/refresh', async (request) => {
    if (!options.runtimeCatalog) throw notFound('Runtime catalog');
    try {
      return { runtime: await options.runtimeCatalog.refresh(request.params.agentType) };
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { workflowId?: string; limit?: string } }>('/api/runs', async (request) => ({
    runs: runs.list({
      ...(request.query.workflowId ? { workflowId: request.query.workflowId } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    }),
  }));

  app.post('/api/runs', async (request, reply) => {
    const body = parse(StartRunBody, request.body);
    const state = await host.startRun(body);
    return reply.code(202).send({ runId: state.runId });
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => ({
    run: await runs.get(request.params.id),
    active: runs.isActive(request.params.id),
    chiefAnswering: runs.isChiefAnswering(request.params.id),
    liveProgress: runs.getLiveProgress(request.params.id),
  }));

  app.get<{ Params: { id: string } }>('/api/runs/:id/conversations', async request => {
    await runs.get(request.params.id);
    const query = parse(z.object({
      scopeKey: z.string().optional(), nodeId: z.string().optional(), attemptId: z.string().optional(), invocationId: z.string().optional(),
      retryIndex: z.coerce.number().int().nonnegative().optional(), roundIndex: z.coerce.number().int().nonnegative().optional(),
      afterId: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional(),
    }), request.query);
    return { conversations: await listWorkflowConversations(host.conversations.store, { ...query, runId: request.params.id }) };
  });

  /** Talk to the run's chief; its reply streams in as a `chief.intervened` log event. */
  app.post<{ Params: { id: string } }>('/api/runs/:id/chief/messages', async (request, reply) => {
    const body = parse(ChiefMessageBody, request.body);
    return reply.code(202).send(await runs.messageChief({ runId: request.params.id, ...body }));
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/respond', async (request, reply) => {
    const body = parse(RespondBody, request.body);
    await runs.respond({ runId: request.params.id, ...body });
    return reply.code(202).send({ accepted: true });
  });

  /** Stops the run for good; steps still executing are aborted and their results dropped. */
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request) => ({
    run: await runs.cancel(request.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/runs/:id/rerun', async (request, reply) => {
    const body = parse(RerunBody, request.body);
    await runs.rerunFromNode({ runId: request.params.id, ...body });
    return reply.code(202).send({ accepted: true });
  });

  /**
   * Live run log as Server-Sent Events. Every event is one `RunLogEntry` (`id` = seq), so a
   * client folds them with `applyRunLogEntry` and reconnects with `Last-Event-ID`.
   */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/runs/:id/stream',
    async (request, reply) => {
      await runs.get(request.params.id);
      let afterSeq = Number(request.headers['last-event-id'] ?? request.query.after ?? 0) || 0;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      raw.write('retry: 2000\n\n');

      let closed = false;
      let polling = false;
      const flush = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const entries = await runs.readLog(request.params.id, afterSeq);
          for (const entry of entries) {
            raw.write(`id: ${entry.seq}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
            afterSeq = entry.seq;
          }
          raw.write(
            `event: activity\ndata: ${JSON.stringify({
              active: runs.isActive(request.params.id),
              chiefAnswering: runs.isChiefAnswering(request.params.id),
              liveProgress: runs.getLiveProgress(request.params.id),
            })}\n\n`
          );
        } catch (err) {
          app.log.error({ err }, 'run stream poll failed');
        } finally {
          polling = false;
        }
      };
      const timer = setInterval(flush, streamPollMs);
      const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), 15_000);
      const stop = () => {
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        openStreams.delete(end);
      };
      const end = () => {
        stop();
        raw.end();
      };
      openStreams.add(end);
      request.raw.on('close', stop);
      await flush();
    }
  );

  /** Problems still open: what reviews left and the issues steps logged, most severe first. */
  app.get<{ Params: { id: string } }>('/api/runs/:id/findings', async (request) => {
    await runs.get(request.params.id);
    return { findings: await options.runtime.getOpenFindings(request.params.id) };
  });

  /** Intermediate data steps saved (`ua-workflow data …` / the `data_*` MCP tools), oldest first. */
  app.get<{
    Params: { id: string };
    Querystring: { nodeId?: string; scopeKey?: string; namespace?: string; collection?: string; afterId?: string; limit?: string };
  }>('/api/runs/:id/data', async (request) => {
    await runs.get(request.params.id);
    const q = request.query;
    if (q.namespace !== undefined && q.namespace !== 'node' && q.namespace !== 'run') {
      throw new HttpError(400, 'namespace must be "node" or "run"');
    }
    const records = await options.runtime.nodeData.query({
      runId: request.params.id,
      ...(q.namespace ? { namespace: q.namespace } : {}),
      ...(q.nodeId ? { nodeId: q.nodeId } : {}),
      ...(q.scopeKey ? { scopeKey: q.scopeKey } : {}),
      ...(q.collection ? { collection: q.collection } : {}),
      ...(q.afterId ? { afterId: Number(q.afterId) || 0 } : {}),
      limit: Math.min(Number(q.limit ?? 500) || 500, 2000),
    });
    return { records };
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: string; max?: string } }>(
    '/api/artifacts/:id',
    async (request) => {
      const meta = await options.runtime.artifacts.getMeta(request.params.id);
      if (!meta) throw notFound(`Artifact "${request.params.id}"`);
      const slice = await options.runtime.artifacts.readSlice(request.params.id, {
        offsetBytes: Number(request.query.offset ?? 0) || 0,
        maxBytes: Math.min(Number(request.query.max ?? 64 * 1024) || 64 * 1024, 1024 * 1024),
      });
      return { meta, slice };
    }
  );

  // ---------------------------------------------------------------------------
  // Web app
  // ---------------------------------------------------------------------------

  if (options.webDir && existsSync(join(options.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: options.webDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  if (options.resumeInterruptedRuns !== false) {
    app.addHook('onReady', async () => {
      const resumed = runs.resumeInterrupted();
      if (resumed.length > 0) app.log.info({ resumed }, 'resuming interrupted workflow runs');
    });
  }

  return { app, host, routes };
}
