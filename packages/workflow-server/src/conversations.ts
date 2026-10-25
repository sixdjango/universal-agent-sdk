import type { ConversationAgent, ConversationService, SendConversationInput } from '@universal-agent/workflow-node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors';

const Json = z.json();
const Extensions = z.record(z.string(), Json);
const Agent = z.object({
  workdir: z.string().min(1),
  agentType: z.string().min(1).optional(),
  target: z.union([
    z.object({ cliType: z.literal('custom'), agentType: z.string(), command: z.string().min(1), args: z.array(z.string()).optional() }),
    z.object({ cliType: z.enum(['builtin', 'registry']), agentType: z.string().min(1), executablePath: z.string().optional(), extraArgs: z.array(z.string()).optional(), piExtensions: z.array(z.string()).optional(), providerId: z.string().optional() }),
  ]).optional(),
  customCommand: z.object({ command: z.string().min(1), args: z.array(z.string()).optional() }).optional(),
  initialConfig: z.object({ modelId: z.string().optional(), modeId: z.string().optional(), configOptionValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional() }).optional(),
  modelId: z.string().optional(), modeId: z.string().optional(),
  configOptionValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  providerId: z.string().optional(), extraArgs: z.array(z.string()).optional(), piExtensions: z.array(z.string()).optional(),
  mcpServers: z.array(Json).optional(),
}).strict();
const Create = z.object({ id: z.string().min(1).optional(), title: z.string().optional(), agent: Agent, extensions: Extensions.optional() }).strict();
// The SDK validates ACP ContentBlock itself; the HTTP layer only checks the request envelope.
const Send = z.object({
  content: z.array(Json).min(1), idempotencyKey: z.string().min(1).optional(), extensions: Extensions.optional(),
  promptOptions: z.object({
    _meta: Extensions.nullable().optional(),
    goalControl: z.object({ action: z.enum(['set', 'pause', 'resume', 'clear']), objective: z.string().optional() }).optional(),
  }).optional(),
}).strict();
const Page = z.object({ after: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });
const PermissionResponse = z.object({
  outcome: z.union([z.object({ outcome: z.literal('cancelled') }).passthrough(), z.object({ outcome: z.literal('selected'), optionId: z.string().min(1) }).passthrough()]),
  _meta: Extensions.nullable().optional(),
}).passthrough();

const Update = z.object({ title: z.string().optional(), extensions: Extensions.optional() }).strict();
const CustomEvent = z.object({ namespace: z.string().min(1), name: z.string().min(1), data: Json, turnId: z.string().optional() }).strict();

/** Request bodies of the conversation routes (and the JSON value they share), for the OpenAPI document. */
export const ConversationRequestSchemas = { Create, Update, Send, CustomEvent, PermissionResponse, Json } as const;
export const CONVERSATION_ACTIONS = ['connect', 'pause', 'resume', 'recover', 'disconnect', 'close'] as const;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'Invalid conversation request', { issues: result.error.issues });
  return result.data;
}

/** Transport only. Queueing, ownership, permissions and recovery live in the client SDK. */
export function registerConversationRoutes(app: FastifyInstance, service: ConversationService, pollMs: number): void {
  app.get('/api/conversations', async request => ({ conversations: await service.store.list(parse(z.object({ afterId: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }), request.query)) }));
  app.post('/api/conversations', async (request, reply) => {
    const input = parse(Create, request.body);
    return reply.code(201).send(await service.create({ ...input, agent: input.agent as ConversationAgent }));
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id', request => service.get(request.params.id));
  app.patch<{ Params: { id: string } }>('/api/conversations/:id', request => service.update(request.params.id,
    parse(Update, request.body)));
  app.post<{ Params: { id: string } }>('/api/conversations/:id/turns', async (request, reply) =>
    reply.code(202).send(await service.send(request.params.id, parse(Send, request.body) as SendConversationInput)));
  app.get<{ Params: { id: string } }>('/api/conversations/:id/turns', async request => {
    await service.get(request.params.id);
    return service.store.listTurns(request.params.id, parse(Page, request.query));
  });
  app.get<{ Params: { id: string; turnId: string } }>('/api/conversations/:id/turns/:turnId', async request => {
    const messages = await service.getMessages(request.params.id, request.params.turnId);
    return { turn: await service.store.getTurn(request.params.id, request.params.turnId), messages };
  });
  app.post<{ Params: { id: string; turnId: string } }>('/api/conversations/:id/turns/:turnId/cancel', request => service.cancel(request.params.id, request.params.turnId));
  app.get<{ Params: { id: string } }>('/api/conversations/:id/events', async request => {
    await service.get(request.params.id);
    return service.store.readEvents(request.params.id, parse(Page.extend({ turnId: z.string().optional() }), request.query));
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/events', async (request, reply) => {
    const event = parse(CustomEvent, request.body);
    const { turnId, ...data } = event;
    await service.appendCustomEvent(request.params.id, data, turnId);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/permissions', async request => {
    const conversation = await service.get(request.params.id);
    const turn = conversation.activeTurnId ? await service.store.getTurn(conversation.id, conversation.activeTurnId) : undefined;
    return { permissions: turn?.permissions.filter(permission => permission.status === 'pending') ?? [] };
  });
  app.post<{ Params: { id: string; permissionId: string } }>('/api/conversations/:id/permissions/:permissionId/respond', async (request, reply) => {
    await service.respondPermission(request.params.id, request.params.permissionId, parse(PermissionResponse, request.body));
    return reply.code(204).send();
  });
  for (const action of CONVERSATION_ACTIONS) {
    app.post<{ Params: { id: string } }>(`/api/conversations/:id/${action}`, async request => {
      await service[action](request.params.id);
      return service.get(request.params.id);
    });
  }

  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of streams) close(); });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/stream', async (request, reply) => {
    await service.get(request.params.id);
    const query = parse(Page, request.query);
    let after = parse(z.coerce.number().int().nonnegative(), request.headers['last-event-id'] ?? query.after ?? 0);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    raw.write('retry: 2000\n\n');
    let closed = false;
    let polling = false;
    let blocked = false;
    raw.on('drain', () => { blocked = false; });
    const flush = async () => {
      if (closed || polling || blocked) return;
      polling = true;
      try {
        const page = await service.store.readEvents(request.params.id, { after, limit: 100 });
        for (const event of page.items) {
          if (closed) break;
          blocked = !raw.write(`id: ${event.sequence}\nevent: conversation\ndata: ${JSON.stringify(event)}\n\n`);
          after = event.sequence;
          if (blocked) break;
        }
      } catch (error) { app.log.error(error, 'conversation stream failed'); close(); }
      finally { polling = false; }
    };
    const timer = setInterval(() => { void flush(); }, pollMs);
    const heartbeat = setInterval(() => { if (!blocked && !closed) blocked = !raw.write(': keep-alive\n\n'); }, 15_000);
    const close = () => {
      if (closed) return;
      closed = true; clearInterval(timer); clearInterval(heartbeat); streams.delete(close); raw.end();
    };
    streams.add(close);
    raw.on('close', close);
    await flush();
  });
}
