import { AgentProfileSchema, EdgeConditionSchema, WorkflowDefinitionSchema, WorkflowGraphSchema, WorkflowNodeSchema } from '@universal-agent/workflow-contract';
import { z } from 'zod';
import { CONVERSATION_ACTIONS, ConversationRequestSchemas } from './conversations';
import {
  ChiefMessageBody,
  CreateWorkspaceBody,
  LayoutSchema,
  ForkRunBody,
  RerunBody,
  RespondBody,
  SaveWorkflowBody,
  StartRunBody,
  UpdateWorkspaceBody,
  WorkspaceBindingsSchema,
} from './http-schemas';

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/**
 * Schemas generated from the zod schemas the server validates with (and the contract's
 * definition schema), so the document follows the code. Recursive parts (graphs inside
 * container steps) get their own components, which every reference points at.
 */
function generatedSchemas(): Record<string, Schema> {
  const registry = z.registry<{ id: string }>();
  const named: Record<string, z.ZodType> = {
    WorkflowDefinition: WorkflowDefinitionSchema,
    WorkflowGraph: WorkflowGraphSchema,
    WorkflowNode: WorkflowNodeSchema,
    EdgeCondition: EdgeConditionSchema,
    AgentProfile: AgentProfileSchema,
    SaveWorkflowBody,
    CanvasLayout: LayoutSchema,
    WorkspaceBindings: WorkspaceBindingsSchema,
    StartRunBody,
    CreateWorkspaceBody,
    UpdateWorkspaceBody,
    RespondBody,
    RerunBody,
    ForkRunBody,
    ChiefMessageBody,
    CreateConversationBody: ConversationRequestSchemas.Create,
    UpdateConversationBody: ConversationRequestSchemas.Update,
    SendTurnBody: ConversationRequestSchemas.Send,
    CustomEventBody: ConversationRequestSchemas.CustomEvent,
    PermissionResponseBody: ConversationRequestSchemas.PermissionResponse,
    JsonValue: ConversationRequestSchemas.Json,
  };
  for (const [id, schema] of Object.entries(named)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    io: 'input',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Schema> };
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.id;
  }
  return schemas;
}

