import { ProjectMetadata } from './project-metadata.js';
import { goalSnapshot, type GoalService } from './goals.js';
import {
  forkSnapshot,
  forkTarget,
  nativeTurnId,
  type ForkObservation,
  type ForkSnapshot,
} from './session-fork.js';
import {
  LODY_PLAN_MODE_CONFIG_ID,
  LODY_EXTENSION_METHODS,
  createPlanModeConfigOption,
  normalizeLodyExtensionMethod,
} from 'acp-extension-core';
import { replaySessionHistory, restoredSelection } from './session-history.js';
import { ToolCallBridge, type ToolPresenter } from './tool-calls.js';
import { HarnessUsageTracker, type HarnessTokenUsage } from './usage.js';
import {
  UserQuestionBridge,
  type HarnessQuestionRequest,
  type HarnessQuestionAnswer,
} from './user-questions.js';
/**
 * ACP surface for DeepSeek Harness.
 *
 * The upstream ACP plugin intentionally exposes only automation basics. This
 * adapter keeps its prompt, lifecycle, cancellation, and one-shot approval
 * behavior while adding standard ACP session controls backed by Harness's
 * per-agent model waterfall and permission-preset service.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type ContentBlock,
  type ForkSessionRequest,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type ListSessionsRequest,
  type ResumeSessionRequest,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk';
import type {
  LodyActivityMeta,
  LodyExtensionCapabilities,
  LodySessionMeta,
  LodySubagentTask,
  LodyTaskMeta,
} from 'acp-extension-core';
import {
  LodySubagentEmitter,
  LODY_SUBAGENT_EVENT_METHOD,
  supportsLodySubagentEvents,
} from 'acp-extension-core';
import {
  DEEPSEEK_HARNESS_AGENT_PRESETS,
  DEEPSEEK_HARNESS_API_KEY_ENV,
  DEEPSEEK_HARNESS_BASE_URL_ENV,
  isDeepSeekOfficialBaseUrl,
} from './capabilities.js';
import {
  ACP_EXTENSION_DSH_VERSION,
  DEEPSEEK_HARNESS_DEFAULT_MODEL,
  DEEPSEEK_HARNESS_PROVIDER,
} from './profile.js';

export const name = 'acp-extension-dsh';
// Waiting for persistence/query also preserves the upstream composite's
// startup boundary: ACP cannot accept a session until durability is ready.
export const inject = [
  'agents',
  'agentPresets',
  'attachments',
  'goals',
  'jobs',
  'tokenMeter',
  'loader',
  'llm',
  'permissionPresets',
  'sessionPersistence',
  'sessions',
  'sessionQuery',
  'sessionTitle',
  'userQuestions',
];

type ModelSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

type ModelSelectionRef = {
  current: ModelSelection;
  assembled?: ModelSelection;
};

type HarnessRequestConfig = Record<string, unknown> & {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

type HarnessPromptAssembly = Record<string, unknown> & {
  variables?: Record<string, unknown>;
};

type HarnessTextBlock = { type: 'text'; text: string };
type HarnessImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
type HarnessImageAttachmentRef = {
  attachmentId: string;
  mediaType: HarnessImageMediaType;
  bytes: number;
  width: number;
  height: number;
};
type HarnessImageBlock = {
  type: 'image';
  attachment: HarnessImageAttachmentRef;
};
type HarnessMessageBlock = HarnessTextBlock | HarnessImageBlock | { type: string };
type HarnessStreamChunk = {
  type: string;
  text?: string;
  block?: { type: string };
};
/** One transient `agent/assistant-stream` publication from the Harness agent loop. */
type HarnessAssistantStreamFrame = {
  type: string;
  chunk?: HarnessStreamChunk;
};

type HarnessTurnEndReason =
  | { kind: 'completed' | 'max-tokens' | 'aborted' | 'interrupted' | 'blocked' }
  | { kind: 'error'; error: { message: string } };

type HarnessSessionEvent = {
  type: string;
  seq?: number;
  time?: number;
  data: {
    provider?: string;
    model?: string;
    usage?: HarnessTokenUsage;
    turn?: number | null;
    reason?: HarnessTurnEndReason;
    message?: { content: HarnessMessageBlock[] };
    title?: string;
    source?: { kind: string };
    contextWindow?: number;
    retryId?: string;
    compactionId?: string;
    error?: string;
  };
};

const LODY_CAPABILITIES = {
  forkAtTurn: { version: 1 },
  subagentEvents: { version: 1 },
  sessionTitle: { version: 1 },
  compaction: { version: 1 },
  usage: { version: 1 },
  sessionHistory: { version: 1 },
  steering: { version: 1, transport: 'request', upstreamTurn: 'same', configPolicy: 'active' },
  subagents: { version: 1, lifecycle: true, list: true, output: true, cancel: true },
} as const satisfies LodyExtensionCapabilities;

type HarnessSession = {
  id: string;
  header: { id: string; cwd?: string; origin?: string; agentPreset?: string };
  snapshotEvents(): ForkSnapshot['seed'];
  append(type: 'model/selection', data: ModelSelection): unknown;
};

type HarnessAgent = {
  id: string;
  ctx: HarnessAgentContext;
  session: HarnessSession;
  followup(message: HarnessUserMessage): void;
  cancel(cause: { kind: 'user' }): void;
  whenIdle(): Promise<void>;
  status?: string;
  inject(message: HarnessUserMessage): void;
  inbox: { remove(id: string): boolean };
};

type HarnessUserMessage = {
  id: string;
  role: 'user';
  content: Array<HarnessTextBlock | HarnessImageBlock>;
  source: { kind: 'user' };
};

type HarnessAttachmentStore = {
  imageLimits: { mediaTypes: readonly string[] };
  saveImages(
    images: readonly { data: Uint8Array; mediaType: HarnessImageMediaType }[]
  ): Promise<readonly HarnessImageAttachmentRef[]>;
  readImage(ref: HarnessImageAttachmentRef): Promise<{
    data: Uint8Array;
    ref: HarnessImageAttachmentRef;
  }>;
};

type HarnessCatalogModel = {
  provider: string;
  id: string;
  name?: string;
  description?: string;
  inputModalities?: readonly string[];
};

type HarnessReasoningEffort = {
  id: string;
  name: string;
  description?: string;
};

type HarnessResolvedModel = Omit<HarnessCatalogModel, 'name'> & {
  name: string;
  reasoning?: {
    efforts: readonly HarnessReasoningEffort[];
    defaultEffort?: string;
  };
};

type HarnessLlmCatalog = {
  listProviders?(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<readonly HarnessCatalogModel[]>;
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<HarnessResolvedModel>;
};

type HarnessPermissionOption = {
  value: string;
  name: string;
  description?: string;
};

type HarnessPlanMode = {
  get(agent: HarnessAgent): { active: boolean; pending?: boolean };
  set(agent: HarnessAgent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop';
};

type HarnessAgentContext = {
  get(name: string): unknown;
  on<TArgs extends unknown[]>(event: string, listener: (...args: TArgs) => unknown): () => void;
  plugin(plugin: HarnessPlugin, config: HarnessMcpClientConfig): HarnessPluginHandle;
  loader: {
    import(name: string): Promise<unknown>;
    unwrapExports(exports: unknown): unknown;
  };
};

type HarnessPlugin = {
  apply(context: unknown, config: HarnessMcpClientConfig): unknown;
};

type HarnessPluginHandle = {
  await(): Promise<unknown>;
};

type HarnessMcpClientConfig =
  | {
      transport: 'stdio';
      serverName: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
      toolCallTimeoutMs: number;
      failOnStartupError: boolean;
    }
  | {
      transport: 'streamable-http';
      serverName: string;
      url: string;
      headers: Record<string, string>;
      toolCallTimeoutMs: number;
      failOnStartupError: boolean;
    };

type HarnessAgentHandle = {
  agent: HarnessAgent;
  dispose(): Promise<void>;
};

type HarnessAgentPreset = {
  id: string;
  name?: string;
  description?: string;
  broken?: string;
};

type HarnessContext = {
  agents: {
    create(options: {
      sessionId: string;
      meta: { cwd: string; agentPreset: string; parentSession?: string; isSeeded?: boolean };
      seed?: ForkSnapshot['seed'];
      inheritedEventCount?: number;
      agentOptions: { provider: string; model: string };
      setup(agentContext: HarnessAgentContext): void | Promise<void>;
    }): Promise<HarnessAgentHandle>;
    resume(options: {
      resumeSessionId: string;
      setup(agentContext: HarnessAgentContext, agent: HarnessAgent): Promise<void>;
    }): Promise<HarnessAgentHandle>;
    get(sessionId: string): HarnessAgent | undefined;
  };
  permissionPresets: {
    names: readonly string[];
    defaultPreset: string;
    current(session: HarnessSession): string;
    optionOf(name: string): HarnessPermissionOption;
    set(session: HarnessSession, name: string): void;
  };
  agentPresets: {
    defaultId: string;
    list(): Promise<HarnessAgentPreset[]>;
    mount(agentContext: HarnessAgentContext, id?: string): Promise<HarnessAgentPreset>;
    select(agent: HarnessAgent, id: string): Promise<string>;
  };
  logger: {
    warn(message: string): void;
  };
  on<TArgs extends unknown[]>(event: string, listener: (...args: TArgs) => unknown): () => void;
  get(name: string): unknown;
  effect(register: () => () => Promise<void>, label: string): void;
};

export type DeepSeekAcpAdapterConfig = {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /** Directory of bundled declarative presets, registered in the profile scope. */
  presetRoot?: string;
  userPresetRoot?: string;
  /** Legacy settings are validated on initialize, even if a provider failed to mount. */
  settingsPath?: string;
  projectMetadataRoot?: string;
  /** Runtime-only transport override used by unit tests. */
  stream?: Stream;
};

type ResolvedAdapterConfig = {
  provider: string;
  model: string;
  reasoningEffort?: string;
  stream?: Stream;
};

type InflightPrompt = {
  resolve(reason: StopReason): void;
  reject(error: Error): void;
  messageId?: string;
  messageQueued: boolean;
  turn?: number;
  endReason?: HarnessTurnEndReason;
  admissionDone: Promise<void>;
  admissionController: AbortController;
  cancelRequested: boolean;
  settlementStarted: boolean;
  outputError?: Error;
  agentError?: Error;
};

type SessionRecord = {
  cwd: string;
  tools: ToolCallBridge;
  questions: UserQuestionBridge;
  usage: HarnessUsageTracker;
  agent: HarnessAgent;
  dispose(): Promise<void>;
  selection: ModelSelectionRef;
  permissionMode: string;
  permissionOptions: HarnessPermissionOption[];
  agentPreset: string;
  agentPresetOptions: HarnessAgentPreset[];
  models: HarnessResolvedModel[];
  started: boolean;
  outputTail: Promise<void>;
  permissionSyncQueued?: boolean;
  contextWindow?: number;
  retries?: Set<string>;
  steering?: Map<
    string,
    { steerId: string; turn: number; resolve(value: { outcome: 'injected' | 'failed' }): void }
  >;
  inflight?: InflightPrompt;
};

type HarnessModelCatalog = {
  models: HarnessResolvedModel[];
  initialSelection: ModelSelection;
};

type NewSessionResponseWithModels = NewSessionResponse & {
  models: {
    currentModelId: string;
    availableModels: Array<{
      modelId: string;
      name: string;
      description: string | null;
    }>;
  };
};

type ContinuableDrain = {
  drainContinuableDescendants(parents: readonly HarnessAgent[]): Promise<void>;
};

const MODEL_CONFIG_ID = 'model';
const MODE_CONFIG_ID = 'mode';
const REASONING_EFFORT_CONFIG_ID = 'reasoning_effort';
const AGENT_PRESET_CONFIG_ID = 'agent_preset';
const PERMISSION_EVENT_TYPES = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const MCP_TOOL_CALL_TIMEOUT_MS = 60_000;
const MCP_SERVER_NAME_MAX_LENGTH = 32;
const MCP_SERVER_NAME_HASH_LENGTH = 8;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const MODEL_DISCOVERY_MAX_BYTES = 1024 * 1024;
const MODEL_DISCOVERY_MAX_MODELS = 1_000;
const MODEL_ID_MAX_LENGTH = 512;
const ACP_MODEL_ID_PREFIX = 'dsh-route:';
const INVALID_MCP_SERVER_NAME_CHARS = /[^A-Za-z0-9_-]/gu;
const IMAGE_MEDIA_TYPES: readonly HarnessImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const IMAGE_ADMISSION_ERROR_CODES = new Set([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
]);

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail);
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail);
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function resolveAdapterConfig(config: DeepSeekAcpAdapterConfig | undefined): ResolvedAdapterConfig {
  const provider = nonEmptyString(config?.provider, DEEPSEEK_HARNESS_PROVIDER);
  const model = nonEmptyString(config?.model, DEEPSEEK_HARNESS_DEFAULT_MODEL);
  return {
    provider,
    model,
    ...(config?.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config?.stream ? { stream: config.stream } : {}),
  };
}

async function loadHarnessModels(
  llm: HarnessLlmCatalog,
  defaultProvider: string,
  configuredModel: string,
  endpoint?: { baseUrl: string; apiKey?: string }
): Promise<HarnessModelCatalog> {
  const providers = llm.listProviders?.() ?? [{ id: defaultProvider, name: defaultProvider }];
  if (!providers.some(({ id }) => id === defaultProvider)) {
    throw new Error(`configured provider ${JSON.stringify(defaultProvider)} is unavailable`);
  }
  const identities: ModelSelection[] = [];
  for (const { id: provider } of providers) {
    const listed =
      endpoint && provider === defaultProvider
        ? (await discoverDeepSeekModelIds(endpoint.baseUrl, endpoint.apiKey)).map((id) => ({
            provider,
            id,
          }))
        : await llm.listModels(provider);
    const ids = new Set<string>();
    for (const model of listed) {
      if (model.provider !== provider || !model.id.trim()) continue;
      if (ids.has(model.id)) {
        throw new Error(
          `acp-extension-dsh: duplicate model ${JSON.stringify(model.id)} for provider ${JSON.stringify(provider)}`
        );
      }
      ids.add(model.id);
      identities.push({ provider, model: model.id });
    }
    if (endpoint && provider === defaultProvider && ids.size === 0) {
      throw new Error('the endpoint returned no usable models');
    }
    // Without endpoint discovery, the Harness catalog remains advisory. An
    // explicitly configured default route may name an unlisted model.
    if (provider === defaultProvider && !endpoint && !ids.has(configuredModel)) {
      identities.unshift({ provider, model: configuredModel });
    }
  }
  const initialSelection = endpoint
    ? identities.find(({ provider }) => provider === defaultProvider)
    : { provider: defaultProvider, model: configuredModel };
  if (!initialSelection) throw new Error('the endpoint returned no usable models');
  return {
    models: await Promise.all(
      identities.map(({ provider, model }) => resolveHarnessModel(llm, provider, model))
    ),
    initialSelection,
  };
}

function encodeAcpModelId(provider: string, model: string): string {
  return `${ACP_MODEL_ID_PREFIX}${Buffer.from(JSON.stringify([provider, model])).toString('base64url')}`;
}

function decodeAcpModelId(value: string, legacyProvider: string): ModelSelection {
  if (!value.startsWith(ACP_MODEL_ID_PREFIX)) return { provider: legacyProvider, model: value };
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value.slice(ACP_MODEL_ID_PREFIX.length), 'base64url').toString('utf8')
    );
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      decoded.every((part) => typeof part === 'string' && part.trim())
    ) {
      return { provider: decoded[0] as string, model: decoded[1] as string };
    }
  } catch {
    // Fall through to the stable ACP invalid-params response below.
  }
  throw invalidParams('model route id is invalid');
}

function selectedModel(record: SessionRecord): HarnessResolvedModel | undefined {
  return record.models.find(
    (candidate) =>
      candidate.provider === record.selection.current.provider &&
      candidate.id === record.selection.current.model
  );
}