/** Responses, described by their main fields (the full shapes are in the TypeScript SDK). */
const RESPONSE_SCHEMAS: Record<string, Schema> = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'string' }, details: {}, code: { type: 'string' } },
  },
  WorkflowSummary: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, digest: { type: 'string' }, updatedAtMs: { type: 'integer' } },
  },
  WorkflowRecord: {
    type: 'object',
    description: 'A saved workflow: its latest definition, canvas layout and remembered workspace bindings.',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      digest: { type: 'string' },
      definition: ref('WorkflowDefinition'),
      layout: ref('CanvasLayout'),
      workspaceBindings: ref('WorkspaceBindings'),
      createdAtMs: { type: 'integer' },
      updatedAtMs: { type: 'integer' },
    },
  },
  RunSummary: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      workflowId: { type: 'string' },
      workflowName: { type: 'string' },
      status: ref('RunStatus'),
      revision: { type: 'integer' },
      createdAtMs: { type: 'integer' },
      updatedAtMs: { type: 'integer' },
    },
  },
  RunStatus: { type: 'string', enum: ['RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] },
  RunState: {
    type: 'object',
    description:
      'A run folded from its log: status, outputs, every scope (loop rounds and parallel items included) with its node states, attempts, assessments, context manifests, open waits, chief state and events.',
    properties: {
      runId: { type: 'string' },
      status: ref('RunStatus'),
      revision: { type: 'integer', description: 'Sequence number of the last log entry folded in.' },
      definition: ref('WorkflowDefinition'),
      inputs: { type: 'object' },
      outputs: { type: 'object' },
      workspaces: { type: 'object', description: 'Workspace binding per slot.' },
      scopes: { type: 'object', description: 'Scope state by scope key, e.g. `$root`, `$root/fix__loop:round_1`, `$root/pages[2]`.' },
      attempts: { type: 'object', description: 'Node attempts by attempt id (produced artifacts, assessment, workspace changes, error).' },
      assessments: { type: 'object', description: 'Verdicts (PASS, NEEDS_FIX, FAIL, BLOCKED) with findings, by assessment id.' },
      manifests: { type: 'object', description: 'What each agent attempt was given, by manifest id.' },
      waitRequests: { type: 'object', description: 'Gate decisions and agent questions, by request id.' },
      chief: { type: 'object' },
      events: { type: 'array', items: { type: 'object' } },
    },
  },
  RunView: {
    type: 'object',
    properties: {
      run: ref('RunState'),
      active: { type: 'boolean', description: 'This server is executing the run right now.' },
      chiefAnswering: { type: 'boolean' },
      liveProgress: { type: 'array', items: { type: 'object' }, description: 'Steps of attempts still executing.' },
    },
  },
  Workspace: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      path: { type: 'string' },
      isolation: { type: 'string', enum: ['in-place', 'git-worktree'] },
      git: { type: 'boolean' },
      exists: { type: 'boolean' },
    },
  },
  NodeDataRecord: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      namespace: { type: 'string', enum: ['node', 'run'] },
      scopeKey: { type: 'string' },
      nodeId: { type: 'string' },
      attemptId: { type: 'string' },
      collection: { type: 'string' },
      key: { type: 'string' },
      value: {},
    },
  },
  Artifact: {
    type: 'object',
    properties: {
      meta: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          sha256: { type: 'string' },
          mediaType: { type: 'string' },
          sizeBytes: { type: 'integer' },
          producerRunId: { type: 'string' },
          producerNodeId: { type: 'string' },
          producerAttemptId: { type: 'string' },
          portName: { type: 'string' },
        },
      },
      slice: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          content: { type: 'string' },
          offsetBytes: { type: 'integer' },
          readBytes: { type: 'integer' },
          totalBytes: { type: 'integer' },
          hasMore: { type: 'boolean', description: 'Read on from offsetBytes + readBytes.' },
        },
      },
    },
  },
  Conversation: { type: 'object', description: 'A recorded agent conversation (ACP session) and its state.' },
  OpenFinding: {
    type: 'object',
    required: ['source', 'scopeKey', 'nodeId', 'severity', 'message', 'recordedAtMs'],
    properties: {
      source: { type: 'string', enum: ['assessment', 'issue'], description: 'Left by a review, or logged by a step.' },
      scopeKey: { type: 'string' },
      nodeId: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] },
      message: { type: 'string' },
      filePath: { type: 'string' },
      line: { type: 'integer' },
      verdict: { type: 'string', enum: ['PASS', 'NEEDS_FIX', 'FAIL', 'BLOCKED'] },
      assessmentId: { type: 'string' },
      attemptId: { type: 'string' },
      details: { type: 'object', description: 'Other fields the step logged with the issue.' },
      recordedAtMs: { type: 'integer' },
    },
  },
};

interface Operation {
  /** `operationId`: the method name generated clients get. */
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly tag: string;
  readonly query?: Record<string, Schema & { description?: string }>;
  readonly body?: string;
  /** Status → response schema (a component name), `null` for no body, or `sse` for a stream. */
  readonly responses: Record<number, string | null | 'sse'>;
}

const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
const list = (key: string, item: string) => ({ type: 'object', properties: { [key]: { type: 'array', items: ref(item) } } });

function operation(path: string, op: Operation): Schema {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
  const queryParams = Object.entries(op.query ?? {}).map(([name, { description, ...schema }]) => ({
    name,
    in: 'query',
    required: false,
    schema,
    ...(description ? { description } : {}),
  }));
  const responses: Record<string, Schema> = {};
  for (const [status, body] of Object.entries(op.responses)) {
    const description = Number(status) >= 400 ? 'Error' : body === 'sse' ? 'Server-Sent Events stream' : 'OK';
    responses[status] =
      body === null
        ? { description }
        : body === 'sse'
          ? { description, content: { 'text/event-stream': { schema: { type: 'string' } } } }
          : { description, ...json(body.startsWith('{') ? (JSON.parse(body) as Schema) : ref(body)) };
  }
  if (!Object.keys(responses).some((status) => status.startsWith('4'))) responses['4XX'] = { description: 'Error', ...json(ref('Error')) };
  responses.default = { description: 'Error', ...json(ref('Error')) };
  return {
    operationId: op.id,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    tags: [op.tag],
    ...(pathParams.length || queryParams.length ? { parameters: [...pathParams, ...queryParams] } : {}),
    ...(op.body ? { requestBody: { required: true, ...json(ref(op.body)) } } : {}),
    responses,
  };
}

const inline = (schema: Schema) => JSON.stringify(schema);
const int = { type: 'integer' };
const str = { type: 'string' };