function modelDiscoveryUrl(baseUrl: string): URL {
  const url = new URL(isDeepSeekOfficialBaseUrl(baseUrl) ? 'https://api.deepseek.com' : baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`;
  url.hash = '';
  return url;
}

async function readLimitedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MODEL_DISCOVERY_MAX_BYTES) {
    throw new Error('model discovery response is too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MODEL_DISCOVERY_MAX_BYTES) {
      await reader.cancel();
      throw new Error('model discovery response is too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function discoverDeepSeekModelIds(baseUrl: string, apiKey?: string): Promise<string[]> {
  const headers = new Headers({ accept: 'application/json' });
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  let response: Response;
  try {
    response = await fetch(modelDiscoveryUrl(baseUrl), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new Error(`unable to request the endpoint model list: ${errorChain(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`model discovery failed with HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(await readLimitedResponse(response));
  } catch (error: unknown) {
    throw new Error(`model discovery returned invalid JSON: ${errorChain(error)}`, {
      cause: error,
    });
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('data' in body) ||
    !Array.isArray(body.data) ||
    body.data.length > MODEL_DISCOVERY_MAX_MODELS
  ) {
    throw new Error('model discovery returned an invalid OpenAI-compatible response');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of body.data) {
    if (typeof entry !== 'object' || entry === null || !('id' in entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || id.length > MODEL_ID_MAX_LENGTH || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function resolveHarnessModel(
  llm: HarnessLlmCatalog,
  provider: string,
  modelId: string,
  signal?: AbortSignal
): Promise<HarnessResolvedModel> {
  if (!modelId.trim()) throw invalidParams('model id must not be empty');
  const model = await llm.resolveModelInfo(provider, modelId, signal);
  if (model.provider !== provider || model.id !== modelId || !model.name?.trim()) {
    throw new Error(
      `acp-extension-dsh: invalid exact model metadata for ${JSON.stringify(provider)} / ${JSON.stringify(modelId)}`
    );
  }
  return model;
}

async function loadMcpClientPlugin(agentContext: HarnessAgentContext): Promise<HarnessPlugin> {
  const module = agentContext.loader.unwrapExports(
    await agentContext.loader.import(MCP_CLIENT_PACKAGE)
  );
  if (
    typeof module !== 'object' ||
    module === null ||
    !('apply' in module) ||
    typeof module.apply !== 'function'
  ) {
    throw new Error(`${MCP_CLIENT_PACKAGE} does not export a Cordis plugin`);
  }
  return module as HarnessPlugin;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, MCP_SERVER_NAME_HASH_LENGTH);
}

function normalizedMcpServerName(serverName: string, fallbackIndex: number): string {
  const normalized = serverName.replace(INVALID_MCP_SERVER_NAME_CHARS, '_');
  const base = normalized || `server_${fallbackIndex + 1}`;
  if (base === serverName && base.length <= MCP_SERVER_NAME_MAX_LENGTH) return base;
  const hash = shortHash(serverName);
  return `${base.slice(0, MCP_SERVER_NAME_MAX_LENGTH - hash.length - 1)}_${hash}`;
}

function reserveMcpServerNames(
  servers: readonly McpServer[],
  sessionId: string,
  activeNames: Set<string>
): { names: string[]; release(): void } {
  const names: string[] = [];
  for (const [index, server] of servers.entries()) {
    const base = normalizedMcpServerName(server.name, index);
    let reservedName = base;
    let attempt = 0;
    while (activeNames.has(reservedName)) {
      const suffix = shortHash(`${sessionId}\0${index}\0${attempt}`);
      reservedName = `${base.slice(0, MCP_SERVER_NAME_MAX_LENGTH - suffix.length - 1)}_${suffix}`;
      attempt += 1;
    }
    activeNames.add(reservedName);
    names.push(reservedName);
  }

  let released = false;
  return {
    names,
    release() {
      if (released) return;
      released = true;
      for (const reservedName of names) activeNames.delete(reservedName);
    },
  };
}

function entriesToRecord(
  entries: readonly { name: string; value: string }[]
): Record<string, string> {
  return Object.fromEntries(entries.map(({ name: entryName, value }) => [entryName, value]));
}

function mcpClientConfig(
  server: McpServer,
  serverName: string,
  cwd: string
): HarnessMcpClientConfig {
  if (!('type' in server)) {
    return {
      transport: 'stdio',
      serverName,
      command: server.command,
      args: [...server.args],
      env: entriesToRecord(server.env),
      cwd,
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    };
  }
  if (server.type === 'http') {
    return {
      transport: 'streamable-http',
      serverName,
      url: server.url,
      headers: entriesToRecord(server.headers),
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    };
  }
  throw invalidParams(`MCP transport ${server.type} is not supported`);
}

async function mountMcpServers(
  agentContext: HarnessAgentContext,
  servers: readonly McpServer[],
  serverNames: readonly string[],
  cwd: string
): Promise<void> {
  if (servers.length === 0) return;
  const plugin = await loadMcpClientPlugin(agentContext);
  const handles = servers.map((server, index) => {
    const serverName = serverNames[index];
    if (!serverName) throw new Error(`missing MCP namespace for server ${index}`);
    return agentContext.plugin(plugin, mcpClientConfig(server, serverName, cwd));
  });
  await Promise.all(handles.map((handle) => handle.await()));
}

function installModelSelection(
  agentContext: HarnessAgentContext,
  selection: ModelSelectionRef
): void {
  agentContext.on(
    'system-prompt/assemble',
    async (_assembly: unknown, _context: unknown, next: () => Promise<HarnessPromptAssembly>) => {
      const selected = { ...selection.current };
      const assembled = await next();
      selection.assembled = selected;
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: selected.provider,
          model: selected.model,
        },
      };
    }
  );
  agentContext.on(
    'agent/request',
    async (_payload: unknown, next: () => Promise<HarnessRequestConfig>) => {
      const resolved = await next();
      const selected = selection.assembled ?? selection.current;
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      };
    }
  );
}

function planModeService(record: SessionRecord): HarnessPlanMode | undefined {
  return record.agent.ctx.get('planMode') as HarnessPlanMode | undefined;
}

function configOptions(record: SessionRecord): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: MODE_CONFIG_ID,
      name: 'Permission',
      description: 'Sandbox and approval policy for the session',
      category: 'mode',
      type: 'select',
      currentValue: record.permissionMode,
      options: record.permissionOptions.map((mode) => ({
        value: mode.value,
        name: mode.name,
        description: mode.description ?? null,
      })),
    },
    {
      id: AGENT_PRESET_CONFIG_ID,
      name: 'Agent preset',
      description: 'Tools, prompt, and capabilities composed for the session',
      category: 'agent_preset',
      type: 'select',
      currentValue: record.agentPreset,
      options: record.agentPresetOptions.map((preset) => {
        const builtIn = DEEPSEEK_HARNESS_AGENT_PRESETS.find(
          (candidate) => candidate.value === preset.id
        );
        // The pinned Harness presets may carry upstream-localized metadata.
        // Keep built-in ACP labels stable; runtime metadata still owns user presets.
        return {
          value: preset.id,
          name: builtIn?.name ?? preset.name ?? preset.id,
          description: builtIn?.description ?? preset.description ?? null,
        };
      }),
    },
    {
      id: MODEL_CONFIG_ID,
      name: 'Model',
      description: 'Provider route and model used for the session',
      category: 'model',
      type: 'select',
      currentValue: encodeAcpModelId(
        record.selection.current.provider,
        record.selection.current.model
      ),
      options: record.models.map((model) => ({
        value: encodeAcpModelId(model.provider, model.id),
        name: `${model.name} (${model.provider})`,
        description: model.description ?? null,
      })),
    },
  ];
  const plan = planModeService(record);
  if (plan) {
    const state = plan.get(record.agent);
    options.push(createPlanModeConfigOption(state.pending ?? state.active));
  }
  const model = selectedModel(record);
  if (model?.reasoning && record.selection.current.reasoningEffort) {
    options.push({
      id: REASONING_EFFORT_CONFIG_ID,
      name: 'Reasoning effort',
      description: 'How much reasoning effort the model should use',
      category: 'thought_level',
      type: 'select',
      currentValue: record.selection.current.reasoningEffort,
      options: model.reasoning.efforts.map((effort) => ({
        value: effort.id,
        name: effort.name,
        description: effort.description ?? null,
      })),
    });
  }
  return options;
}

function legacyModels(record: SessionRecord): NewSessionResponseWithModels['models'] {
  return {
    currentModelId: encodeAcpModelId(
      record.selection.current.provider,
      record.selection.current.model
    ),
    availableModels: record.models.flatMap((model) => [
      {
        modelId: encodeAcpModelId(model.provider, model.id),
        name: `${model.name} (${model.provider})`,
        description: model.description ?? null,
      },
      ...(model.reasoning?.efforts.map((effort) => ({
        modelId: `${encodeAcpModelId(model.provider, model.id)}[${effort.id}]`,
        name: `${model.name} (${model.provider}, ${effort.name})`,
        description: model.description ?? null,
      })) ?? []),
    ]),
  };
}

function modeState(record: SessionRecord): SessionModeState {
  return {
    currentModeId: record.permissionMode,
    availableModes: record.permissionOptions.map((mode) => ({
      id: mode.value,
      name: mode.name,
      description: mode.description ?? null,
    })),
  };
}

function supportsAcpImagePrompts(
  attachments: HarnessAttachmentStore | undefined,
  models: readonly HarnessResolvedModel[]
): boolean {
  return (
    attachments !== undefined &&
    attachments.imageLimits.mediaTypes.some((mediaType) =>
      IMAGE_MEDIA_TYPES.includes(mediaType as HarnessImageMediaType)
    ) &&
    models.some((model) => model.inputModalities?.includes('image'))
  );
}

function resolveReasoningEffort(
  model: HarnessResolvedModel,
  requested: string | undefined
): string | undefined {
  const reasoning = model.reasoning;
  if (!reasoning) {
    if (requested) {
      throw invalidParams(
        `model ${JSON.stringify(model.id)} does not support reasoning effort ${JSON.stringify(requested)}`
      );
    }
    return undefined;
  }
  const effort = requested ?? reasoning.defaultEffort;
  if (!effort) return undefined;
  assertAllowed(
    effort,
    new Set(reasoning.efforts.map((candidate) => candidate.id)),
    `reasoning effort for model ${model.id}`
  );
  return effort;
}

function permissionState(ctx: HarnessContext, currentMode: string): HarnessPermissionOption[] {
  const options = ctx.permissionPresets.names.map((mode) => ctx.permissionPresets.optionOf(mode));
  if (!ctx.permissionPresets.names.includes(currentMode)) {
    options.push(ctx.permissionPresets.optionOf(currentMode));
  }
  return options;
}

function imageMediaType(value: string): HarnessImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.includes(value as HarnessImageMediaType)
    ? (value as HarnessImageMediaType)
    : undefined;
}

function decodePromptImage(block: Extract<PromptRequest['prompt'][number], { type: 'image' }>): {
  data: Uint8Array;
  mediaType: HarnessImageMediaType;
} {
  const mediaType = imageMediaType(block.mimeType);
  if (!mediaType) {
    throw invalidParams('image mimeType must be image/png, image/jpeg, image/webp, or image/gif');
  }
  if (!block.data || !CANONICAL_BASE64.test(block.data)) {
    throw invalidParams('image data must be canonical base64');
  }
  const decoded = Buffer.from(block.data, 'base64');
  if (decoded.toString('base64') !== block.data) {
    throw invalidParams('image data must be canonical base64');
  }
  return { data: new Uint8Array(decoded), mediaType };
}

function isImageAdmissionError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    IMAGE_ADMISSION_ERROR_CODES.has(error.code)
  );
}

async function admitAcpPrompt(
  prompt: PromptRequest['prompt'],
  llm: HarnessLlmCatalog,
  selection: ModelSelection,
  attachments: HarnessAttachmentStore | undefined,
  imagePromptEnabled: boolean,
  signal: AbortSignal
): Promise<Array<HarnessTextBlock | HarnessImageBlock>> {
  const images: Array<{ data: Uint8Array; mediaType: HarnessImageMediaType }> = [];
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
      case 'resource_link':
        break;
      case 'image':
        if (!imagePromptEnabled) {
          throw invalidParams('inline image prompts were not advertised by this connection');
        }
        images.push(decodePromptImage(block));
        break;
      case 'audio':
        throw invalidParams('audio prompt content is not supported');
      case 'resource':
        throw invalidParams('embedded resource prompt content is not supported');
      default:
        throw invalidParams('unsupported ACP prompt content');
    }
  }

  let refs: readonly HarnessImageAttachmentRef[] = [];
  if (images.length > 0) {
    if (!attachments) throw internalError('no Harness attachment store is mounted');
    signal.throwIfAborted();
    let model: HarnessResolvedModel;
    try {
      model = await resolveHarnessModel(llm, selection.provider, selection.model, signal);
    } catch (error: unknown) {
      throw internalError(`unable to verify the current image model: ${errorChain(error)}`);
    }
    if (!model.inputModalities?.includes('image')) {
      throw invalidParams(`model ${JSON.stringify(selection.model)} does not support image input`);
    }
    signal.throwIfAborted();
    try {
      refs = await attachments.saveImages(images);
    } catch (error: unknown) {
      if (isImageAdmissionError(error)) throw invalidParams(error.message);
      throw internalError('unable to persist the prompt image batch');
    }
    signal.throwIfAborted();
  }

  const content: Array<HarnessTextBlock | HarnessImageBlock> = [];
  let pendingText = '';
  let imageIndex = 0;
  const flushText = (): void => {
    if (!pendingText) return;
    content.push({ type: 'text', text: pendingText });
    pendingText = '';
  };
  for (const block of prompt) {
    if (block.type === 'text') {
      pendingText += block.text;
    } else if (block.type === 'resource_link') {
      pendingText += `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`;
    } else if (block.type === 'image') {
      flushText();
      const attachment = refs[imageIndex++];
      if (!attachment)
        throw internalError('the attachment store returned an incomplete image batch');
      content.push({ type: 'image', attachment });
    }
  }
  flushText();
  if (
    !content.some(
      (block) => block.type === 'image' || (block.type === 'text' && block.text.trim().length > 0)
    )
  ) {
    throw invalidParams('empty prompt');
  }
  return content;
}

async function assistantBlockToAcp(
  block: HarnessMessageBlock,
  attachments: HarnessAttachmentStore | undefined
): Promise<ContentBlock | undefined> {
  if (block.type === 'text' && 'text' in block) {
    return block.text.length > 0 ? { type: 'text', text: block.text } : undefined;
  }
  if (block.type !== 'image' || !('attachment' in block)) return undefined;
  if (!attachments)
    throw new Error('cannot deliver assistant image: no attachment store is mounted');
  let stored: Awaited<ReturnType<HarnessAttachmentStore['readImage']>>;
  try {
    stored = await attachments.readImage(block.attachment);
  } catch (error: unknown) {
    throw new Error('cannot deliver assistant image: the attachment is unavailable or corrupt', {
      cause: error,
    });
  }
  return {
    type: 'image',
    data: Buffer.from(stored.data).toString('base64'),
    mimeType: stored.ref.mediaType,
  };
}

function createUserMessage(
  id: string,
  content: Array<HarnessTextBlock | HarnessImageBlock>
): HarnessUserMessage {
  return Object.freeze({
    id,
    role: 'user' as const,
    content: Object.freeze(content.map((block) => Object.freeze(block))),
    source: Object.freeze({ kind: 'user' as const }),
  }) as HarnessUserMessage;
}

function errorChain(value: unknown): string {
  const seen = new Set<unknown>();
  const render = (current: unknown): string => {
    if (seen.has(current)) return '<circular cause>';
    seen.add(current);
    try {
      if (!(current instanceof Error)) return String(current);
      const message = current.message || current.name;
      const cause = current.cause == null ? '' : render(current.cause);
      return cause && cause !== message ? `${message}: ${cause}` : message;
    } finally {
      seen.delete(current);
    }
  };
  return render(value);
}

function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
  }
  if (params.additionalDirectories && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported');
  }
  for (const server of params.mcpServers) {
    if ('type' in server && server.type !== 'http') {
      throw invalidParams(`MCP transport ${server.type} is not supported`);
    }
  }
}

function requireSelectValue(params: SetSessionConfigOptionRequest): string {
  if (typeof params.value !== 'string') {
    throw invalidParams(`${params.configId} requires a select value`);
  }
  return params.value;
}

function assertAllowed(value: string, allowed: ReadonlySet<string>, label: string): void {
  if (!allowed.has(value)) {
    throw invalidParams(`unknown ${label}: ${value} (available: ${[...allowed].join(', ')})`);
  }
}

/** Background completion must not open a root turn outside an ACP prompt. */
function configureJobDelivery(rows: unknown[]): void {
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as { name?: string; config?: unknown };
    if (row.name === '@deepseek-ai/dsh-tool-jobs')
      row.config = { ...((row.config as object) ?? {}), completionDelivery: 'quiet' };
    if (Array.isArray(row.config)) configureJobDelivery(row.config);
  }
}

/** Register vendored YAML in the profile scope so native package resolution remains valid. */
async function registerBundledPresets(
  ctx: HarnessContext,
  root: string,
  userRoot?: string
): Promise<void> {
  const loader = ctx.get('loader') as { import(name: string): Promise<unknown> };
  const yaml = (await loader.import('js-yaml')) as {
    load(text: string, options: { schema: unknown }): unknown;
  };
  const include = (await loader.import('@deepseek-ai/cordis-plugin-include')) as {
    entryListSchema: unknown;
  };
  const registry = ctx.agentPresets as typeof ctx.agentPresets & {
    register(definition: { id: string; plugins: unknown[] }): Promise<() => Promise<void>>;
  };
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    const rows = yaml.load(await readFile(join(root, `${id}.yml`), 'utf8'), {
      schema: include.entryListSchema,
    }) as Array<{ config: { id: string; plugins: unknown[] } }>;
    const definition = rows[0]?.config;
    if (rows.length !== 1 || definition?.id !== id || !Array.isArray(definition.plugins)) {
      throw new Error(`Invalid bundled preset: ${id}`);
    }
    configureJobDelivery(definition.plugins);
    const dispose = await registry.register(definition);
    ctx.effect(() => dispose, `acp-extension-dsh.preset.${id}`);
  }
  if (userRoot) {
    const directories = await readdir(userRoot, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    for (const directory of directories) {
      if (
        !directory.isDirectory() ||
        ['standard', 'ptc', 'minimal', 'cordis'].includes(directory.name)
      )
        continue;
      try {
        const folder = join(userRoot, directory.name);
        const metadata = yaml.load(await readFile(join(folder, 'preset.yml'), 'utf8'), {
          schema: include.entryListSchema,
        }) as { name?: string; description?: string; order?: number };
        const plugins = yaml.load(await readFile(join(folder, 'agent.cordis.yml'), 'utf8'), {
          schema: include.entryListSchema,
        });
        if (!Array.isArray(plugins)) throw new Error('expected a plugin list');
        // Legacy presets resolve local files/expressions beside the preset, but
        // package names through the Harness installation. Preserve both bases.
        const profile = ctx as HarnessContext & {
          baseUrl: string;
          extend(properties: { baseUrl: string }): { agentPresets: typeof registry };
        };
        const resolver = createRequire(profile.baseUrl);
        const resolvePackages = (rows: unknown[]): void => {
          for (const value of rows) {
            if (!value || typeof value !== 'object') continue;
            const row = value as { name?: unknown; group?: boolean; config?: unknown };
            if (
              typeof row.name === 'string' &&
              !row.name.startsWith('.') &&
              !isAbsolute(row.name) &&
              !/^[a-z][a-z\d+.-]*:/i.test(row.name)
            )
              row.name = pathToFileURL(resolver.resolve(row.name)).href;
            if (row.group && Array.isArray(row.config)) resolvePackages(row.config);
          }
        };
        configureJobDelivery(plugins);
        resolvePackages(plugins);
        const scoped = profile.extend({ baseUrl: pathToFileURL(folder + '/').href });
        const dispose = await scoped.agentPresets.register({
          ...metadata,
          id: directory.name,
          plugins,
        });
        ctx.effect(() => dispose, `acp-extension-dsh.preset.${directory.name}`);
      } catch (error) {
        ctx.logger.warn(`user preset ${directory.name} is unavailable: ${errorChain(error)}`);
      }
    }
  }
}

/** Mount the ACP bridge into the surrounding Harness composition. */
export function apply(
  ctx: HarnessContext,
  rawConfig?: DeepSeekAcpAdapterConfig
): void | Promise<void> {
  if (rawConfig?.presetRoot) {
    const { presetRoot, ...config } = rawConfig;
    return registerBundledPresets(ctx, presetRoot, config.userPresetRoot).then(() =>
      apply(ctx, config)
    );
  }
  const config = resolveAdapterConfig(rawConfig);
  const projects = rawConfig?.projectMetadataRoot
    ? new ProjectMetadata(rawConfig.projectMetadataRoot)
    : undefined;
  const sessions = new Map<string, SessionRecord>();
  const readingHistory = new Set<string>();
  const activeMcpServerNames = new Set<string>();
  let closed = false;
  let legacyDefaultPreset: string | undefined;
  let conn: AgentSideConnection;
  let imagePromptEnabled = false;
  let questionCapabilities = { form: false, answerNotes: false };
  let subagentEvents = false;
  let carrierKeyOf: ((carrier: unknown) => unknown) | undefined;
  const subagentRuns = new Map<SessionRecord, LodySubagentEmitter>();
  type Child = {
    record: SessionRecord;
    runs: LodySubagentEmitter;
    nativeId: string;
    agent?: HarnessAgent;
    parent: HarnessAgent;
    tools?: ToolCallBridge;
    live: boolean;
    mirrors: Set<string>;
    task: LodySubagentTask;
    output: string;
  };
  const children = new Map<string, Child>();
  const childRuns = new Map<string, Child>();
  type ChildInfo = {
    id: string;
    runId: string;
    provider: string;
    local: boolean;
    stopReason?: string;
    lastAssistantMessage?: HarnessMessageBlock[];
  };

  if (ctx.permissionPresets.names.length === 0) {
    throw new Error('acp-extension-dsh: no permission presets are composed');
  }
  const llm = ctx.get('llm') as HarnessLlmCatalog | undefined;
  if (!llm) throw new Error('acp-extension-dsh: no Harness LLM catalog is mounted');
  type Job = {
    id: string;
    owner?: string;
    kind: string;
    label: string;
    status: string;
    startedAt: number;
    finishedAt?: number;
    detail?: string;
    progress?: string;
  };
  const jobs = ctx.get('jobs') as
    | {
        events: {
          subscribe(
            filter: { owners: 'all' },
            callback: (event: { type: string; job?: Job }) => void
          ): () => void;
        };
      }
    | undefined;
  const goals = ctx.get('goals') as GoalService<HarnessAgent> | undefined;
  const attachments = ctx.get('attachments') as HarnessAttachmentStore | undefined;
  const baseUrl = process.env[DEEPSEEK_HARNESS_BASE_URL_ENV]?.trim();
  const apiKey = process.env[DEEPSEEK_HARNESS_API_KEY_ENV]?.trim();
  let modelCatalog: Promise<HarnessModelCatalog> | undefined;
  const loadModelCatalog = () =>
    (modelCatalog ??= loadHarnessModels(
      llm,
      config.provider,
      config.model,
      baseUrl ? { baseUrl, ...(apiKey ? { apiKey } : {}) } : undefined
    ));

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed');
  };

  const requireSession = (sessionId: string): SessionRecord => {
    const record = sessions.get(sessionId);
    if (!record) throw invalidParams(`unknown session: ${sessionId}`);
    return record;
  };

  const ownedRecord = (agent: HarnessAgent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id);
    return record?.agent === agent ? record : undefined;
  };

  const notify = async (notification: SessionNotification): Promise<void> => {
    await conn.sessionUpdate(notification).catch((error: unknown) => {
      ctx.logger.warn(`acp-extension-dsh: session/update failed: ${String(error)}`);
    });
  };

  const enqueueOutput = (
    record: SessionRecord,
    work: () => Promise<void>,
    inflight?: InflightPrompt
  ): void => {
    record.outputTail = record.outputTail.then(work).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (inflight) inflight.outputError ??= failure;
      ctx.logger.warn(`acp-extension-dsh: assistant output failed: ${errorChain(error)}`);
    });
  };

  const enqueueNotification = (
    record: SessionRecord,
    notification: SessionNotification,
    inflight?: InflightPrompt
  ): void => enqueueOutput(record, () => notify(notification), inflight);

  if (jobs)
    ctx.effect(() => {
      const dispose = jobs.events.subscribe({ owners: 'all' }, (event) => {
        const job = event.job;
        if (!job?.owner || event.type === 'removed') return;
        const record = sessions.get(job.owner);
        if (!record) return;
        const status =
          job.status === 'running' || job.status === 'stopping'
            ? 'in_progress'
            : job.status === 'completed'
              ? 'completed'
              : 'failed';
        const task: LodyTaskMeta = {
          version: 1,
          kind: job.kind === 'subagent' ? 'subagent' : 'background',
          taskId: job.id,
          description: job.label,
          status,
          startedAtEpochSeconds: job.startedAt / 1000,
          ...(job.finishedAt === undefined ? {} : { endedAtEpochSeconds: job.finishedAt / 1000 }),
          ...(job.detail ? { summary: job.detail } : {}),
          skipTranscript: true,
        };
        enqueueNotification(record, {
          sessionId: job.owner,
          update: {
            sessionUpdate: event.type === 'registered' ? 'tool_call' : 'tool_call_update',
            toolCallId: `job:${job.id}`,
            title: job.progress ?? job.label,
            status,
            _meta: { lody: { task } },
          },
        });
      });
      return async () => {
        dispose();
      };
    }, 'acp-extension-dsh.jobs');

  ctx.on('subagent/start', function (this: unknown, info: ChildInfo) {
    if (!carrierKeyOf) return;
    const parent = carrierKeyOf(this) as HarnessAgent | undefined;
    if (!parent?.session) return;
    const parentChild = children.get(parent.session.id);
    const record =
      ownedRecord(parent) ??
      (parentChild?.live && parentChild.agent === parent ? parentChild.record : undefined);
    if (!record || children.get(info.id)?.nativeId === info.runId) return;
    let runs = subagentRuns.get(record);
    if (!runs) {
      runs = new LodySubagentEmitter(record.agent.session.id, (event) =>
        subagentEvents
          ? conn.extNotification(LODY_SUBAGENT_EVENT_METHOD, { ...event })
          : Promise.resolve()
      );
      subagentRuns.set(record, runs);
    }
    const emitter = runs;
    const previous = children.get(info.id);
    if (previous?.live) {
      previous.live = false;
      previous.task.status = 'lost';
      previous.task.endedAtEpochSeconds = Date.now() / 1000;
      enqueueOutput(record, () =>
        previous.runs.snapshot(previous.nativeId, {
          state: 'unknown',
          outputIncomplete: true,
          reason: { code: 'lost' },
        })
      );
    }
    const agent = info.local ? ctx.agents.get(info.id) : undefined;
    const child: Child = {
      record,
      runs: emitter,
      nativeId: info.runId,
      agent,
      parent,
      live: true,
      mirrors: new Set(),
      output: '',
      task: {
        taskId: info.runId,
        agentId: info.id,
        description: info.provider,
        status: 'running',
        startedAtEpochSeconds: Date.now() / 1000,
        endedAtEpochSeconds: null,
      },
    };
    if (agent)
      child.tools = new ToolCallBridge({
        cwd: record.cwd,
        lookup: (name) =>
          (
            agent.ctx.get('tools') as
              { get(name: string, scope: HarnessAgent): ToolPresenter | undefined } | undefined
          )?.get(name, agent),
        content: (block) => assistantBlockToAcp(block as HarnessMessageBlock, attachments),
        emit: async (update) => {
          await emitter.output(info.runId, update);
          const run = emitter.get(info.runId);
          if (
            run &&
            (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
            child.mirrors.has(update.toolCallId)
          )
            await notify({
              sessionId: record.agent.session.id,
              update: {
                ...update,
                toolCallId: `subagent:${encodeURIComponent(run.runId)}:${encodeURIComponent(update.toolCallId)}`,
                _meta: {
                  ...update._meta,
                  lody: { subagentRunId: run.runId, subagentToolCallId: update.toolCallId },
                },
              },
            });
        },
        warn: (message) => ctx.logger.warn(`acp-extension-dsh: ${message}`),
      });
    children.set(info.id, child);

    enqueueOutput(record, async () => {
      await emitter.start(info.runId, {
        state: 'running',
        name: info.provider,
        parentRunId: parentChild ? emitter.get(parentChild.nativeId)?.runId : null,
        support: {
          stream: agent ? ['text', 'thought', 'tool'] : [],
          progress: false,
          outputRead: agent ? 'live_tail' : 'final_tail',
          cancel: !!agent,
        },
      });
      child.task.taskId = emitter.get(info.runId)!.runId;
      childRuns.set(child.task.taskId, child);
    });
  });
  ctx.on('subagent/end', (info: ChildInfo) => {
    const child = children.get(info.id);
    if (!child?.live || child.nativeId !== info.runId) return;
    child.live = false;
    child.task.status =
      info.stopReason === 'completed'
        ? 'completed'
        : info.stopReason === 'aborted'
          ? 'killed'
          : info.stopReason === 'error' ||
              info.stopReason === 'max-tokens' ||
              info.stopReason === 'refusal'
            ? 'failed'
            : 'lost';
    child.task.endedAtEpochSeconds = Date.now() / 1000;
    child.task.stopReason = info.stopReason;
    if (!child.agent)
      child.output =
        info.lastAssistantMessage
          ?.flatMap((block) =>
            block.type === 'text' && 'text' in block ? [String(block.text)] : []
          )
          .join('\n') ?? '';
    child.output = child.output.slice(-100_000);
    enqueueOutput(child.record, async () => {
      await child.tools?.interrupt();
      await child.runs.snapshot(info.runId, {
        state:
          info.stopReason === 'completed'
            ? 'completed'
            : info.stopReason === 'aborted'
              ? 'cancelled'
              : ['error', 'max-tokens', 'refusal'].includes(info.stopReason ?? '')
                ? 'failed'
                : 'unknown',
        ...(!['completed', 'aborted', 'error', 'max-tokens', 'refusal'].includes(
          info.stopReason ?? ''
        )
          ? { outputIncomplete: true }
          : {}),
        summary: info.lastAssistantMessage
          ?.flatMap((block) =>
            block.type === 'text' && 'text' in block ? [String(block.text)] : []
          )
          .join('\n'),
      });
    });
  });

  const flushSession = async (session: HarnessSession): Promise<void> => {
    const store = ctx.get('sessions') as
      { flush(session: HarnessSession): Promise<boolean> } | undefined;
    if (!store || !(await store.flush(session)))
      throw new Error('no session durability listener is available');
  };

  ctx.on('goal/activation-changed', ({ sessionId }: { sessionId: string }) => {
    const record = sessions.get(sessionId);
    if (record)
      enqueueNotification(record, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { lody: { goal: goalSnapshot(goals?.get(record.agent)) } },
        },
      });
  });

  const pauseGoal = (record: SessionRecord) => {
    const goal = goals?.get(record.agent);
    if (goal?.phase === 'active') goals!.pause(record.agent, goal);
  };
  const waitForGoal = async (record: SessionRecord) => {
    for (;;) {
      await record.agent.whenIdle();
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const disposers = [
        ctx.on('goal/changed', ({ agent }: { agent: HarnessAgent }) => {
          if (agent === record.agent) wake();
        }),
        ctx.on('goal/activation-changed', ({ sessionId }: { sessionId: string }) => {
          if (sessionId === record.agent.id) wake();
        }),
        ctx.on('agent/status', ({ agent }: { agent: HarnessAgent }) => {
          if (agent === record.agent) wake();
        }),
      ];
      try {
        const goal = goals?.get(record.agent);
        if (
          record.inflight?.cancelRequested ||
          goal?.phase !== 'active' ||
          goal.activation !== 'armed'
        )
          return;
        await changed;
      } finally {
        for (const dispose of disposers) dispose();
      }
    }
  };

  const discardSteering = (record: SessionRecord) => {
    for (const [id, pending] of record.steering ?? []) {
      try {
        record.agent.inbox.remove(id);
      } catch (error) {
        ctx.logger.warn(`steering cleanup failed: ${errorChain(error)}`);
      }
      pending.resolve({ outcome: 'failed' });
    }
    record.steering?.clear();
  };

  const settleAfterQuiescence = (record: SessionRecord, inflight: InflightPrompt): void => {
    if (inflight.settlementStarted) return;
    inflight.settlementStarted = true;
    void (async () => {
      await inflight.admissionDone;
      if (inflight.messageQueued) {
        await waitForGoal(record);
        discardSteering(record);
        await record.outputTail;
        await record.tools.interrupt();
        // A fork can run in another ACP process: complete the prompt only
        // after its terminal native prefix is readable from persistence.
        await flushSession(record.agent.session);
      }
      if (record.inflight !== inflight) return;
      record.inflight = undefined;
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled');
      } else if (inflight.outputError) {
        inflight.reject(
          internalError(`assistant output delivery failed: ${inflight.outputError.message}`)
        );
      } else if (inflight.agentError) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`));
      } else if (inflight.endReason?.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${inflight.endReason.error.message}`));
      } else {
        const end = inflight.endReason;
        inflight.resolve(
          end ? (end.kind === 'interrupted' ? 'cancelled' : 'end_turn') : 'cancelled'
        );
      }
    })().catch((error: unknown) => {
      if (record.inflight !== inflight) return;
      record.inflight = undefined;
      discardSteering(record);
      inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`));
    });
  };

  const refreshPermissionState = (record: SessionRecord): boolean => {
    const permissionMode = ctx.permissionPresets.current(record.agent.session);
    if (permissionMode === record.permissionMode) return false;
    record.permissionMode = permissionMode;
    record.permissionOptions = permissionState(ctx, permissionMode);
    return true;
  };

  const schedulePermissionSync = (record: SessionRecord): void => {
    if (record.permissionSyncQueued) return;
    record.permissionSyncQueued = true;
    queueMicrotask(() => {
      record.permissionSyncQueued = false;
      if (sessions.get(record.agent.session.id) !== record) return;
      try {
        if (!refreshPermissionState(record)) return;
        enqueueNotification(record, {
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: record.permissionMode,
          },
        });
        enqueueNotification(record, {
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: configOptions(record),
          },
        });
      } catch (error: unknown) {
        ctx.logger.warn(
          `acp-extension-dsh: failed to synchronize permission state: ${errorChain(error)}`
        );
      }
    });
  };

  const disposeRecords = async (records: readonly SessionRecord[]): Promise<void> => {
    await Promise.all(
      records.map(async (record) => {
        await record.inflight?.admissionDone;
        await record.agent.whenIdle();
        await record.outputTail;
      })
    );
    const subagents = ctx.get('subagents') as ContinuableDrain | undefined;
    if (subagents) {
      try {
        await subagents.drainContinuableDescendants(records.map((record) => record.agent));
      } catch (error: unknown) {
        ctx.logger.warn(
          `acp-extension-dsh: continuable subagent teardown failed: ${String(error)}`
        );
      }
    }
    const results = await Promise.allSettled(records.map((record) => record.dispose()));
    await Promise.all(records.map((record) => record.outputTail));
    const disposed = new Set(records);
    for (const [id, child] of childRuns) if (disposed.has(child.record)) childRuns.delete(id);
    for (const [id, child] of children) if (disposed.has(child.record)) children.delete(id);
    for (const record of records) subagentRuns.delete(record);

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `DeepSeek ACP teardown failed for ${failures.length} session(s): ${failures
          .map(errorChain)
          .join('; ')}`
      );
    }
  };

  ctx.on(
    'agent/assistant-stream',
    ({ agent, frame }: { agent: HarnessAgent; frame: HarnessAssistantStreamFrame }) => {
      const child = children.get(agent.session.id);
      if (
        child?.live &&
        child.agent === agent &&
        frame.type === 'chunk' &&
        frame.chunk?.type === 'reasoning-delta' &&
        frame.chunk.text
      ) {
        const text = frame.chunk.text;
        enqueueOutput(child.record, () =>
          child.runs.output(child.nativeId, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text },
          })
        );
        return;
      }
      const record = ownedRecord(agent);
      if (!record || frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (!chunk) return;
      if (
        chunk.type === 'reasoning-delta' &&
        typeof chunk.text === 'string' &&
        chunk.text.length > 0
      ) {
        enqueueNotification(record, {
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: chunk.text },
          },
        });
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning') {
        enqueueNotification(record, {
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: '\n\n' },
          },
        });
      }
    }
  );

  ctx.on('session/event', (session: HarnessSession, event: HarnessSessionEvent) => {
    const child = children.get(session.id);
    if (child?.agent?.session === session) {
      if (!child.live) return;
      enqueueOutput(child.record, async () => {
        if (event.type.startsWith('tool/') || event.type === 'turn/end')
          await child.tools?.event(event.type, event.data);
        if (event.type === 'assistant/message')
          for (const block of event.data.message?.content ?? []) {
            if (block.type === 'text' && 'text' in block)
              child.output = (child.output + String(block.text) + '\n').slice(-100_000);
            const content = await assistantBlockToAcp(block, attachments);
            await child.runs.output(
              child.nativeId,
              content ? { sessionUpdate: 'agent_message_chunk', content } : null,
              { nativeTurnId: event.data.turn == null ? undefined : String(event.data.turn) }
            );
          }
      });
      return;
    }
    const record = sessions.get(session.header.id);
    if (!record || record.agent.session !== session) return;
    if (event.type === 'request/context') record.contextWindow = event.data.contextWindow;
    if (
      ['request/context', 'assistant/message', 'compaction/end'].includes(event.type) &&
      record.contextWindow &&
      record.contextWindow > 0
    ) {
      const meter = ctx.get('tokenMeter') as
        { measure(session: HarnessSession): { totalTokens: number } } | undefined;
      if (meter) {
        const used = meter.measure(session).totalTokens;
        if (Number.isFinite(used) && used >= 0)
          enqueueNotification(record, {
            sessionId: session.id,
            update: {
              sessionUpdate: 'usage_update',
              used: Math.ceil(used),
              size: record.contextWindow,
            },
          });
      }
    }
    if (event.type === 'llm/retry' && event.data.retryId) {
      (record.retries ??= new Set()).add(event.data.retryId);
      enqueueNotification(record, {
        sessionId: session.id,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: `retry:${event.data.retryId}`,
          title: 'Waiting to retry model request',
          kind: 'think',
          status: 'in_progress',
          _meta: { lody: { activity: { version: 1, kind: 'retry', automatic: true } } },
        },
      });
    }
    if (event.type === 'llm/retry-started' || event.type === 'turn/end') {
      for (const id of record.retries ?? []) {
        if (event.type !== 'turn/end' && id !== event.data.retryId) continue;
        const failed = event.type === 'turn/end';
        enqueueNotification(record, {
          sessionId: session.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `retry:${id}`,
            status: failed ? 'failed' : 'completed',
            _meta: {
              lody: {
                activity: {
                  version: 1,
                  kind: 'retry',
                  automatic: true,
                  ...(failed ? { failureReason: 'Turn ended before retry' } : {}),
                },
              },
            },
          },
        });
        record.retries!.delete(id);
      }
    }
    if (event.type === 'user/message') {
      const id = (event.data as Record<string, unknown>).id;
      const pending = typeof id === 'string' ? record.steering?.get(id) : undefined;
      if (pending) {
        record.steering!.delete(id as string);
        enqueueOutput(record, async () => {
          try {
            await conn.extNotification(LODY_EXTENSION_METHODS.sessionSteerApplied, {
              sessionId: session.id,
              steerId: pending.steerId,
            });
          } finally {
            pending.resolve({ outcome: 'injected' });
          }
        });
      }
    }
    if (event.type === 'goal/change')
      enqueueNotification(record, {
        sessionId: session.id,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { lody: { goal: goalSnapshot(goals?.get(record.agent)) } },
        },
      });
    if (event.type === 'session/title' && typeof event.data.title === 'string') {
      const source = event.data.source?.kind;
      const titleSource: LodySessionMeta['titleSource'] =
        source === 'provider' ? 'generated' : source === 'user' ? 'explicit' : 'fallback';
      enqueueNotification(record, {
        sessionId: session.id,
        update: {
          sessionUpdate: 'session_info_update',
          title: event.data.title,
          _meta: { lody: { titleSource } },
        },
      });
    }
    if (event.type.startsWith('tool/') || event.type === 'turn/end') {
      enqueueOutput(record, () => record.tools.event(event.type, event.data), record.inflight);
    }
    if (event.type === 'plan/mode') {
      enqueueNotification(record, {
        sessionId: record.agent.session.id,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: configOptions(record),
        },
      });
    }
    if (PERMISSION_EVENT_TYPES.has(event.type)) schedulePermissionSync(record);
    try {
      if (event.type === 'request/context' && event.data.provider && event.data.model) {
        record.usage.setRoute(event.data.provider, event.data.model);
      }
      if (event.type === 'assistant/message' && event.data.usage && event.seq !== undefined) {
        const update = record.usage.record(
          session.id,
          event.seq,
          event.time ?? NaN,
          event.data.usage
        );
        if (update)
          enqueueOutput(
            record,
            () =>
              conn.extNotification(
                LODY_EXTENSION_METHODS.sessionUsageUpdate,
                update as unknown as Record<string, unknown>
              ),
            record.inflight
          );
      }
      if (event.type === 'assistant/message') {
        const inflight = record.inflight?.turn === event.data.turn ? record.inflight : undefined;
        enqueueOutput(
          record,
          async () => {
            for (const block of event.data.message?.content ?? []) {
              const content = await assistantBlockToAcp(block, attachments);
              if (!content) continue;
              await notify({
                sessionId: record.agent.session.id,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content,
                  ...(typeof event.data.turn === 'number'
                    ? { _meta: { lody: { turnId: nativeTurnId(event.data.turn) } } }
                    : {}),
                },
              });
            }
          },
          inflight
        );
      } else if (event.type === 'compaction/start' && event.data.compactionId) {
        const activity = {
          version: 1,
          kind: 'context_compaction',
          automatic: event.data.turn !== null,
        } as const satisfies LodyActivityMeta;
        enqueueNotification(record, {
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `context-compaction:${event.data.compactionId}`,
            title: 'Compacting context',
            kind: 'think',
            status: 'in_progress',
            _meta: { lody: { activity } },
          },
        });
      } else if (event.type === 'compaction/end' && event.data.compactionId) {
        const activity = {
          version: 1,
          kind: 'context_compaction',
          automatic: event.data.turn !== null,
          ...(event.data.error ? { failureReason: event.data.error } : {}),
        } as const satisfies LodyActivityMeta;
        enqueueNotification(record, {
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `context-compaction:${event.data.compactionId}`,
            title: event.data.error ? 'Context compaction failed' : 'Context compacted',
            status: event.data.error ? 'failed' : 'completed',
            _meta: { lody: { activity } },
          },
        });
      }
    } finally {
      const inflight = record.inflight;
      if (
        inflight &&
        event.type === 'turn/end' &&
        inflight.turn === event.data.turn &&
        event.data.reason
      ) {
        inflight.endReason = event.data.reason;
      }
    }
  });

  ctx.on(
    'agent/pre-step',
    async (
      { agent, turn }: { agent: HarnessAgent; turn: number },
      next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: HarnessUserMessage[] }>
    ) => {
      const record = ownedRecord(agent);
      if (record && (!record.inflight || record.inflight.cancelRequested))
        return { kind: 'reject' };
      const decision = await next();
      if (!record || decision.kind !== 'enter') return decision;
      const messages = decision.messages.filter((message) => {
        const pending = record.steering?.get(message.id);
        if (!pending || pending.turn === turn) return true;
        record.steering!.delete(message.id);
        pending.resolve({ outcome: 'failed' });
        return false;
      });
      return { ...decision, messages };
    }
  );

  ctx.on(
    'agent/inbox/claimed',
    ({
      agent,
      message,
      turn,
    }: {
      agent: HarnessAgent;
      message: { id: string; source?: { kind: string } };
      turn: number;
    }) => {
      const record = ownedRecord(agent);
      const inflight = record?.inflight;
      if (
        record &&
        inflight &&
        (inflight.messageId === message.id || message.source?.kind === 'goal')
      ) {
        inflight.turn = turn;
        inflight.endReason = undefined;
        enqueueNotification(
          record,
          {
            sessionId: agent.session.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '' },
              _meta: { lody: { turnId: nativeTurnId(turn) } },
            },
          },
          inflight
        );
      }
    }
  );

  ctx.on(
    'agent/error',
    ({ agent, turn, error }: { agent: HarnessAgent; turn: number; error: unknown }) => {
      const record = ownedRecord(agent);
      const inflight = record?.inflight;
      if (!record || !inflight || !inflight.messageQueued || inflight.turn !== turn) return;
      inflight.agentError = new Error(errorChain(error));
      settleAfterQuiescence(record, inflight);
    }
  );

  ctx.on(
    'approval/request',
    (
      request: { agent: HarnessAgent; callId?: string },
      next: () => Promise<unknown>
    ): Promise<unknown> | undefined => {
      const record = ownedRecord(request.agent);
      const callId = request.callId;
      const child = children.get(request.agent.session.id);
      if (!record && child?.live && child.agent === request.agent && callId) {
        return child.record.outputTail.then(async () => {
          const run = child.runs.get(child.nativeId);
          if (!run || !child.runs.live(child.nativeId)) return 'cancelled';
          child.mirrors.add(callId);
          const { outcome } = await conn.requestPermission({
            sessionId: child.record.agent.session.id,
            toolCall: {
              ...child.tools?.permission(callId),
              toolCallId: `subagent:${encodeURIComponent(run.runId)}:${encodeURIComponent(callId)}`,
            },
            _meta: { lody: { subagentRunId: run.runId, subagentToolCallId: callId } },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          });
          return outcome.outcome === 'cancelled'
            ? 'cancelled'
            : outcome.optionId === 'allow-once'
              ? 'allowed-once'
              : 'rejected';
        });
      }
      if (!record || !callId) return next();
      return record.outputTail.then(() =>
        conn
          .requestPermission({
            sessionId: record.agent.session.id,
            toolCall: record.tools.permission(callId) ?? { toolCallId: callId },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          })
          .then(({ outcome }) => {
            if (outcome.outcome === 'cancelled') return 'cancelled';
            return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected';
          })
      );
    }
  );

  const setPermissionMode = (record: SessionRecord, modeId: string): void => {
    if (modeId === record.permissionMode) return;
    assertAllowed(modeId, new Set(ctx.permissionPresets.names), 'permission mode');
    ctx.permissionPresets.set(record.agent.session, modeId);
    const permissionMode = ctx.permissionPresets.current(record.agent.session);
    if (permissionMode !== modeId) {
      throw internalError(
        `permission preset ${JSON.stringify(modeId)} did not become the effective mode`
      );
    }
    record.permissionMode = permissionMode;
    record.permissionOptions = permissionState(ctx, permissionMode);
  };

  const setConfigOption = (
    record: SessionRecord,
    params: SetSessionConfigOptionRequest
  ): SetSessionConfigOptionResponse | Promise<SetSessionConfigOptionResponse> => {
    if (params.configId === LODY_PLAN_MODE_CONFIG_ID) {
      const plan = planModeService(record);
      if (!plan || typeof params.value !== 'boolean') {
        throw invalidParams('Plan mode requires a supported Agent preset and a boolean value');
      }
      plan.set(record.agent, params.value);
      return { configOptions: configOptions(record) };
    }
    const value = requireSelectValue(params);
    if (params.configId === MODE_CONFIG_ID) {
      setPermissionMode(record, value);
    } else if (params.configId === AGENT_PRESET_CONFIG_ID) {
      const available = new Set(record.agentPresetOptions.map((preset) => preset.id));
      assertAllowed(value, available, 'agent preset');
      if (value === record.agentPreset) return { configOptions: configOptions(record) };
      if (record.started) {
        throw invalidParams('agent preset is fixed after the session has started');
      }
      return ctx.agentPresets
        .select(record.agent, value)
        .then((selectedPreset) => {
          record.agentPreset = selectedPreset;
          return { configOptions: configOptions(record) };
        })
        .catch((error: unknown) => {
          if (error instanceof RequestError) throw error;
          throw invalidParams(
            `failed to select agent preset ${JSON.stringify(value)}: ${errorChain(error)}`
          );
        });
    } else if (params.configId === MODEL_CONFIG_ID) {
      const selected = decodeAcpModelId(value, record.selection.current.provider);
      return resolveHarnessModel(llm, selected.provider, selected.model)
        .then((model) => {
          const index = record.models.findIndex(
            (candidate) =>
              candidate.provider === selected.provider && candidate.id === selected.model
          );
          if (index === -1) record.models.push(model);
          else record.models[index] = model;
          const reasoningEffort = resolveReasoningEffort(
            model,
            record.selection.current.reasoningEffort &&
              model.reasoning?.efforts.some(
                (effort) => effort.id === record.selection.current.reasoningEffort
              )
              ? record.selection.current.reasoningEffort
              : undefined
          );
          record.selection.current = {
            provider: selected.provider,
            model: selected.model,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          };
          record.agent.session.append('model/selection', record.selection.current);
          return flushSession(record.agent.session).then(() => ({
            configOptions: configOptions(record),
          }));
        })
        .catch((error: unknown) => {
          if (error instanceof RequestError) throw error;
          throw invalidParams(
            `failed to resolve model route ${JSON.stringify(selected.provider)} / ${JSON.stringify(selected.model)}: ${errorChain(error)}`
          );
        });
    } else if (params.configId === REASONING_EFFORT_CONFIG_ID) {
      const model = selectedModel(record);
      if (!model) throw internalError('selected model metadata is unavailable');
      const reasoningEffort = resolveReasoningEffort(model, value);
      if (!reasoningEffort) {
        throw invalidParams(`model ${JSON.stringify(model.id)} has no reasoning selector`);
      }
      record.selection.current = {
        ...record.selection.current,
        reasoningEffort,
      };
      record.agent.session.append('model/selection', record.selection.current);
      return flushSession(record.agent.session).then(() => ({
        configOptions: configOptions(record),
      }));
    } else {
      throw invalidParams(`unknown config option: ${params.configId}`);
    }
    return { configOptions: configOptions(record) };
  };

  const createSession = async (
    params: NewSessionRequest,
    fork?: ForkSnapshot,
    restore?: { sessionId: string; replay: boolean }
  ): Promise<NewSessionResponseWithModels> => {
    assertOpen();
    validateSessionParams(params);
    const projectInput = (params._meta?.lody as LodySessionMeta | undefined)?.worktreeProject;
    if (projectInput && !projects) throw invalidParams('worktreeProject is unavailable');
    const project =
      (await projects?.validate(projectInput)) ??
      (fork ? await projects?.read(fork.sourceId) : undefined);
    let catalog: HarnessModelCatalog;
    try {
      catalog = await loadModelCatalog();
    } catch (error: unknown) {
      throw internalError(`failed to discover models: ${errorChain(error)}`);
    }
    const models = [...catalog.models];
    const initialSelection = fork?.selection ?? catalog.initialSelection;
    if (fork?.selection) {
      const model = await resolveHarnessModel(
        llm,
        initialSelection.provider,
        initialSelection.model
      );
      const index = models.findIndex(
        (candidate) => candidate.provider === model.provider && candidate.id === model.id
      );
      if (index < 0) models.push(model);
      else models[index] = model;
    }
    const sessionId = restore?.sessionId ?? randomUUID();
    const questions = new UserQuestionBridge(
      sessionId,
      (request) => conn.unstable_createElicitation(request),
      () => questionCapabilities
    );
    const initialModel = models.find(
      (model) => model.provider === initialSelection.provider && model.id === initialSelection.model
    );
    if (!initialModel) throw internalError('initial model metadata is unavailable');
    const reasoningEffort = resolveReasoningEffort(
      initialModel,
      fork?.selection ? fork.selection.reasoningEffort : config.reasoningEffort
    );
    const selection: ModelSelectionRef = {
      current: {
        provider: initialSelection.provider,
        model: initialSelection.model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    };
    const presetRoster = await ctx.agentPresets.list();
    const agentPresetOptions = presetRoster.filter((preset) => preset.broken === undefined);
    let requestedPreset = fork?.agentPreset ?? legacyDefaultPreset ?? ctx.agentPresets.defaultId;
    let restoredEvents: ForkSnapshot['seed'] = [];
    if (
      !restore &&
      !fork &&
      !agentPresetOptions.some((preset) => preset.id === requestedPreset) &&
      agentPresetOptions.some((preset) => preset.id === 'standard')
    ) {
      ctx.logger.warn(
        `default agent preset ${JSON.stringify(requestedPreset)} is unavailable; using standard`
      );
      requestedPreset = 'standard';
    }
    if (!restore && !agentPresetOptions.some((preset) => preset.id === requestedPreset)) {
      throw internalError(
        `default agent preset ${JSON.stringify(requestedPreset)} is unavailable: ${presetRoster.find((preset) => preset.id === requestedPreset)?.broken ?? 'not registered'}`
      );
    }
    const mcpServerNames = reserveMcpServerNames(
      params.mcpServers,
      sessionId,
      activeMcpServerNames
    );
    let mountedPreset = requestedPreset;
    let handle: HarnessAgentHandle;
    try {
      const setup = async (agentContext: HarnessAgentContext, restoredAgent?: HarnessAgent) => {
        if (restore) {
          if (!restoredAgent || restoredAgent.session.id !== sessionId)
            throw internalError('native resume returned a different session');
          const session = restoredAgent.session;
          if (session.header.origin === 'subagent')
            throw invalidParams('subagent sessions cannot be resumed as ACP root sessions');
          if (session.header.cwd !== params.cwd)
            throw invalidParams('resume cwd must match the persisted session cwd');
          // Inspect the repaired log under the native writer claim, not a stale query snapshot.
          restoredEvents = structuredClone(session.snapshotEvents());
          requestedPreset =
            ([...restoredEvents]
              .reverse()
              .find(
                (event) =>
                  event.type === 'agent-preset/selected' &&
                  typeof event.data.agentPreset === 'string'
              )?.data.agentPreset as string | undefined) ??
            session.header.agentPreset ??
            ctx.agentPresets.defaultId;
          if (!agentPresetOptions.some((preset) => preset.id === requestedPreset))
            throw invalidParams('persisted agent preset is unavailable');
          const restoredModel = restoredSelection(restoredEvents);
          if (restoredModel) {
            const model = await resolveHarnessModel(
              llm,
              restoredModel.provider,
              restoredModel.model
            );
            const index = models.findIndex(
              (candidate) => candidate.provider === model.provider && candidate.id === model.id
            );
            if (index < 0) models.push(model);
            else models[index] = model;
            selection.current = restoredModel;
            if (restoredModel.reasoningEffort)
              resolveReasoningEffort(model, restoredModel.reasoningEffort);
          }
        }
        if ((subagentEvents || ctx.get('subagents')) && !carrierKeyOf) {
          const scope = (await agentContext.loader.import('@deepseek-ai/dsh-scope')) as {
            carrierKeyOf?: (carrier: unknown) => unknown;
          };
          if (typeof scope.carrierKeyOf !== 'function')
            throw new Error('Harness scope identity API is unavailable');
          carrierKeyOf = scope.carrierKeyOf;
        }
        installModelSelection(agentContext, selection);
        agentContext.on(
          'user-questions/request',
          (
            request: HarnessQuestionRequest & { agent?: HarnessAgent },
            next: () => Promise<HarnessQuestionAnswer>
          ) => {
            // Harness userQuestions.ask owns exact-live/root validation. Only
            // claim this ACP session's Agent; never answer unowned callers.
            if (!request.agent || ownedRecord(request.agent)?.questions !== questions)
              return next();
            return questions.ask(request);
          }
        );
        mountedPreset = (await ctx.agentPresets.mount(agentContext, requestedPreset)).id;
        await mountMcpServers(agentContext, params.mcpServers, mcpServerNames.names, params.cwd);
      };
      handle = restore
        ? await ctx.agents.resume({ resumeSessionId: sessionId, setup })
        : await ctx.agents.create({
            sessionId,
            meta: {
              cwd: params.cwd,
              agentPreset: requestedPreset,
              ...(fork ? { parentSession: fork.sourceId, isSeeded: true } : {}),
            },
            ...(fork ? { seed: fork.seed, inheritedEventCount: fork.seed.length } : {}),
            agentOptions: { provider: initialSelection.provider, model: initialSelection.model },
            setup,
          });
    } catch (error: unknown) {
      mcpServerNames.release();
      if (error instanceof RequestError) throw error;
      throw internalError(
        `failed to ${restore ? 'resume' : 'create'} session: ${errorChain(error)}`
      );
    }
    const dispose = async (): Promise<void> => {
      questions.cancel();
      try {
        await handle.dispose();
      } finally {
        mcpServerNames.release();
      }
    };
    if (closed) {
      await dispose();
      throw internalError('connection closed during session establishment');
    }
    let permissionMode: string;
    let permissionOptions: HarnessPermissionOption[];
    try {
      permissionMode = ctx.permissionPresets.current(handle.agent.session);
      permissionOptions = permissionState(ctx, permissionMode);
    } catch (error: unknown) {
      await dispose();
      throw error;
    }
    const record: SessionRecord = {
      cwd: params.cwd,
      tools: new ToolCallBridge({
        cwd: params.cwd,
        lookup: (name) => {
          const tools = handle.agent.ctx.get('tools') as
            { get(name: string, scope: HarnessAgent): ToolPresenter | undefined } | undefined;
          return tools?.get(name, handle.agent);
        },
        content: (block) => assistantBlockToAcp(block as HarnessMessageBlock, attachments),
        emit: (update) =>
          restore?.replay && !sessions.has(sessionId)
            ? conn.sessionUpdate({ sessionId, update })
            : notify({ sessionId, update }),
        warn: (message) => ctx.logger.warn(`acp-extension-dsh: ${message}`),
      }),
      questions,
      usage: new HarnessUsageTracker(!baseUrl || isDeepSeekOfficialBaseUrl(baseUrl)),
      agent: handle.agent,
      dispose,
      selection,
      permissionMode,
      permissionOptions,
      agentPreset: mountedPreset,
      agentPresetOptions,
      models,
      started:
        (restore ? restoredEvents : fork?.seed)?.some((event) => event.type === 'turn/start') ??
        false,
      outputTail: Promise.resolve(),
    };
    if (!restore) {
      try {
        if (!fork) handle.agent.session.append('model/selection', selection.current);
        await flushSession(handle.agent.session);
        assertOpen();
      } catch (error: unknown) {
        let cleanupError: unknown;
        try {
          await dispose();
        } catch (failure: unknown) {
          cleanupError = failure;
        }
        throw internalError(
          `${fork ? 'fork child' : 'session'} ${sessionId} could not be committed: ${errorChain(error)}${cleanupError ? `; cleanup: ${errorChain(cleanupError)}` : ''}`
        );
      }
    }
    if (restore) {
      try {
        await replaySessionHistory(restoredEvents, {
          sessionId,
          replay: restore.replay,
          tools: record.tools,
          usage: record.usage,
          content: (block) => assistantBlockToAcp(block as HarnessMessageBlock, attachments),
          emit: async (update) => {
            await conn.sessionUpdate({ sessionId, update });
          },
        });
        assertOpen();
      } catch (error: unknown) {
        await dispose();
        throw internalError(`failed to restore session history: ${errorChain(error)}`);
      }
    }
    if (project && projects) {
      try {
        await projects.write(sessionId, project);
      } catch (error) {
        await dispose();
        throw error;
      }
    }
    sessions.set(sessionId, record);
    if (goals) {
      enqueueNotification(record, {
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { lody: { goal: goalSnapshot(goals.get(record.agent)) } },
        },
      });
      await record.outputTail;
    }
    return {
      sessionId,
      modes: modeState(record),
      configOptions: configOptions(record),
      models: legacyModels(record),
    };
  };

  const restoring = new Set<string>();
  const restoreSession = async (
    params: LoadSessionRequest | ResumeSessionRequest,
    replay: boolean
  ) => {
    assertOpen();
    if (
      sessions.has(params.sessionId) ||
      restoring.has(params.sessionId) ||
      readingHistory.has(params.sessionId) ||
      ctx.agents.get(params.sessionId)
    )
      throw invalidParams('session is already active or being restored');
    restoring.add(params.sessionId);
    try {
      const { sessionId: _sessionId, ...response } = await createSession(
        { ...params, mcpServers: params.mcpServers ?? [] },
        undefined,
        { sessionId: params.sessionId, replay }
      );
      return response;
    } finally {
      restoring.delete(params.sessionId);
    }
  };

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection;
    return {
      async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        // Preset declarations and provider configuration activate independently of
        // the registry service. Do not answer the first request before they settle.
        const loader = ctx.get('loader') as { await(): Promise<void> } | undefined;
        await loader?.await();
        if (rawConfig?.settingsPath) {
          let source: string | undefined;
          try {
            source = await readFile(rawConfig.settingsPath, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (source !== undefined) {
            const importer = ctx.get('loader') as { import(name: string): Promise<unknown> };
            const yaml = (await importer.import('js-yaml')) as { load(text: string): unknown };
            try {
              const document = yaml.load(source) ?? {};
              if (typeof document !== 'object' || Array.isArray(document))
                throw new Error('expected a mapping');
              for (const namespace of ['llm-deepseek', 'llm-pi-ai', 'agent-presets']) {
                const section = (document as Record<string, unknown>)[namespace];
                if (section != null && (typeof section !== 'object' || Array.isArray(section)))
                  throw new Error(`${namespace} must be a mapping`);
              }
              const defaultPreset = (
                (document as Record<string, unknown>)['agent-presets'] as
                  { default?: unknown } | undefined
              )?.default;
              if (
                defaultPreset !== undefined &&
                (typeof defaultPreset !== 'string' || !defaultPreset.trim())
              )
                throw new Error('invalid default preset');
              legacyDefaultPreset = defaultPreset as string | undefined;
            } catch {
              throw invalidParams(
                'settings.yaml is invalid; expected YAML model configuration mappings'
              );
            }
          }
        }
        subagentEvents = supportsLodySubagentEvents(_params.clientCapabilities);
        const elicitation = _params.clientCapabilities?._meta?.lody;
        const notes =
          elicitation &&
          typeof elicitation === 'object' &&
          !Array.isArray(elicitation) &&
          'elicitation' in elicitation
            ? elicitation.elicitation
            : undefined;
        questionCapabilities = {
          form: _params.clientCapabilities?.elicitation?.form != null,
          answerNotes:
            !!notes &&
            typeof notes === 'object' &&
            !Array.isArray(notes) &&
            'version' in notes &&
            notes.version === 1 &&
            'answerNotes' in notes &&
            notes.answerNotes === true,
        };
        const { models } = await loadModelCatalog();
        imagePromptEnabled = supportsAcpImagePrompts(attachments, models);
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: {
            name: 'acp-extension-dsh',
            version: ACP_EXTENSION_DSH_VERSION,
          },
          agentCapabilities: {
            promptCapabilities: {
              image: imagePromptEnabled,
              audio: false,
              embeddedContext: false,
            },
            mcpCapabilities: { http: true },
            loadSession: true,
            sessionCapabilities: { close: {}, fork: {}, resume: {}, list: {} },
            _meta: {
              lody: {
                ...LODY_CAPABILITIES,
                ...(projects ? { worktreeProject: { version: 1 } } : {}),
                ...(jobs ? { tasks: { version: 1, background: true } } : {}),
                ...(goals
                  ? {
                      goal: {
                        version: 1,
                        actions: ['set', 'pause', 'resume', 'clear'],
                        controlActions: ['pause', 'clear'],
                        promptActions: ['set', 'resume'],
                      },
                    }
                  : {}),
              },
            },
          },
          authMethods: [],
        };
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve();
      },

      newSession(params: NewSessionRequest): Promise<NewSessionResponseWithModels> {
        return createSession(params);
      },

      loadSession(params: LoadSessionRequest) {
        return restoreSession(params, true);
      },

      resumeSession(params: ResumeSessionRequest) {
        return restoreSession(params, false);
      },

      async listSessions(params: ListSessionsRequest) {
        assertOpen();
        if (params.cursor) throw invalidParams('session/list cursor is unsupported');
        const query = ctx.get('sessionQuery') as {
          listSessions(): Promise<Array<{ header: { id: string; cwd?: string; origin?: string } }>>;
        };
        const rows = await query.listSessions();
        const result = [];
        for (const { header } of rows) {
          if (header.origin === 'subagent' || !header.cwd) continue;
          const project = await projects?.read(header.id);
          if (params.cwd && params.cwd !== header.cwd && params.cwd !== project?.originProjectPath)
            continue;
          result.push({
            sessionId: header.id,
            cwd: header.cwd,
            ...(project ? { _meta: { lody: { worktreeProject: project } } } : {}),
          });
        }
        return { sessions: result };
      },

      async extMethod(method, params) {
        assertOpen();
        const methodName = normalizeLodyExtensionMethod(method);
        const sessionId = params.sessionId;
        if (typeof sessionId !== 'string' || !sessionId)
          throw invalidParams('sessionId is required');
        if (methodName === LODY_EXTENSION_METHODS.sessionGoal) {
          const record = requireSession(sessionId);
          if (!goals) throw invalidParams('goals are unavailable');
          if (params.action !== 'pause' && params.action !== 'clear')
            throw invalidParams('set/resume require session/prompt goalControl');
          const goal = goals.get(record.agent);
          if (goal) {
            if (params.action === 'pause') pauseGoal(record);
            else goals.clear(record.agent, goal);
          }
          await flushSession(record.agent.session);
          await record.outputTail;
          return { goal: goalSnapshot(goals.get(record.agent)) };
        }
        if (methodName === LODY_EXTENSION_METHODS.sessionSteer) {
          const record = requireSession(sessionId);
          if (
            typeof params.steerId !== 'string' ||
            !params.steerId ||
            !Array.isArray(params.prompt)
          )
            throw invalidParams('invalid steering request');
          const inflight = record.inflight;
          if (
            !inflight ||
            inflight.cancelRequested ||
            inflight.turn === undefined ||
            inflight.endReason ||
            record.agent.status !== 'running'
          )
            return { outcome: 'failed' };
          const nativeTurn = inflight.turn;
          const content = await admitAcpPrompt(
            params.prompt as ContentBlock[],
            llm,
            record.selection.assembled ?? record.selection.current,
            attachments,
            imagePromptEnabled,
            inflight.admissionController.signal
          );
          if (
            record.inflight !== inflight ||
            inflight.turn !== nativeTurn ||
            inflight.cancelRequested ||
            inflight.endReason ||
            record.agent.status !== 'running'
          )
            return { outcome: 'failed' };
          record.steering ??= new Map();
          if ([...record.steering.values()].some((value) => value.steerId === params.steerId))
            throw invalidParams('duplicate steerId');
          const id = randomUUID();
          return new Promise<{ outcome: 'injected' | 'failed' }>((resolve, reject) => {
            record.steering!.set(id, {
              steerId: params.steerId as string,
              turn: inflight.turn!,
              resolve,
            });
            try {
              record.agent.inject(createUserMessage(id, content));
            } catch (error) {
              record.steering!.delete(id);
              reject(error);
            }
          });
        }
        if (methodName === LODY_EXTENSION_METHODS.sessionHistoryRead) {
          if (sessions.has(sessionId) || restoring.has(sessionId) || readingHistory.has(sessionId))
            throw invalidParams('history reader cannot replay an activated session');
          const query = ctx.get('sessionQuery') as {
            observeSession(
              id: string
            ): Promise<ForkObservation & { header: { cwd?: string; origin?: string } }>;
          };
          readingHistory.add(sessionId);
          const observation = await query.observeSession(sessionId).catch((error) => {
            readingHistory.delete(sessionId);
            throw error;
          });
          try {
            if (
              observation.header.id !== sessionId ||
              observation.header.origin === 'subagent' ||
              !observation.header.cwd
            )
              throw invalidParams('not a root session');
            const emit = async (update: SessionNotification['update']) => {
              await conn.sessionUpdate({ sessionId, update });
            };
            const content = (block: { type: string }) =>
              assistantBlockToAcp(block as HarnessMessageBlock, attachments);
            const tools = new ToolCallBridge({
              cwd: observation.header.cwd,
              lookup: () => undefined,
              content,
              emit,
              warn: (message) => ctx.logger.warn(message),
            });
            await replaySessionHistory(observation.events, {
              sessionId,
              replay: true,
              tools,
              usage: new HarnessUsageTracker(false),
              content,
              emit,
            });
            await tools.interrupt();
            return {};
          } finally {
            observation[Symbol.dispose]();
            readingHistory.delete(sessionId);
          }
        }
        if (
          methodName === LODY_EXTENSION_METHODS.subagentsList ||
          methodName === LODY_EXTENSION_METHODS.subagentsOutput ||
          methodName === LODY_EXTENSION_METHODS.subagentsCancel
        ) {
          const record = requireSession(sessionId);
          await record.outputTail;
          if (methodName === LODY_EXTENSION_METHODS.subagentsList) {
            if (params.activeOnly !== undefined && typeof params.activeOnly !== 'boolean')
              throw invalidParams('activeOnly must be boolean');
            return {
              tasks: [...childRuns.values()]
                .filter((child) => child.record === record && (!params.activeOnly || child.live))
                .map((child) => ({ ...child.task })),
            };
          }
          const child =
            typeof params.taskId === 'string' ? childRuns.get(params.taskId) : undefined;
          if (!child || child.record !== record) throw invalidParams('unknown subagent task');
          if (methodName === LODY_EXTENSION_METHODS.subagentsCancel) {
            if (!child.live) return {};
            if (!child.agent || ctx.agents.get(child.agent.id) !== child.agent)
              throw invalidParams('this subagent cannot be cancelled by the ACP bridge');
            child.agent.cancel({ kind: 'user' });
            const service = ctx.get('subagents') as
              | { drainContinuableChildren(parent: HarnessAgent, ids: string[]): Promise<void> }
              | undefined;
            await service?.drainContinuableChildren(child.parent, [child.agent.id]);
            return {};
          }
          const tail = params.tail;
          if (
            tail !== undefined &&
            (typeof tail !== 'number' || !Number.isSafeInteger(tail) || tail < 1)
          )
            throw invalidParams('tail must be a positive integer');
          return {
            output:
              typeof tail === 'number'
                ? child.output.split('\n').slice(-tail).join('\n')
                : child.output,
          };
        }
        throw RequestError.methodNotFound(method);
      },

      async unstable_forkSession(
        params: ForkSessionRequest
      ): Promise<NewSessionResponseWithModels> {
        assertOpen();
        const target = forkTarget(params._meta);
        const creation = {
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
          additionalDirectories: params.additionalDirectories,
          _meta: params._meta,
        };
        validateSessionParams(creation);
        const query = ctx.get('sessionQuery') as
          | {
              observeSession(id: string): Promise<ForkObservation>;
            }
          | undefined;
        if (!query) throw internalError('Harness session query is unavailable');
        let source: ForkObservation;
        try {
          source = await query.observeSession(params.sessionId);
        } catch (error: unknown) {
          throw invalidParams(`fork source unavailable: ${errorChain(error)}`);
        }
        let snapshot: ForkSnapshot;
        try {
          if (source.header.id !== params.sessionId)
            throw invalidParams('fork source identity mismatch');
          snapshot = forkSnapshot(source, target);
        } finally {
          source[Symbol.dispose]();
        }
        return createSession(creation, snapshot);
      },

      setSessionMode(params: SetSessionModeRequest): void {
        const record = requireSession(params.sessionId);
        setPermissionMode(record, params.modeId);
      },

      setSessionConfigOption(
        params: SetSessionConfigOptionRequest
      ): SetSessionConfigOptionResponse | Promise<SetSessionConfigOptionResponse> {
        return setConfigOption(requireSession(params.sessionId), params);
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen();
        const record = requireSession(params.sessionId);
        if (record.inflight) throw invalidParams('a prompt is already in flight for this session');
        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge');
        }
        const goalControl = (params._meta?.lody as LodySessionMeta | undefined)?.goalControl;
        if (
          goalControl &&
          (!goals ||
            goalControl.version !== 1 ||
            !['set', 'resume'].includes(goalControl.action) ||
            (goalControl.action === 'set' &&
              (typeof goalControl.objective !== 'string' || !goalControl.objective.trim())))
        )
          throw invalidParams('invalid goalControl');
        const messageId = randomUUID();
        let resolvePrompt!: (reason: StopReason) => void;
        let rejectPrompt!: (error: Error) => void;
        let finishAdmission!: () => void;
        const completion = new Promise<StopReason>((resolve, reject) => {
          resolvePrompt = resolve;
          rejectPrompt = reject;
        });
        const admissionDone = new Promise<void>((resolve) => {
          finishAdmission = resolve;
        });
        const admissionController = new AbortController();
        const inflight: InflightPrompt = {
          resolve: resolvePrompt,
          reject: rejectPrompt,
          messageQueued: false,
          admissionDone,
          admissionController,
          cancelRequested: false,
          settlementStarted: false,
        };
        record.inflight = inflight;
        let admissionError: unknown;
        let goalApplied = false;
        try {
          const content = goalControl
            ? []
            : await admitAcpPrompt(
                params.prompt,
                llm,
                record.selection.current,
                attachments,
                imagePromptEnabled,
                admissionController.signal
              );
          if (!inflight.cancelRequested) {
            if (ctx.agents.get(record.agent.id) !== record.agent) {
              throw internalError(
                'prompt was not queued: the agent was disposed outside the bridge'
              );
            }
            if (goalControl) {
              if (goalControl.action === 'set')
                goals!.create(record.agent, { objective: goalControl.objective });
              else {
                const goal = goals!.get(record.agent);
                if (!goal) throw invalidParams('no goal to resume');
                goals!.resume(record.agent, goal);
              }
            }
            goalApplied = !!goalControl;
            const message = createUserMessage(messageId, content);
            inflight.messageId = messageId;
            inflight.messageQueued = true;
            const wasStarted = record.started;
            try {
              if (!goalControl) record.agent.followup(message);
              record.started = true;
            } catch (error: unknown) {
              inflight.messageQueued = false;
              record.started = wasStarted;
              throw new Error(
                `prompt was not queued: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
              );
            }
          }
        } catch (error: unknown) {
          admissionError = error;
        } finally {
          finishAdmission();
        }
        if (inflight.cancelRequested) {
          settleAfterQuiescence(record, inflight);
          return { stopReason: await completion };
        }
        if (admissionError) {
          if (goalApplied) pauseGoal(record);
          if (record.inflight === inflight) record.inflight = undefined;
          if (admissionError instanceof RequestError) throw admissionError;
          throw internalError(errorChain(admissionError));
        }
        settleAfterQuiescence(record, inflight);
        return { stopReason: await completion };
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(params.sessionId);
        if (!record) return Promise.resolve();
        pauseGoal(record);
        record.questions.cancel();
        const inflight = record.inflight;
        if (inflight) {
          inflight.cancelRequested = true;
          inflight.admissionController.abort(new Error('ACP prompt cancelled'));
          settleAfterQuiescence(record, inflight);
        }
        if (!inflight || inflight.messageQueued) record.agent.cancel({ kind: 'user' });
        return Promise.resolve();
      },

      async closeSession(params: CloseSessionRequest): Promise<void> {
        const record = requireSession(params.sessionId);
        pauseGoal(record);
        record.questions.cancel();
        sessions.delete(params.sessionId);
        const inflight = record.inflight;
        if (inflight) {
          inflight.cancelRequested = true;
          inflight.admissionController.abort(new Error('ACP session closed'));
          settleAfterQuiescence(record, inflight);
        }
        if (!inflight || inflight.messageQueued) record.agent.cancel({ kind: 'user' });
        await disposeRecords([record]);
      },
    };
  };

  const stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
    );
  conn = new AgentSideConnection(makeAgent, stream);

  let quiescing: Promise<void> | undefined;
  const quiesce = (): Promise<void> => {
    if (quiescing) return quiescing;
    closed = true;
    const records = [...sessions.values()];
    sessions.clear();
    for (const record of records) {
      pauseGoal(record);
      record.questions.cancel();
      const inflight = record.inflight;
      if (inflight) {
        inflight.cancelRequested = true;
        inflight.admissionController.abort(new Error('ACP bridge disposed'));
        settleAfterQuiescence(record, inflight);
      }
      if (!inflight || inflight.messageQueued) record.agent.cancel({ kind: 'user' });
    }
    quiescing = (async () => {
      await disposeRecords(records);
    })();
    return quiescing;
  };

  void conn.closed
    .catch((error: unknown) => {
      ctx.logger.warn(`acp-extension-dsh: connection closed with an error: ${String(error)}`);
    })
    .then(quiesce)
    .catch((error: unknown) => {
      ctx.logger.warn(`acp-extension-dsh: connection-close teardown failed: ${String(error)}`);
    });
  ctx.effect(() => quiesce, 'acp-extension-dsh.connection');
}