/** Every route, as `METHOD /path` (OpenAPI `{param}` style) → operation. */
function operations(): Record<string, Operation> {
  const conversationActions = Object.fromEntries(
    CONVERSATION_ACTIONS.map((action) => [
      `post /api/conversations/{id}/${action}`,
      { id: `${action}Conversation`, summary: `${action[0]!.toUpperCase()}${action.slice(1)} the conversation's agent session`, tag: 'Conversations', responses: { 200: 'Conversation' } },
    ])
  );
  return {
    'get /api/health': { id: 'getHealth', summary: 'Health check', tag: 'Server', responses: { 200: inline({ type: 'object', properties: { ok: { type: 'boolean' } } }) } },
    'get /api/openapi.json': { id: 'getOpenApiDocument', summary: 'This document', tag: 'Server', responses: { 200: inline({ type: 'object' }) } },

    'get /api/workflows': { id: 'listWorkflows', summary: 'List saved workflows', tag: 'Workflows', responses: { 200: inline(list('workflows', 'WorkflowSummary')) } },
    'post /api/workflows': { id: 'createWorkflow', summary: 'Save a new workflow', tag: 'Workflows', body: 'SaveWorkflowBody', responses: { 201: 'WorkflowRecord', 400: 'Error', 409: 'Error' } },
    'get /api/workflows/{id}': { id: 'getWorkflow', summary: 'Get a saved workflow', tag: 'Workflows', responses: { 200: 'WorkflowRecord', 404: 'Error' } },
    'put /api/workflows/{id}': {
      id: 'saveWorkflow',
      summary: 'Save a new version of a workflow',
      description: 'The definition id must match the path. The body is validated as a WorkflowDefinition.',
      tag: 'Workflows',
      body: 'SaveWorkflowBody',
      responses: { 200: 'WorkflowRecord', 400: 'Error', 404: 'Error' },
    },
    'put /api/workflows/{id}/workspace-bindings': {
      id: 'setWorkspaceBindings',
      summary: 'Remember the workspace each slot runs in',
      description: 'Workspace id per slot, used when a run names none.',
      tag: 'Workflows',
      body: 'WorkspaceBindings',
      responses: { 200: 'WorkflowRecord' },
    },
    'put /api/workflows/{id}/layout': { id: 'saveLayout', summary: 'Save the canvas layout', tag: 'Workflows', body: 'CanvasLayout', responses: { 204: null } },
    'post /api/samples': { id: 'installSamples', summary: 'Install the sample agents and workflow', tag: 'Workflows', responses: { 200: 'WorkflowRecord' } },

    'get /api/agents': { id: 'listAgents', summary: 'List registered agents with their versions', tag: 'Agents', responses: { 200: inline({ type: 'object', properties: { agents: { type: 'array', items: { type: 'object' } } } }) } },
    'post /api/agents': {
      id: 'registerAgent',
      summary: 'Register an agent version',
      description: 'Versions are immutable: registering the same id and version again with a different profile fails with 409.',
      tag: 'Agents',
      body: 'AgentProfile',
      responses: { 200: inline({ type: 'object' }), 201: inline({ type: 'object' }), 400: 'Error', 409: 'Error' },
    },

    'get /api/workspaces': { id: 'listWorkspaces', summary: 'List workspaces', tag: 'Workspaces', responses: { 200: inline({ type: 'object', properties: { workspaces: { type: 'array', items: ref('Workspace') }, defaultWorkspaceId: str } }) } },
    'post /api/workspaces': { id: 'createWorkspace', summary: 'Register a directory as a workspace', tag: 'Workspaces', body: 'CreateWorkspaceBody', responses: { 201: 'Workspace', 400: 'Error' } },
    'patch /api/workspaces/{id}': { id: 'updateWorkspace', summary: 'Change a workspace', tag: 'Workspaces', body: 'UpdateWorkspaceBody', responses: { 200: 'Workspace' } },
    'delete /api/workspaces/{id}': { id: 'deleteWorkspace', summary: 'Forget a workspace', tag: 'Workspaces', responses: { 204: null } },

    'get /api/runtimes': { id: 'listRuntimes', summary: 'Agent engines on this machine, with their models and effort levels', tag: 'Agents', responses: { 200: inline({ type: 'object', properties: { runtimes: { type: 'array', items: { type: 'object' } } } }) } },
    'post /api/runtimes/{agentType}/refresh': { id: 'refreshRuntime', summary: "Re-read an engine's models", tag: 'Agents', responses: { 200: inline({ type: 'object' }), 400: 'Error' } },

    'get /api/runs': { id: 'listRuns', summary: 'List runs, newest first', tag: 'Runs', query: { workflowId: str, limit: int }, responses: { 200: inline(list('runs', 'RunSummary')) } },
    'post /api/runs': {
      id: 'startRun',
      summary: 'Start a run',
      description: 'Workspaces maps slots to workspace ids (see /api/workspaces); slots left out use the bindings remembered for the workflow. The run executes in the background; follow it with /api/runs/{id}/stream.',
      tag: 'Runs',
      body: 'StartRunBody',
      responses: { 202: inline({ type: 'object', properties: { runId: str } }), 400: 'Error' },
    },
    'get /api/runs/{id}': { id: 'getRun', summary: 'Get a run', tag: 'Runs', responses: { 200: 'RunView', 404: 'Error' } },
    'get /api/runs/{id}/stream': {
      id: 'streamRun',
      summary: "Follow a run's log",
      description:
        'Server-Sent Events. `log` events carry one RunLogEntry each (`id` = its seq; fold them with the SDK\'s `applyRunLogEntry`); `activity` events carry `{ active, chiefAnswering, liveProgress }`. Reconnect with `Last-Event-ID` or `?after=<seq>`.',
      tag: 'Runs',
      query: { after: { ...int, description: 'Only entries after this seq' } },
      responses: { 200: 'sse' },
    },
    'post /api/runs/{id}/cancel': {
      id: 'cancelRun',
      summary: 'Stop a run for good',
      description: 'Steps still executing are aborted and their results dropped; the run ends CANCELLED. A finished run is returned unchanged.',
      tag: 'Runs',
      responses: { 200: inline({ type: 'object', properties: { run: ref('RunState') } }), 404: 'Error' },
    },
    'post /api/runs/{id}/rerun': { id: 'rerunFromNode', summary: 'Run again from a step', tag: 'Runs', body: 'RerunBody', responses: { 202: inline({ type: 'object', properties: { accepted: { type: 'boolean' } } }), 409: 'Error' } },
    'post /api/runs/{id}/fork': {
      id: 'forkRun',
      summary: 'Fork a run from a step',
      description:
        'Starts a new run on the workflow as it is saved now. Steps before `nodeId` are taken over from this run (results, loop rounds, outputs) and `nodeId` and everything after it run again; a step inside a loop or parallel container forks from the container. Workspaces are bound afresh (git-worktree workspaces get new worktrees at the current HEAD) and the taken-over steps\' file changes are merged three-way onto them. 400 when a step the fork point depends on did not finish in this run; 409 when an earlier change no longer merges onto the current code (nothing is created).',
      tag: 'Runs',
      body: 'ForkRunBody',
      responses: {
        202: inline({ type: 'object', properties: { runId: str, fromNodeId: str, inherited: { type: 'array', items: str } } }),
        400: 'Error',
        404: 'Error',
        409: 'Error',
      },
    },
    'post /api/runs/{id}/respond': { id: 'respondToRun', summary: 'Answer a gate decision or an agent question', tag: 'Runs', body: 'RespondBody', responses: { 202: inline({ type: 'object', properties: { accepted: { type: 'boolean' } } }), 400: 'Error' } },
    'post /api/runs/{id}/chief/messages': {
      id: 'messageChief',
      summary: "Talk to the run's chief",
      description: 'Returns once the message is recorded. The reply arrives in the run log as a `chief.intervened` event; while steps execute, retries and reruns it asks for wait until they finish.',
      tag: 'Runs',
      body: 'ChiefMessageBody',
      responses: { 202: inline({ type: 'object', properties: { messageId: str } }), 400: 'Error' },
    },
    'get /api/runs/{id}/conversations': {
      id: 'listRunConversations',
      summary: "A run's recorded agent conversations",
      tag: 'Runs',
      query: { scopeKey: str, nodeId: str, attemptId: str, invocationId: str, retryIndex: int, roundIndex: int, afterId: str, limit: int },
      responses: { 200: inline({ type: 'object', properties: { conversations: { type: 'array', items: ref('Conversation') } } }) },
    },
    'get /api/runs/{id}/data': {
      id: 'listRunData',
      summary: 'Intermediate data the steps saved',
      description: 'What steps stored with `ua-workflow data …` or the `data_*` MCP tools, oldest first.',
      tag: 'Runs',
      query: { namespace: { type: 'string', enum: ['node', 'run'] }, nodeId: str, scopeKey: str, collection: str, afterId: int, limit: int },
      responses: { 200: inline(list('records', 'NodeDataRecord')) },
    },
    'get /api/runs/{id}/findings': {
      id: 'listOpenFindings',
      summary: 'Problems still open in a run',
      description:
        "What each review's latest round left (a loop's last round speaks for it; a PASS can carry minor findings) and the issues steps logged (`ua-workflow issue`, `log_issue`), most severe first. What a closing step hands over to a person.",
      tag: 'Runs',
      responses: { 200: inline(list('findings', 'OpenFinding')), 404: 'Error' },
    },
    'get /api/artifacts/{id}': {
      id: 'readArtifact',
      summary: 'Read part of an artifact',
      tag: 'Runs',
      query: { offset: { ...int, description: 'Byte offset (default 0)' }, max: { ...int, description: 'Bytes to read (default 64 KiB, at most 1 MiB)' } },
      responses: { 200: 'Artifact', 404: 'Error' },
    },

    'get /api/conversations': { id: 'listConversations', summary: 'List conversations', tag: 'Conversations', query: { afterId: str, limit: int }, responses: { 200: inline(list('conversations', 'Conversation')) } },
    'post /api/conversations': { id: 'createConversation', summary: 'Start a conversation with an agent', tag: 'Conversations', body: 'CreateConversationBody', responses: { 201: 'Conversation', 400: 'Error' } },
    'get /api/conversations/{id}': { id: 'getConversation', summary: 'Get a conversation', tag: 'Conversations', responses: { 200: 'Conversation', 404: 'Error' } },
    'patch /api/conversations/{id}': { id: 'updateConversation', summary: 'Rename or annotate a conversation', tag: 'Conversations', body: 'UpdateConversationBody', responses: { 200: 'Conversation' } },
    'post /api/conversations/{id}/turns': { id: 'sendTurn', summary: 'Send a turn', tag: 'Conversations', body: 'SendTurnBody', responses: { 202: inline({ type: 'object' }), 409: 'Error' } },
    'get /api/conversations/{id}/turns': { id: 'listTurns', summary: 'List turns', tag: 'Conversations', query: { after: int, limit: int }, responses: { 200: inline({ type: 'object' }) } },
    'get /api/conversations/{id}/turns/{turnId}': { id: 'getTurn', summary: 'A turn with its messages', tag: 'Conversations', responses: { 200: inline({ type: 'object' }) } },
    'post /api/conversations/{id}/turns/{turnId}/cancel': { id: 'cancelTurn', summary: 'Cancel a turn', tag: 'Conversations', responses: { 200: inline({ type: 'object' }) } },
    'get /api/conversations/{id}/events': { id: 'listConversationEvents', summary: 'Read recorded events', tag: 'Conversations', query: { after: int, limit: int, turnId: str }, responses: { 200: inline({ type: 'object' }) } },
    'post /api/conversations/{id}/events': { id: 'recordConversationEvent', summary: 'Record a custom event', tag: 'Conversations', body: 'CustomEventBody', responses: { 204: null } },
    'get /api/conversations/{id}/permissions': { id: 'listPendingPermissions', summary: 'Pending permission requests', tag: 'Conversations', responses: { 200: inline({ type: 'object' }) } },
    'post /api/conversations/{id}/permissions/{permissionId}/respond': { id: 'respondToPermission', summary: 'Answer a permission request', tag: 'Conversations', body: 'PermissionResponseBody', responses: { 204: null } },
    ...conversationActions,
    'get /api/conversations/{id}/stream': { id: 'streamConversation', summary: "Follow a conversation's events", description: 'Server-Sent Events; reconnect with `Last-Event-ID`.', tag: 'Conversations', query: { after: int }, responses: { 200: 'sse' } },
  };
}

/** The OpenAPI 3.1 description of the workflow server's HTTP API. */
export function buildOpenApiDocument(options: { serverUrl?: string; version?: string } = {}): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const [key, op] of Object.entries(operations())) {
    const [method, path] = key.split(' ') as [string, string];
    (paths[path] ??= {})[method] = operation(path, op);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Universal Agent workflow server',
      version: options.version ?? '1.0.0',
      license: { name: 'MIT', identifier: 'MIT' },
      description:
        'Save workflows, register agents and workspaces, start and follow runs, answer gates, talk to the chief, cancel, and read artifacts, intermediate data and agent conversations. The server binds to loopback by default and has no authentication of its own.',
    },
    servers: [{ url: options.serverUrl ?? 'http://127.0.0.1:4317' }],
    tags: [
      { name: 'Server', description: 'Health and this document.' },
      { name: 'Workflows', description: 'Saved workflow definitions, their canvas layout and remembered workspace bindings.' },
      { name: 'Agents', description: 'Agent profiles (engine, charter, rules, skills) steps delegate to, and the engines installed here.' },
      { name: 'Workspaces', description: 'Directories runs work in, bound to workflow slots.' },
      { name: 'Runs', description: 'Start, follow, steer, cancel and inspect runs: their log, artifacts, intermediate data and agent conversations.' },
      { name: 'Conversations', description: 'Recorded agent sessions, also usable on their own.' },
    ],
    // No authentication: the server binds to loopback unless told otherwise.
    security: [],
    paths,
    components: { schemas: { ...generatedSchemas(), ...RESPONSE_SCHEMAS } },
  };
}

/** `/api/runs/:id` (Fastify) → `/api/runs/{id}` (OpenAPI). */
export function openApiPath(fastifyPath: string): string {
  return fastifyPath.replace(/:(\w+)/g, '{$1}');
}
