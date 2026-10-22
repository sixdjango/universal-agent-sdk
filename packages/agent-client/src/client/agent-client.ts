import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as acp from '@agentclientprotocol/sdk';
import {
  EXTENSION_METHODS,
  EXTENSION_TOOL_NAMES,
  normalizeExtensionMethod,
  type ClientExtensionCapabilities,
  type ElicitationMeta,
  type ExtensionCapabilities,
  type GoalCapability,
  type RateLimit,
  type RateLimitsGetRequest,
  type RateLimitsSnapshot,
  type SessionActivityUpdate,
  type SessionConfig,
  type SessionUsageUpdate,
  type SubagentSnapshot,
  type WorktreeProject,
} from '@universal-agent/acp-extension-core';
import { z } from 'zod';
import { TerminalSpawnError, type TerminalManager } from '../process/terminal-manager';
import {
  MODEL_THOUGHT_LEVEL_META_KEY,
  parseSessionNotification,
  sanitizeGoalObjective,
  type ACPSessionId,
  type AcpConfigOptionValue,
  type AcpSessionNotification,
  type AcpStartupStageEvent,
  type AcpStartupTimeoutOptions,
  type AcpWriteTextFileEvidence,
  type AgentConfigCliType,
  type AgentSessionWarning,
  type ImageGenerationBeginEvent,
  type ImageGenerationEndEvent,
  type Logger,
  type ModelInfo,
  type SessionContextWindowUsage,
  type SessionGoalAction,
  type SessionGoalContent,
  type SessionId,
  type SessionTurnInputConfig,
  type SteerApplicationLease,
  type SteerOutcomeResult,
  type SteerPromptRun,
} from '../types';
import {
  buildSteerRequestMeta,
  findActiveSteerConfigMismatch,
  parseAcknowledgedSteerCapability,
  parseSteerAppliedParams,
  type AcknowledgedSteerCapability,
} from './acknowledged-steer';
import {
  filterAcpConfigOptions,
  readLegacySessionModelState,
  type LegacySessionModelState,
} from './capability-norm';
import {
  buildAskUserQuestionElicitationResponse,
  convertTaskLifecycleNotification,
  getBuiltinToolPermissionOutcome,
  getDevinSubagentContextId,
   getExtensionMetaContainer,
  hasOtherDevinSubagentMeta,
  parseAskUserQuestionElicitationRequest,
  parseDevinSubagentTaskMeta,
  parseExtensionCapabilities,
  parseExtensionMessage,
  parseRateLimitsSnapshot,
} from './extension-parser';
import {
  buildGoalPromptMeta,
  buildGoalSlashCommandText,
  resolveGoalActionTransport,
  type GoalActionTransport,
  type GoalPromptControl,
} from './goal-control';

export const DEFAULT_ACP_INIT_TIMEOUT_MS = 60_000;
export const DEFAULT_ACP_NEW_SESSION_TIMEOUT_MS = 120_000;

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message?.toLowerCase() ?? '';
  return (
    msg.includes('not ready for writing') ||
    msg.includes('transport') ||
    (msg.includes('process') && msg.includes('not ready'))
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function summarizeAcpConfigOptions(options: acp.SessionConfigOption[]): string {
  if (options.length === 0) {
    return 'none';
  }
  return options
    .slice(0, 12)
    .map((option) => `${option.id}:${option.category ?? 'uncategorized'}`)
    .join(',');
}

async function withTransportRetry<T>(
  operation: () => Promise<T>,
  logger: Logger,
  operationName: string,
  sessionId: string,
  maxRetries: number = 2
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const isTransport = isTransportError(err);
      if (isTransport && attempt < maxRetries) {
        const delayMs = 100 * (attempt + 1);
        logger.debug(
          `[${sessionId}] ${operationName} failed with transport error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (!isTransport) {
        throw err;
      }
      logger.debug(
        `[${sessionId}] ${operationName} failed after ${attempt + 1} attempt(s) with transport error: ${formatErrorMessage(err)}`
      );
      return undefined;
    }
  }
  return undefined;
}

export class AcpTimeoutError extends Error {
  constructor(
    public readonly operationName: string,
    public readonly timeoutMs: number,
    public readonly sessionId: string
  ) {
    super(
      `[ACP_TIMEOUT] Operation "${operationName}" timed out after ${Math.round(timeoutMs / 1000)}s`
    );
    this.name = 'AcpTimeoutError';
  }
}

export class AgentSteerNotDeliveredError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AgentSteerNotDeliveredError';
  }
}

function isAcpAuthenticationRequired(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === -32000 && /authentication required/iu.test(message);
}

function isAcpInvalidRequestError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === -32600
  );
}

function isAcpMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === -32601
  );
}

export class AcpAuthenticationRequiredError extends Error {
  readonly code = -32000;
  readonly data: { readonly authMethods: readonly acp.AuthMethod[] };

  constructor(
    public readonly authMethods: readonly acp.AuthMethod[],
    options?: { cause?: unknown }
  ) {
    super('Authentication required', options);
    this.name = 'AcpAuthenticationRequiredError';
    this.data = { authMethods };
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  logger: Logger,
  operationName: string,
  sessionId: string,
  timeoutMs: number,
  warningIntervalMs: number = 10000
): Promise<T> {
  let completed = false;
  let elapsedMs = 0;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const warningInterval = setInterval(() => {
    elapsedMs += warningIntervalMs;
    if (!completed) {
      const remainingMs = timeoutMs - elapsedMs;
      logger.debug(
        `[${sessionId}] Operation "${operationName}" is still pending after ${Math.round(elapsedMs / 1000)}s ` +
          `(timeout in ${Math.round(remainingMs / 1000)}s)`
      );
    }
  }, warningIntervalMs);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      if (!completed) {
        reject(new AcpTimeoutError(operationName, timeoutMs, sessionId));
      }
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    completed = true;
    clearInterval(warningInterval);
    clearTimeout(timeoutHandle);
  });
}

function withAbort<T>(promise: Promise<T>, abortPromise?: Promise<never>): Promise<T> {
  if (!abortPromise) {
    return promise;
  }
  return Promise.race([promise, abortPromise]);
}

const sanitizeModelUsage = (
  modelUsage: SessionUsageUpdate['modelUsage']
): SessionUsageUpdate['modelUsage'] => {
  if (!modelUsage) {
    return undefined;
  }
  const sanitized: NonNullable<SessionUsageUpdate['modelUsage']> = {};
  for (const [modelId, usage] of Object.entries(modelUsage)) {
    sanitized[modelId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUSD,
    };
  }
  return sanitized;
};

const LegacyCodexGoalStatusSchema = z.enum([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
  'cleared',
]);
const LegacyCodexGoalSnapshotSchema = z.object({
  objective: z.string(),
  status: LegacyCodexGoalStatusSchema,
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().optional(),
  timeUsedSeconds: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
const CoreGoalSnapshotSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'limited', 'complete']),
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().optional(),
  timeUsedSeconds: z.number().optional(),
  createdAtEpochSeconds: z.number().nonnegative().optional(),
  updatedAtEpochSeconds: z.number().nonnegative().optional(),
});
const LegacyNeutralGoalSnapshotSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'limited', 'complete']),
  controlMethod: z.literal('_session/goal'),
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().optional(),
  timeUsedSeconds: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

const CodexRetryErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    turnId: z.string().min(1),
    willRetry: z.literal(true),
  }),
});

const NoticeSchema = z.object({
  notice: z.object({
    level: z.enum(['info', 'warning', 'error']),
    message: z.string(),
    source: z.string().optional(),
  }),
});

const LegacyCodexSessionWarningSchema = z.object({
  warning: z.object({
    message: z.string(),
    source: z.enum(['warning', 'configWarning']).optional(),
  }),
});

const SessionTitleSchema = z.object({
  titleSource: z.enum(['explicit', 'generated', 'fallback', 'unset']),
});

type SteerApplicationWaiter = {
  sessionId: ACPSessionId;
  applied: boolean;
  resolve: (lease: SteerApplicationLease) => void;
  reject: (error: unknown) => void;
  released: Promise<void>;
  release: () => void;
};

type ActivePromptCompletion = {
  sessionId: ACPSessionId;
  promise: Promise<acp.PromptResponse | undefined>;
};

const IMAGE_GENERATION_REVISED_PROMPT_PREFIX = 'Revised prompt: ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseRawOutputRecord(rawOutput: unknown): Record<string, unknown> | undefined {
  if (isRecord(rawOutput)) {
    return rawOutput;
  }
  if (typeof rawOutput !== 'string' || rawOutput.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawOutput);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractImageGenerationRawOutputFields(rawOutput: unknown): {
  revisedPrompt?: string;
  savedPath?: string;
  status?: string;
  imageData?: string;
} {
  const record = parseRawOutputRecord(rawOutput);
  if (!record) return {};

  return {
    revisedPrompt: getStringField(record, ['revisedPrompt', 'revised_prompt']),
    savedPath: getStringField(record, ['savedPath', 'saved_path']),
    status: getStringField(record, ['status']),
    imageData: getStringField(record, ['result']),
  };
}

function extractImageGenerationContentFields(content: unknown): {
  revisedPrompt?: string;
  savedPath?: string;
  image?: ImageGenerationEndEvent['image'];
} {
  if (!Array.isArray(content)) return {};
  let revisedPrompt: string | undefined;
  let savedPath: string | undefined;
  let image: ImageGenerationEndEvent['image'];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'content') continue;
    const inner = block.content;
    if (!isRecord(inner)) continue;
    if (inner.type === 'text' && typeof inner.text === 'string') {
      if (
        revisedPrompt === undefined &&
        inner.text.startsWith(IMAGE_GENERATION_REVISED_PROMPT_PREFIX)
      ) {
        revisedPrompt = inner.text.slice(IMAGE_GENERATION_REVISED_PROMPT_PREFIX.length);
      }
    } else if (
      inner.type === 'image' &&
      typeof inner.data === 'string' &&
      inner.data.length > 0 &&
      typeof inner.mimeType === 'string' &&
      inner.mimeType.length > 0
    ) {
      const uri = typeof inner.uri === 'string' && inner.uri.length > 0 ? inner.uri : undefined;
      savedPath = uri ?? savedPath;
      image = {
        data: inner.data,
        mimeType: inner.mimeType,
        ...(uri ? { uri } : {}),
      };
    }
  }
  return { revisedPrompt, savedPath, image };
}

function trustsUntaggedAcpSessionTitle(
  cliType: AgentConfigCliType | undefined,
  agentType: string | undefined
): boolean {
  return cliType === 'builtin' && (agentType === 'claude' || agentType === 'grok');
}

export interface AgentClientOptions {
  resolveWorktreeProject?: () => Promise<WorktreeProject>;
  sessionId: SessionId;
  logger: Logger;
  terminalManager: TerminalManager;
  agentConfig?: {
    cliType: AgentConfigCliType;
    agentType: string;
  };
  modelId?: SessionTurnInputConfig['modelId'];
  configOptionValues?: SessionTurnInputConfig['configOptionValues'];
  terminalEnabled?: boolean;
  mcpServers?: acp.McpServer[];
  resolveMcpServers?: (capabilities: {
    http: boolean;
  }) => Promise<acp.McpServer[]> | acp.McpServer[];
  loadExternalMcpServers?: () => Promise<acp.McpServer[]>;
  onStartupStage?: (event: AcpStartupStageEvent) => void;
  onUpdateMessage(message: AcpSessionNotification): void;
  onRequestPermission(
    requestId: string,
    request: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse>;
  onUsageUpdate?(usage: SessionUsageUpdate, accountingId?: string): void;
  onContextWindowUsageUpdate?(usage: SessionContextWindowUsage): void;
  onRateLimitUpdate?(limits: RateLimit): void;
  onThreadGoalUpdated?(goal: SessionGoalContent): void;
  onThreadGoalCleared?(threadId: string): void;
  onSessionTitleUpdate?(title: string): void;
  onAgentWarning?(warning: AgentSessionWarning): void;
  onImageGenerationBegin?(event: ImageGenerationBeginEvent): void;
  onImageGenerationEnd?(event: ImageGenerationEndEvent): void;
  onWriteTextFile?(event: AcpWriteTextFileEvidence): void | Promise<void>;
}

export type NativeAgentWork = 'running' | 'background' | null;

export class AgentClient implements acp.Client {
  private connection: acp.ClientSideConnection | null = null;
  logger: Logger;
  private readonly terminalManager: TerminalManager;
  private readonly terminalEnabled: boolean;
  private acpSessionId: string | null = null;
  private supportsResume = false;
  private supportsLoadSession = false;
  private supportsClose = false;
  private supportsFork = false;
  private supportsForkAtTurn = false;
  private supportsHttpMcp = false;
  private extensionCapabilities: ExtensionCapabilities = {};
  private readonly subagentSnapshots = new Map<string, SubagentSnapshot>();
  private nativeActivity: SessionActivityUpdate | null = null;
  private readonly devinSubagentTaskIds = new Set<string>();
  private worktreeProject?: WorktreeProject;
  private authMethods: acp.AuthMethod[] = [];
  private authenticationRequired = false;
  private acknowledgedSteerCapability: AcknowledgedSteerCapability | null = null;
  private readonly steerApplicationWaiters = new Map<string, SteerApplicationWaiter>();
  private steerApplicationBarrier: Promise<void> | null = null;
  private activePromptCompletion: ActivePromptCompletion | null = null;
  private readonly pendingPrompts = new Set<Promise<unknown>>();
  private sessionWorkdir: string | null = null;
  private configOptions: acp.SessionConfigOption[] = [];
  private readonly configOptionsListeners = new Set<() => void>();
  private readonly configOptionValues: NonNullable<SessionTurnInputConfig['configOptionValues']>;
  private legacySessionModelState: LegacySessionModelState | null = null;
  public currentModel?: ModelInfo;
  private imageGenerationToolCallIds = new Set<string>();
  private activeCodexRetry: { sessionId: string; toolCallId: string } | null = null;

  constructor(private options: AgentClientOptions) {
    this.logger = options.logger;
    this.terminalManager = options.terminalManager;
    this.terminalEnabled =
      options.terminalEnabled ??
      !(options.agentConfig?.cliType === 'builtin' && options.agentConfig.agentType === 'grok');
    this.configOptionValues = { ...(options.configOptionValues ?? {}) };
  }

  private describePromptDiagnosticContext(): string {
    const agentConfig = this.options.agentConfig;
    return `cliType=${agentConfig?.cliType ?? 'unknown'} agentType=${
      agentConfig?.agentType ?? 'unknown'
    } currentModel=${this.currentModel?.modelId ?? 'none'} configOptions=${summarizeAcpConfigOptions(
      this.configOptions
    )}`;
  }

  private async buildMcpServers(
    externalLoad: Promise<acp.McpServer[]> | undefined
  ): Promise<acp.McpServer[]> {
    const servers: acp.McpServer[] = this.options.mcpServers ? [...this.options.mcpServers] : [];
    if (this.options.resolveMcpServers) {
      try {
        const resolved = await this.options.resolveMcpServers({ http: this.supportsHttpMcp });
        servers.push(...resolved);
      } catch (error) {
        const message = `Dynamic MCP servers could not be resolved (${formatErrorMessage(error)}).`;
        this.logger.debug(`[${this.options.sessionId}] ${message}`);
        this.options.onAgentWarning?.({ message, source: 'configWarning' });
      }
    }
    if (!externalLoad) {
      return servers;
    }
    try {
      const loaded = await externalLoad;
      return [...servers, ...loaded];
    } catch (error) {
      const message = `External MCP servers could not be loaded (${formatErrorMessage(error)}).`;
      this.logger.debug(`[${this.options.sessionId}] ${message}`);
      this.options.onAgentWarning?.({ message, source: 'configWarning' });
      return servers;
    }
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    if (!this.isKnownSubagentInteraction(params._meta)) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const automatic = this.getAutomaticToolPermissionOutcome(params, false);
    if (automatic) {
      return { outcome: automatic };
    }
    const requestId = randomUUID();
    this.logger.debug(
      `[${this.options.sessionId}] Requesting permission for tool call ${params.toolCall.toolCallId}`
    );
    return this.options.onRequestPermission(requestId, params);
  }

  async unstable_createElicitation(
    params: acp.CreateElicitationRequest
  ): Promise<acp.CreateElicitationResponse> {
    if (!this.isKnownSubagentInteraction(params._meta)) return { action: 'decline' };
    const elicitation = parseAskUserQuestionElicitationRequest(params);
    if (!elicitation) {
      this.logger.debug(
        `[${this.options.sessionId}] Declining unsupported elicitation (mode=${(params as { mode?: unknown }).mode})`
      );
      return { action: 'decline' };
    }

    const sessionId = (params as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== 'string') {
      return { action: 'decline' };
    }
    this.ensureSessionMatch(sessionId as ACPSessionId);

    const toolCallId =
      typeof (params as { toolCallId?: unknown }).toolCallId === 'string'
        ? ((params as { toolCallId?: string }).toolCallId as string)
        : undefined;
    const requestId = randomUUID();
    const firstQuestion = elicitation.meta.questions[0];
    const autoResolveAt =
      typeof elicitation.autoResolutionMs === 'number' &&
      Number.isFinite(elicitation.autoResolutionMs)
        ? Date.now() + Math.max(0, elicitation.autoResolutionMs)
        : undefined;
    const autoResolveAtEpochSeconds =
      autoResolveAt === undefined ? undefined : Math.floor(autoResolveAt / 1000);
    const elicitationPayload = {
      version: 1,
      questions: elicitation.meta.questions,
      ...(autoResolveAtEpochSeconds !== undefined ? { autoResolveAtEpochSeconds } : {}),
    } satisfies ElicitationMeta;
    const legacyQuestionMeta =
      this.options.agentConfig?.agentType === 'codex'
        ? {
            codex: {
              requestUserInput: {
                version: 1,
                allowCustomAnswer: elicitation.meta.allowCustomAnswer,
                questions: elicitation.meta.questions,
                ...(autoResolveAt !== undefined ? { autoResolveAt } : {}),
              },
            },
          }
        : this.options.agentConfig?.agentType === 'claude'
          ? {
              claudeCode: {
                requestType: 'askUserQuestion',
                askUserQuestion: {
                  version: 1,
                  allowCustomAnswer: elicitation.meta.allowCustomAnswer,
                  questions: elicitation.meta.questions,
                },
              },
            }
          : {};
    const syntheticRequest: acp.RequestPermissionRequest = {
      sessionId,
      toolCall: {
        toolCallId: toolCallId ?? requestId,
        title: firstQuestion?.question ?? 'Answer question',
        kind: 'think',
        status: 'pending',
        rawInput: { questions: elicitation.meta.questions },
      },
      options: [
        { kind: 'allow_once', name: 'Submit answers', optionId: 'answer' },
        { kind: 'reject_once', name: 'Cancel', optionId: 'cancel' },
      ],
      _meta: {
        ua: { elicitation: elicitationPayload },
        lody: { elicitation: elicitationPayload },
        ...legacyQuestionMeta,
      },
    };

    this.logger.debug(
      `[${this.options.sessionId}] Bridging AskUserQuestion elicitation (toolCallId=${toolCallId ?? '<none>'}, questions=${elicitation.meta.questions.length})`
    );
    const response = await this.options.onRequestPermission(requestId, syntheticRequest);
    return buildAskUserQuestionElicitationResponse(elicitation, response);
  }

  async sessionUpdate(params: acp.SessionNotification) {
    const applicationBarrier = this.steerApplicationBarrier;
    if (applicationBarrier) {
      await applicationBarrier;
    }
    if (
      this.acpSessionId !== null &&
      (params.sessionId as unknown as string) !== this.acpSessionId
    ) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping update for detached ACP session: ${params.sessionId}`
      );
      return;
    }

    const isToolUpdate =
      params.update.sessionUpdate === 'tool_call' ||
      params.update.sessionUpdate === 'tool_call_update';
    const devinLifecycle = parseDevinSubagentTaskMeta(params.update._meta);
    if (
      devinLifecycle !== null &&
      isToolUpdate &&
      'toolCallId' in params.update &&
      params.update.toolCallId.length > 0
    ) {
      this.devinSubagentTaskIds.add(devinLifecycle.taskId);
    }
    const devinSubagentOwnerId = getDevinSubagentContextId(params.update._meta);
    const isDevinSubagentInternal =
      devinSubagentOwnerId !== null &&
      this.devinSubagentTaskIds.has(devinSubagentOwnerId) &&
      !hasOtherDevinSubagentMeta(params.update._meta);
    if (isDevinSubagentInternal && !isToolUpdate) {
      return;
    }

    if (this.handleUsageUpdate(params.update)) {
      return;
    }

    const notification = parseSessionNotification(params);

    if (notification.update.sessionUpdate === 'config_option_update') {
      this.applyConfigOptionsState(
        notification.update.configOptions as unknown as acp.SessionConfigOption[],
        true
      );
    }

    this.handleGoalSessionInfoUpdate(notification);
    this.handleCodexWarningSessionInfoUpdate(notification);
    this.handleAgentSessionTitleUpdate(notification);

    if (this.handleCodexRetrySessionInfoUpdate(notification)) {
      return;
    }
    if (this.isCodexRecoveryNotification(notification)) {
      this.completeCodexRetryStatus();
    }

    if (this.handleImageGenerationNotification(notification)) {
      return;
    }

    this.options.onUpdateMessage(notification);
  }

  private handleGoalSessionInfoUpdate(notification: AcpSessionNotification): void {
    if (notification.update.sessionUpdate !== 'session_info_update') {
      return;
    }

    const meta = notification.update._meta;
    if (typeof meta !== 'object' || meta === null) {
      return;
    }

    let goalContainer: unknown;
    let source: 'Core' | 'legacy ACP' | 'legacy Codex';
    const extMeta = getExtensionMetaContainer(meta);
    if (extMeta && 'goal' in extMeta) {
      goalContainer = extMeta;
      source = 'Core';
    } else if ('goal' in meta) {
      goalContainer = meta;
      source = 'legacy ACP';
    } else {
      const codexMeta = meta.codex;
      if (
        !this.isCodexAgent() ||
        typeof codexMeta !== 'object' ||
        codexMeta === null ||
        !('goal' in codexMeta)
      ) {
        return;
      }
      goalContainer = codexMeta;
      source = 'legacy Codex';
    }

    const goalSchema =
      source === 'Core'
        ? CoreGoalSnapshotSchema
        : source === 'legacy ACP'
          ? LegacyNeutralGoalSnapshotSchema
          : LegacyCodexGoalSnapshotSchema;
    const parsed = z.object({ goal: goalSchema.nullable() }).safeParse(goalContainer);
    if (!parsed.success) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping invalid ${source} goal session info: ${parsed.error.message}`
      );
      return;
    }

    const threadId = notification.sessionId;
    if (parsed.data.goal === null) {
      this.options.onThreadGoalCleared?.(threadId);
      return;
    }

    const goal = parsed.data.goal;
    this.options.onThreadGoalUpdated?.({
      type: 'goal',
      threadId,
      objective: sanitizeGoalObjective(goal.objective),
      status: goal.status === 'limited' ? 'blocked' : goal.status,
      tokenBudget: goal.tokenBudget ?? null,
      ...(goal.tokensUsed !== undefined ? { tokensUsed: goal.tokensUsed } : {}),
      ...(goal.timeUsedSeconds !== undefined ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
      ...('createdAtEpochSeconds' in goal && goal.createdAtEpochSeconds !== undefined
        ? { createdAt: goal.createdAtEpochSeconds * 1_000 }
        : 'createdAt' in goal && goal.createdAt !== undefined
          ? { createdAt: goal.createdAt }
          : {}),
      ...('updatedAtEpochSeconds' in goal && goal.updatedAtEpochSeconds !== undefined
        ? { updatedAt: goal.updatedAtEpochSeconds * 1_000 }
        : 'updatedAt' in goal && goal.updatedAt !== undefined
          ? { updatedAt: goal.updatedAt }
          : {}),
    });
  }

  private handleCodexWarningSessionInfoUpdate(notification: AcpSessionNotification): void {
    if (notification.update.sessionUpdate !== 'session_info_update') {
      return;
    }
    const extMeta = getExtensionMetaContainer(notification.update._meta);
    const canonical = NoticeSchema.safeParse(extMeta);
    if (canonical.success) {
      if (canonical.data.notice.level === 'warning' || canonical.data.notice.level === 'error') {
        this.options.onAgentWarning?.({
          message: canonical.data.notice.message,
          ...(canonical.data.notice.source ? { source: canonical.data.notice.source } : {}),
        });
      }
      return;
    }

    if (!this.isCodexAgent()) return;
    const parsed = LegacyCodexSessionWarningSchema.safeParse(notification.update._meta?.codex);
    if (!parsed.success) {
      return;
    }
    this.options.onAgentWarning?.(parsed.data.warning);
  }

  private handleCodexRetrySessionInfoUpdate(notification: AcpSessionNotification): boolean {
    if (!this.isCodexAgent() || notification.update.sessionUpdate !== 'session_info_update') {
      return false;
    }
    const parsed = CodexRetryErrorSchema.safeParse(notification.update._meta?.codex);
    if (!parsed.success) return false;

    const toolCallId = `codex-retry:${parsed.data.error.turnId}`;
    if (this.activeCodexRetry?.toolCallId === toolCallId) {
      return true;
    }
    this.completeCodexRetryStatus();
    this.activeCodexRetry = { sessionId: notification.sessionId, toolCallId };
    const activity = { version: 1 as const, kind: 'retry' as const };
    this.options.onUpdateMessage(
      parseSessionNotification({
        sessionId: notification.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Codex retrying',
          kind: 'other',
          status: 'in_progress',
          _meta: { ua: { activity }, lody: { activity } },
        },
      })
    );
    return true;
  }

  private isCodexRecoveryNotification(notification: AcpSessionNotification): boolean {
    if (!this.activeCodexRetry) return false;
    switch (notification.update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'tool_call':
      case 'tool_call_update':
        return true;
      default:
        return false;
    }
  }

  private completeCodexRetryStatus(): void {
    const active = this.activeCodexRetry;
    if (!active) return;
    this.activeCodexRetry = null;
    const activity = { version: 1 as const, kind: 'retry' as const };
    this.options.onUpdateMessage(
      parseSessionNotification({
        sessionId: active.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: active.toolCallId,
          status: 'completed',
          _meta: { ua: { activity }, lody: { activity } },
        },
      })
    );
  }

  private handleImageGenerationNotification(notification: AcpSessionNotification): boolean {
    const update = notification.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      return false;
    }
    const callId = update.toolCallId;
    if (typeof callId !== 'string' || callId.length === 0) return false;

    const isBegin = update.sessionUpdate === 'tool_call';
    const extMeta = getExtensionMetaContainer(update._meta);
    const isCanonicalImageGeneration = extMeta?.toolName === EXTENSION_TOOL_NAMES.imageGeneration;
    const isLegacyCodexImageGeneration = this.isCodexAgent() && update.title === 'Image generation';
    const isTracked = this.imageGenerationToolCallIds.has(callId);
    if (isBegin) {
      if (!isCanonicalImageGeneration && !isLegacyCodexImageGeneration) return false;
    } else if (!isTracked) {
      return false;
    }

    const acpSessionId = (notification.sessionId ?? this.acpSessionId) as ACPSessionId | null;
    if (!acpSessionId || !this.isCurrentAcpSession(acpSessionId)) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping image generation notification for mismatched ACP session: ${acpSessionId}`
      );
      return true;
    }

    const rawOutput = (update as { rawOutput?: unknown }).rawOutput;
    const rawFields = extractImageGenerationRawOutputFields(rawOutput);
    const status = typeof update.status === 'string' ? update.status : rawFields.status;
    const isTerminalStatus = status === 'completed' || status === 'failed';

    if (isBegin && !isTracked) {
      this.imageGenerationToolCallIds.add(callId);
      this.options.onImageGenerationBegin?.({ acpSessionId, callId });
    }

    if (status) {
      const contentFields = extractImageGenerationContentFields(update.content);
      const image =
        contentFields.image ??
        (rawFields.imageData
          ? {
              data: rawFields.imageData,
              mimeType: 'image/png',
              ...(rawFields.savedPath ? { uri: rawFields.savedPath } : {}),
            }
          : undefined);
      this.options.onImageGenerationEnd?.({
        acpSessionId,
        callId,
        status,
        revisedPrompt: contentFields.revisedPrompt ?? rawFields.revisedPrompt,
        savedPath: contentFields.savedPath ?? rawFields.savedPath,
        ...(image ? { image } : {}),
      });
    }

    if (isTerminalStatus) {
      this.imageGenerationToolCallIds.delete(callId);
    }

    return true;
  }

  private handleUsageUpdate(update: unknown): boolean {
    if (!isUsageUpdate(update)) {
      return false;
    }

    const size = typeof update.size === 'number' ? update.size : null;
    const used = typeof update.used === 'number' ? update.used : null;
    if (
      size !== null &&
      used !== null &&
      Number.isFinite(size) &&
      Number.isFinite(used) &&
      size >= 0 &&
      used >= 0
    ) {
      this.options.onContextWindowUsageUpdate?.({ size, used });
    }
    return true;
  }

  isCreated(): boolean {
    return !!this.connection;
  }

  getAcpSessionId(): string | null {
    return this.acpSessionId;
  }

  getExtensionCapabilities(): ExtensionCapabilities {
    return this.extensionCapabilities;
  }

  /** @deprecated Use `getExtensionCapabilities`. */
  getLodyExtensionCapabilities(): ExtensionCapabilities {
    return this.extensionCapabilities;
  }

  supportsAcknowledgedSteer(): boolean {
    return this.acknowledgedSteerCapability !== null;
  }

  getAuthMethods(): readonly acp.AuthMethod[] {
    return this.authMethods;
  }

  isAuthenticationRequired(): boolean {
    return this.authenticationRequired;
  }

  getAcknowledgedSteerCapability(): AcknowledgedSteerCapability | null {
    return this.acknowledgedSteerCapability;
  }

  findSteerConfigMismatch(input: SessionTurnInputConfig): string | null {
    return findActiveSteerConfigMismatch(input, this.configOptions, this.currentModel?.modelId);
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const resolvedPath = this.resolvePath(params.path);
    let oldText: string | null = null;
    try {
      oldText = await fs.readFile(resolvedPath, 'utf8');
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, params.content, 'utf8');
    if (this.options.onWriteTextFile) {
      try {
        await this.options.onWriteTextFile({
          path: resolvedPath,
          oldText,
          newText: params.content,
        });
      } catch (error) {
        this.logger.debug(
          `[${this.options.sessionId}] ACP write_text_file evidence callback failed: ${formatErrorMessage(error)}`
        );
      }
    }
    return {};
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const resolvedPath = this.resolvePath(params.path);
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw acp.RequestError.resourceNotFound(resolvedPath);
      }
      throw error;
    }
    const sliced = sliceTextByLines(content, params.line ?? null, params.limit ?? null);
    return { content: sliced };
  }

  async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const env =
      params.env?.reduce<Record<string, string>>((acc, variable) => {
        acc[variable.name] = variable.value;
        return acc;
      }, {}) ?? undefined;

    try {
      const terminalId = await this.terminalManager.createTerminal(
        params.sessionId,
        params.command,
        params.args ?? [],
        params.cwd ?? undefined,
        env,
        typeof params.outputByteLimit === 'bigint'
          ? params.outputByteLimit > BigInt(Number.MAX_SAFE_INTEGER)
            ? Number.MAX_SAFE_INTEGER
            : Number(params.outputByteLimit)
          : (params.outputByteLimit ?? undefined)
      );
      return { terminalId };
    } catch (error) {
      if (error instanceof TerminalSpawnError) {
        throw acp.RequestError.invalidParams({ details: error.message }, error.message);
      }
      throw error;
    }
  }

  async terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const result = await this.terminalManager.terminalOutput(params.sessionId, params.terminalId);
    return {
      output: result.output,
      truncated: result.truncated,
      exitStatus: result.exitStatus ?? undefined,
    };
  }

  async releaseTerminal(
    params: acp.ReleaseTerminalRequest
  ): Promise<acp.ReleaseTerminalResponse | void> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    await this.terminalManager.releaseTerminal(params.sessionId, params.terminalId);
    return {};
  }

  async waitForTerminalExit(
    params: acp.WaitForTerminalExitRequest
  ): Promise<acp.WaitForTerminalExitResponse> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    const exitStatus = await this.terminalManager.waitForTerminalExit(
      params.sessionId,
      params.terminalId
    );
    return exitStatus;
  }

  async killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse | void> {
    this.ensureSessionMatch(params.sessionId as ACPSessionId);
    await this.terminalManager.killTerminal(params.sessionId, params.terminalId);
    return {};
  }

  getRateLimitsCapability() {
    return this.extensionCapabilities.rateLimits;
  }

  async getRateLimits(request: RateLimitsGetRequest = {}): Promise<RateLimitsSnapshot> {
    if (this.extensionCapabilities.rateLimits?.query !== true) {
      throw new Error('[ACP_RATE_LIMITS_UNSUPPORTED] Agent did not advertise rate-limit queries');
    }
    const connection = this.connection;
    if (!connection) {
      throw new Error('[ACP_RATE_LIMITS_UNAVAILABLE] ACP connection is not initialized');
    }
    const response = await connection.request<Record<string, unknown>, RateLimitsGetRequest>(
      EXTENSION_METHODS.rateLimitsGet,
      request
    );
    return parseRateLimitsSnapshot(response);
  }

  async cancelSubagent(taskId: string, reason?: string): Promise<void> {
    if (this.extensionCapabilities.subagents?.cancel !== true) {
      throw new Error('[ACP_SUBAGENT_UNSUPPORTED] Agent did not advertise subagent management');
    }
    const sessionId = this.acpSessionId;
    const connection = this.connection;
    if (!sessionId || !connection) {
      throw new Error('[ACP_SUBAGENT_UNAVAILABLE] ACP session is not connected');
    }
    await connection.request(EXTENSION_METHODS.subagentsCancel, { sessionId, taskId, reason });
  }

  getGoalCapability(): GoalCapability | undefined {
    return this.extensionCapabilities.goal;
  }

  resolveGoalActionTransport(action: SessionGoalAction): GoalActionTransport | null {
    return resolveGoalActionTransport(this.extensionCapabilities.goal, action);
  }

  async controlGoal(action: SessionGoalAction): Promise<void> {
    if (this.resolveGoalActionTransport(action) !== 'request') {
      throw new Error(
        `[ACP_GOAL_UNSUPPORTED] Agent did not advertise out-of-band goal control for ${action}`
      );
    }
    const sessionId = this.acpSessionId;
    const connection = this.connection;
    if (!sessionId || !connection) {
      throw new Error('[ACP_GOAL_UNAVAILABLE] ACP session is not connected');
    }
    const response = await connection.request<unknown, { sessionId: string; action: string }>(
      EXTENSION_METHODS.sessionGoal,
      { sessionId, action }
    );
    const parsed = z
      .object({ goal: CoreGoalSnapshotSchema.nullable().optional() })
      .safeParse(response);
    if (!parsed.success) {
      throw new Error(
        `[ACP_GOAL_INVALID_RESPONSE] Agent returned an invalid goal control response: ${parsed.error.message}`
      );
    }
    this.logger.debug(
      `[${this.options.sessionId}] Goal ${action} applied (status=${parsed.data.goal?.status ?? 'none'})`
    );
  }

  private buildGoalControlPrompt(
    prompt: acp.ContentBlock[],
    control: GoalPromptControl
  ): { prompt: acp.ContentBlock[]; _meta?: acp.PromptRequest['_meta'] } {
    const transport = resolveGoalActionTransport(
      this.extensionCapabilities.goal,
      control.action,
      'prompt'
    );
    if (transport === 'promptMeta') {
      return { prompt, _meta: buildGoalPromptMeta(control) };
    }
    if (transport === 'slashCommand') {
      return { prompt: [{ type: 'text', text: buildGoalSlashCommandText(control) }] };
    }
    throw new Error(
      `[ACP_GOAL_UNSUPPORTED] Agent cannot run goal action ${control.action} inside a prompt`
    );
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      await this.handleExtensionMessage(method, params);
    } catch (error) {
      this.logger.warn(`Error handling extension method ${method}: ${error}`);
    }
    return {};
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.handleExtensionMessage(method, params);
    } catch (error) {
      this.logger.warn(`Error handling extension notification ${method}: ${error}`);
    }
  }

  private markSubagentsDisconnected(): void {
    if (!this.acpSessionId) return;
    for (const [runId, previous] of this.subagentSnapshots) {
      if (previous.state !== 'pending' && previous.state !== 'running') continue;
      const snapshot: SubagentSnapshot = {
        ...previous,
        state: 'unknown',
        outputIncomplete: true,
        reason: { code: 'disconnected' },
      };
      this.subagentSnapshots.set(runId, snapshot);
      this.options.onUpdateMessage({
        sessionId: this.acpSessionId,
        update: {
          sessionUpdate: 'subagent_event',
          event: { version: 1, sessionId: this.acpSessionId, runId, type: 'snapshot', snapshot },
        },
      });
    }
  }

  private isKnownSubagentInteraction(meta: Record<string, unknown> | null | undefined): boolean {
    const ext = getExtensionMetaContainer(meta);
    if (!ext || !('subagentRunId' in ext)) return true;
    if (typeof ext.subagentRunId !== 'string') return false;
    const snapshot = this.subagentSnapshots.get(ext.subagentRunId);
    return (
      this.extensionCapabilities.subagentEvents?.version === 1 &&
      snapshot !== undefined &&
      (snapshot.state === 'pending' || snapshot.state === 'running')
    );
  }

  private async handleExtensionMessage(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const normalized = normalizeExtensionMethod(method);
    const logicalMethod = normalized.startsWith('_') ? normalized.slice(1) : normalized;
    if (logicalMethod === this.acknowledgedSteerCapability?.appliedNotificationMethod) {
      await this.handleSteerApplied(logicalMethod, params);
      return;
    }
    const event = parseExtensionMessage({
      method,
      params,
      sessionId: this.acpSessionId ?? this.options.sessionId,
      provider: this.options.agentConfig?.agentType ?? 'unknown',
    });
    if (!event) {
      this.logger.debug(`[${this.options.sessionId}] Ignoring extension message ${logicalMethod}`);
      return;
    }
    switch (event.type) {
      case 'subagent': {
        if (this.extensionCapabilities.subagentEvents?.version !== 1 || !this.acpSessionId) {
          return;
        }
        const barrier = this.steerApplicationBarrier;
        if (barrier) await barrier;
        const childEvent = event.event;
        if (childEvent.sessionId !== this.acpSessionId) return;
        if (childEvent.type === 'snapshot') {
          const previous = this.subagentSnapshots.get(childEvent.runId);
          if (
            previous &&
            ['completed', 'failed', 'cancelled'].includes(previous.state) &&
            childEvent.snapshot.state !== previous.state
          )
            return;
          this.subagentSnapshots.set(childEvent.runId, childEvent.snapshot);
        } else {
          const snapshot = this.subagentSnapshots.get(childEvent.runId);
          if (!snapshot || ['completed', 'failed', 'cancelled'].includes(snapshot.state)) return;
        }
        this.options.onUpdateMessage({
          sessionId: childEvent.sessionId,
          update: { sessionUpdate: 'subagent_event', event: childEvent },
        });
        return;
      }
      case 'usage': {
        this.options.onUsageUpdate?.(
          {
            ...event.update,
            modelUsage: sanitizeModelUsage(event.update.modelUsage),
          },
          event.accountingId
        );
        return;
      }
      case 'sessionActivity':
        if (
          this.reportsSessionActivity() &&
          this.acpSessionId !== null &&
          event.update.sessionId === this.acpSessionId
        ) {
          this.nativeActivity = event.update;
        }
        return;
      case 'rateLimits':
        for (const rateLimit of event.snapshot.rateLimits) {
          this.options.onRateLimitUpdate?.(rateLimit);
        }
        return;
      case 'legacyProposedPlan':
        this.options.onUpdateMessage(
          parseSessionNotification({
            sessionId: event.plan.sessionId,
            update:
              event.plan.status === 'cleared'
                ? { sessionUpdate: 'plan_removed', planId: event.plan.turnId }
                : {
                    sessionUpdate: 'plan_update',
                    plan: {
                      type: 'markdown',
                      planId: event.plan.turnId,
                      content: event.plan.markdown,
                    },
                  },
          })
        );
        return;
      case 'legacyTaskLifecycle': {
        const result = convertTaskLifecycleNotification(event.params, {
          defaultActor: event.provider === 'claude' ? 'Claude task' : 'Kimi task',
        });
        if (!result.ok) {
          this.logger.debug(
            `[${this.options.sessionId}] Dropping invalid ${event.provider} task lifecycle update from ${logicalMethod}: ${result.reason}`
          );
          return;
        }
        if (!this.isCurrentAcpSession(result.notification.sessionId)) {
          return;
        }
        this.options.onUpdateMessage(result.notification);
        return;
      }
    }
  }

  private async handleSteerApplied(method: string, params: Record<string, unknown>): Promise<void> {
    const parsed = parseSteerAppliedParams(params);
    if (!parsed) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping invalid steer application from ${method}`
      );
      return;
    }
    const acpSessionId = parsed.sessionId as ACPSessionId;
    if (!this.isCurrentAcpSession(acpSessionId)) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping steer application for mismatched ACP session: ${acpSessionId}`
      );
      return;
    }
    const waiter = this.steerApplicationWaiters.get(parsed.steerId);
    if (!waiter || waiter.sessionId !== acpSessionId) {
      this.logger.debug(
        `[${this.options.sessionId}] Dropping steer application without a matching waiter: ${parsed.steerId}`
      );
      return;
    }
    if (!waiter.applied) {
      waiter.applied = true;
      this.steerApplicationBarrier = waiter.released;
      waiter.resolve({ release: waiter.release });
    }
    await waiter.released;
    if (this.steerApplicationBarrier === waiter.released) {
      this.steerApplicationBarrier = null;
    }
    if (this.steerApplicationWaiters.get(parsed.steerId) === waiter) {
      this.steerApplicationWaiters.delete(parsed.steerId);
    }
  }

  supportsSessionTitleGeneration(): boolean {
    return this.extensionCapabilities.sessionTitle?.version === 1;
  }

  private handleAgentSessionTitleUpdate(notification: AcpSessionNotification): void {
    if (notification.update.sessionUpdate !== 'session_info_update') {
      return;
    }

    const trustsUntaggedTitle = trustsUntaggedAcpSessionTitle(
      this.options.agentConfig?.cliType,
      this.options.agentConfig?.agentType
    );
    const extMeta = getExtensionMetaContainer(notification.update._meta);
    const coreTitleMeta = SessionTitleSchema.safeParse(extMeta);
    const legacyCodexTitleMeta = this.isCodexAgent()
      ? z
          .object({ titleSource: z.enum(['explicit', 'fallback', 'unset', 'unknown']) })
          .safeParse(notification.update._meta?.codex)
      : null;
    const hasTitleSource = extMeta !== null && 'titleSource' in extMeta;
    const ownsTitle = this.supportsSessionTitleGeneration();
    const isAuthoritativeTitle = hasTitleSource
      ? coreTitleMeta.success &&
        (coreTitleMeta.data.titleSource === 'explicit' ||
          (ownsTitle && coreTitleMeta.data.titleSource === 'generated'))
      : (legacyCodexTitleMeta?.success === true &&
          legacyCodexTitleMeta.data.titleSource === 'explicit') ||
        (!ownsTitle && trustsUntaggedTitle);
    if (!isAuthoritativeTitle) {
      return;
    }

    const title =
      typeof notification.update.title === 'string' ? notification.update.title.trim() : '';
    if (!title) {
      return;
    }
    this.options.onSessionTitleUpdate?.(title);
  }

  private isCodexAgent(): boolean {
    return this.options.agentConfig?.agentType === 'codex';
  }

  private getGrokClientIdentifier(): string | undefined {
    return this.options.agentConfig?.cliType === 'builtin' &&
      this.options.agentConfig.agentType === 'grok'
      ? `lody:${this.options.sessionId}`
      : undefined;
  }

  private getDevinClientCapabilitiesMeta(): Record<string, unknown> | undefined {
    return this.options.agentConfig?.agentType === 'devin'
      ? { 'cognition.ai/subagentSupport': true }
      : undefined;
  }

  private getSessionStartMeta(forkSessionTurnId?: string) {
    const clientIdentifier = this.getGrokClientIdentifier();
    const modelId = this.currentModel?.modelId ?? this.options.modelId;
    const extPayload = {
      ...(this.worktreeProject ? { worktreeProject: this.worktreeProject } : {}),
      ...(forkSessionTurnId !== undefined
        ? { forkAtTurn: { version: 1 as const, turnId: forkSessionTurnId } }
        : {}),
      ...(modelId || Object.keys(this.configOptionValues).length > 0
        ? {
            sessionConfig: {
              version: 1 as const,
              ...(modelId ? { modelId } : {}),
              configOptionValues: { ...this.configOptionValues },
            } satisfies SessionConfig,
          }
        : {}),
    };
    if (clientIdentifier === undefined && Object.keys(extPayload).length === 0) return {};
    return {
      _meta: {
        ...(clientIdentifier !== undefined ? { clientIdentifier } : {}),
        ...(Object.keys(extPayload).length > 0 ? { ua: extPayload, lody: extPayload } : {}),
      },
    };
  }

  private isCurrentAcpSession(acpSessionId: string): boolean {
    return this.acpSessionId !== null && acpSessionId === this.acpSessionId;
  }

  private applySessionResponseState(sessionResponse: acp.NewSessionResponse): void {
    this.currentModel = undefined;
    this.applyConfigOptionsState(
      sessionResponse.configOptions ?? [],
      sessionResponse.configOptions !== undefined
    );
    this.legacySessionModelState = readLegacySessionModelState(sessionResponse) ?? null;
    const initialModelOption = this.findConfigOptionByCategory('model');
    if (
      initialModelOption?.type === 'select' &&
      typeof initialModelOption.currentValue === 'string'
    ) {
      this.currentModel = this.resolveModelInfo(initialModelOption.currentValue);
    } else if (this.legacySessionModelState?.currentModelId) {
      this.currentModel = this.resolveModelInfo(this.legacySessionModelState.currentModelId);
    }
  }

  private applyConfigOptionsState(
    configOptions: readonly acp.SessionConfigOption[],
    replaceConfigOptionValues: boolean
  ): void {
    this.configOptions = filterAcpConfigOptions(configOptions);
    if (replaceConfigOptionValues) {
      for (const configId of Object.keys(this.configOptionValues)) {
        delete this.configOptionValues[configId];
      }
      for (const option of this.configOptions) {
        if (typeof option.currentValue === 'string' || typeof option.currentValue === 'boolean') {
          this.configOptionValues[option.id] = option.currentValue;
        }
      }
    }

    const modelOption = this.findConfigOptionByCategory('model');
    if (modelOption?.type === 'select' && typeof modelOption.currentValue === 'string') {
      this.currentModel = this.resolveModelInfo(modelOption.currentValue);
    } else if (this.currentModel) {
      this.currentModel = this.resolveModelInfo(this.currentModel.modelId);
    } else {
      this.currentModel = undefined;
    }
    for (const listener of this.configOptionsListeners) listener();
  }

  private retainLegacyConfigOptionValue(configId: string, value: AcpConfigOptionValue): void {
    this.configOptionValues[configId] = value;
    this.configOptions = this.configOptions.map((option) => {
      if (option.id !== configId) return option;
      if (option.type === 'select' && typeof value === 'string') {
        return { ...option, currentValue: value };
      }
      if (option.type === 'boolean' && typeof value === 'boolean') {
        return { ...option, currentValue: value };
      }
      return option;
    });
    for (const listener of this.configOptionsListeners) listener();
  }

  async startSession(
    stream: acp.Stream,
    workdir: string,
    resumeSessionId?: ACPSessionId,
    timeoutOptions: AcpStartupTimeoutOptions = {},
    startupAbort?: Promise<never>,
    forkSessionId?: ACPSessionId,
    forkSessionTurnId?: string
  ): Promise<acp.NewSessionResponse> {
    this.markSubagentsDisconnected();
    this.subagentSnapshots.clear();
    const connection = new acp.ClientSideConnection(() => this, stream);
    this.connection = connection;
    connection.signal.addEventListener(
      'abort',
      () => {
        if (this.connection === connection) this.markSubagentsDisconnected();
      },
      { once: true }
    );
    const grokClientIdentifier = this.getGrokClientIdentifier();
    const devinClientCapabilitiesMeta = this.getDevinClientCapabilitiesMeta();
    this.worktreeProject = undefined;
    this.logger.debug(
      `[${this.options.sessionId}] Starting ACP client (workdir=${workdir} resumeSessionId=${
        resumeSessionId ?? 'none'
      } forkSessionId=${forkSessionId ?? 'none'})`
    );
    if (resumeSessionId && forkSessionId) {
      throw new Error(
        '[ACP_SESSION_START_INVALID] resumeSessionId and forkSessionId are exclusive'
      );
    }

    const externalMcpLoad = this.options.loadExternalMcpServers?.();
    externalMcpLoad?.catch(() => undefined);

    const initStart = performance.now();
    this.options.onStartupStage?.({ type: 'initialize_start' });

    const ACP_INIT_TIMEOUT_MS = Math.max(
      0,
      timeoutOptions.initTimeoutMs ?? DEFAULT_ACP_INIT_TIMEOUT_MS
    );

    const clientExtensionCaps: ClientExtensionCapabilities = {
      elicitation: { version: 1, answerNotes: true },
      subagentEvents: { version: 1 },
    };

    const initResponse = await withTimeout(
      withAbort(
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          ...(grokClientIdentifier ? { _meta: { clientIdentifier: grokClientIdentifier } } : {}),
          clientCapabilities: {
            terminal: this.terminalEnabled,
            plan: {},
            auth: {
              terminal: true,
            },
            session: {
              configOptions: {
                boolean: {},
              },
            },
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            elicitation: {
              form: {},
            },
            _meta: {
              ...devinClientCapabilitiesMeta,
              ua: clientExtensionCaps,
              lody: clientExtensionCaps,
            },
          },
        }),
        startupAbort
      ),
      this.logger,
      'connection.initialize',
      this.options.sessionId,
      ACP_INIT_TIMEOUT_MS
    );

    const initDurationMs = performance.now() - initStart;
    this.options.onStartupStage?.({ type: 'initialize_end', durationMs: initDurationMs });
    this.logger.debug(
      `[${this.options.sessionId}] ACP initialize finished in ${Math.round(initDurationMs)}ms`
    );
    this.authMethods = [...(initResponse.authMethods ?? [])];

    const loadSessionCapability = initResponse.agentCapabilities?.loadSession;
    this.supportsLoadSession = !!loadSessionCapability;
    const hasLoadSessionMethod = typeof connection.loadSession === 'function';

    const resumeCapability = initResponse.agentCapabilities?.sessionCapabilities?.resume;
    this.supportsResume = !!resumeCapability;
    this.supportsHttpMcp = initResponse.agentCapabilities?.mcpCapabilities?.http === true;
    const hasResumeMethod = typeof connection.resumeSession === 'function';

    const closeCapability = initResponse.agentCapabilities?.sessionCapabilities?.close;
    this.supportsClose = !!closeCapability;
    const forkCapability = initResponse.agentCapabilities?.sessionCapabilities?.fork;
    this.supportsFork = !!forkCapability;

    const extensionMeta = initResponse.agentCapabilities?._meta as
      | Record<string, unknown>
      | null
      | undefined;
    this.extensionCapabilities = parseExtensionCapabilities(extensionMeta);
    this.supportsForkAtTurn = this.extensionCapabilities.forkAtTurn?.version === 1;
    this.acknowledgedSteerCapability = parseAcknowledgedSteerCapability(extensionMeta);

    const hasForkMethod = typeof connection.unstable_forkSession === 'function';

    if (
      this.extensionCapabilities.worktreeProject?.version === 1 &&
      this.options.resolveWorktreeProject
    ) {
      this.worktreeProject = await withAbort(this.options.resolveWorktreeProject(), startupAbort);
    }
    const sessionStartMeta = this.getSessionStartMeta();

    const newSessionStart = performance.now();
    this.options.onStartupStage?.({ type: 'new_session_start' });
    let sessionResponse: acp.NewSessionResponse;
    const mcpServers = await this.buildMcpServers(externalMcpLoad);

    const canLoadSession = this.supportsLoadSession && hasLoadSessionMethod;
    const canResumeSession = this.supportsResume && hasResumeMethod;
    const canForkSession = this.supportsFork && hasForkMethod;

    const preferResumeOverLoad =
      this.options.agentConfig?.cliType === 'builtin' &&
      (this.options.agentConfig.agentType === 'kimi' ||
        this.options.agentConfig.agentType === 'pi');
    const shouldResume = Boolean(
      resumeSessionId && canResumeSession && (preferResumeOverLoad || !canLoadSession)
    );
    const shouldLoad = Boolean(resumeSessionId && canLoadSession && !shouldResume);

    if (forkSessionId && !canForkSession) {
      const reasons: string[] = [];
      if (!this.supportsFork) {
        reasons.push('agent_did_not_advertise_session_fork');
      }
      if (!hasForkMethod) {
        reasons.push('sdk_missing_forkSession');
      }
      const reason = reasons.join(', ');
      throw new Error(`[ACP_FORK_UNSUPPORTED] ${reason}`);
    }
    if (forkSessionId && forkSessionTurnId && !this.supportsForkAtTurn) {
      throw new Error('[ACP_FORK_AT_TURN_UNSUPPORTED] agent_did_not_advertise_lody_forkAtTurn');
    }

    if (resumeSessionId && !canLoadSession && !canResumeSession) {
      const reasons: string[] = [];
      if (!this.supportsLoadSession && !this.supportsResume) {
        reasons.push('agent_did_not_advertise_resume_or_loadSession');
      }
      if (!hasLoadSessionMethod && !hasResumeMethod) {
        reasons.push('sdk_missing_loadSession_and_resumeSession');
      }
      const reason = reasons.join(', ');
      throw new Error(`[ACP_RESUME_UNSUPPORTED] ${reason}`);
    }

    if (forkSessionId) {
      try {
        const ACP_FORK_SESSION_TIMEOUT_MS = Math.max(
          0,
          timeoutOptions.newSessionTimeoutMs ?? DEFAULT_ACP_NEW_SESSION_TIMEOUT_MS
        );
        sessionResponse = await withTimeout(
          withAbort(
            connection.unstable_forkSession({
              sessionId: forkSessionId as unknown as acp.SessionId,
              cwd: workdir,
              mcpServers,
              ...this.getSessionStartMeta(forkSessionTurnId),
            }),
            startupAbort
          ),
          this.logger,
          'connection.unstable_forkSession',
          this.options.sessionId,
          ACP_FORK_SESSION_TIMEOUT_MS
        );
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        throw new Error(`[ACP_FORK_FAILED] ${formatErrorMessage(error)}`, { cause: error });
      }
    } else if (resumeSessionId && shouldLoad) {
      try {
        const ACP_LOAD_SESSION_TIMEOUT_MS = Math.max(
          0,
          timeoutOptions.loadSessionTimeoutMs ??
            timeoutOptions.newSessionTimeoutMs ??
            DEFAULT_ACP_NEW_SESSION_TIMEOUT_MS
        );
        const loadResponse = await withTimeout(
          withAbort(
            connection.loadSession({
              sessionId: resumeSessionId,
              cwd: workdir,
              mcpServers,
              ...sessionStartMeta,
            }),
            startupAbort
          ),
          this.logger,
          'connection.loadSession',
          this.options.sessionId,
          ACP_LOAD_SESSION_TIMEOUT_MS
        );
        sessionResponse = {
          ...loadResponse,
          sessionId: resumeSessionId as unknown as acp.SessionId,
        };
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        throw new Error(`[ACP_RESUME_FAILED] loadSession: ${formatErrorMessage(error)}`, {
          cause: error,
        });
      }
    } else if (resumeSessionId && shouldResume) {
      try {
        const ACP_RESUME_SESSION_TIMEOUT_MS = Math.max(
          0,
          timeoutOptions.resumeSessionTimeoutMs ??
            timeoutOptions.newSessionTimeoutMs ??
            DEFAULT_ACP_NEW_SESSION_TIMEOUT_MS
        );
        const resumeResponse = await withTimeout(
          withAbort(
            connection.resumeSession({
              sessionId: resumeSessionId,
              cwd: workdir,
              mcpServers,
              ...sessionStartMeta,
            }),
            startupAbort
          ),
          this.logger,
          'connection.resumeSession',
          this.options.sessionId,
          ACP_RESUME_SESSION_TIMEOUT_MS
        );
        sessionResponse = {
          ...resumeResponse,
          sessionId: resumeSessionId as unknown as acp.SessionId,
        };
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        throw new Error(`[ACP_RESUME_FAILED] ${formatErrorMessage(error)}`, { cause: error });
      }
    } else {
      const ACP_NEW_SESSION_TIMEOUT_MS = Math.max(
        0,
        timeoutOptions.newSessionTimeoutMs ?? DEFAULT_ACP_NEW_SESSION_TIMEOUT_MS
      );
      try {
        sessionResponse = await withTimeout(
          withAbort(
            connection.newSession({ cwd: workdir, mcpServers, ...sessionStartMeta }),
            startupAbort
          ),
          this.logger,
          'connection.newSession',
          this.options.sessionId,
          ACP_NEW_SESSION_TIMEOUT_MS
        );
      } catch (error) {
        if (isAcpAuthenticationRequired(error)) {
          this.authenticationRequired = true;
          throw new AcpAuthenticationRequiredError(this.authMethods, { cause: error });
        }
        throw error;
      }
    }

    this.authenticationRequired = false;
    const newSessionDurationMs = performance.now() - newSessionStart;
    this.options.onStartupStage?.({ type: 'new_session_end', durationMs: newSessionDurationMs });
    this.applySessionResponseState(sessionResponse);

    this.acpSessionId = sessionResponse.sessionId;
    this.devinSubagentTaskIds.clear();
    this.sessionWorkdir = workdir;
    return sessionResponse;
  }

  async prepareReplacementSession(
    forkSessionTurnId?: string,
    timeoutMs: number = 120_000
  ): Promise<acp.NewSessionResponse> {
    const connection = this.connection;
    const workdir = this.sessionWorkdir;
    const sourceSessionId = this.acpSessionId;
    if (!connection || !workdir || !sourceSessionId) {
      throw new Error('[ACP_SESSION_UNAVAILABLE] Current ACP session is not ready');
    }

    const mcpServers = await this.buildMcpServers(this.options.loadExternalMcpServers?.());
    if (!forkSessionTurnId) {
      try {
        return await withTimeout(
          connection.newSession({ cwd: workdir, mcpServers, ...this.getSessionStartMeta() }),
          this.logger,
          'connection.newSession.editAndResend',
          this.options.sessionId,
          timeoutMs
        );
      } catch (error) {
        throw new Error(`[ACP_SESSION_PREPARE_FAILED] ${formatErrorMessage(error)}`, {
          cause: error,
        });
      }
    }

    if (
      !this.supportsFork ||
      !this.supportsForkAtTurn ||
      typeof connection.unstable_forkSession !== 'function'
    ) {
      throw new Error('[ACP_FORK_AT_TURN_UNSUPPORTED] Provider cannot fork at this turn');
    }

    try {
      return await withTimeout(
        connection.unstable_forkSession({
          sessionId: sourceSessionId as unknown as acp.SessionId,
          cwd: workdir,
          mcpServers,
          ...this.getSessionStartMeta(forkSessionTurnId),
        }),
        this.logger,
        'connection.unstable_forkSession.editAndResend',
        this.options.sessionId,
        timeoutMs
      );
    } catch (error) {
      throw new Error(`[ACP_FORK_FAILED] ${formatErrorMessage(error)}`, { cause: error });
    }
  }

  adoptPreparedSession(sessionResponse: acp.NewSessionResponse): void {
    this.applySessionResponseState(sessionResponse);
    this.acpSessionId = sessionResponse.sessionId;
    this.devinSubagentTaskIds.clear();
    this.authenticationRequired = false;
  }

  supportsSessionFork(): boolean {
    return this.supportsFork;
  }

  supportsActiveTurnFork(): boolean {
    return this.supportsFork && this.supportsForkAtTurn;
  }

  steerPrompt(
    sessionId: ACPSessionId,
    prompt: acp.ContentBlock[],
    options?: { signal?: AbortSignal }
  ): SteerPromptRun {
    const capability = this.acknowledgedSteerCapability;
    if (!capability) {
      throw new Error('Agent does not support acknowledged steer');
    }
    const steerId = randomUUID();
    let resolveApplication!: (lease: SteerApplicationLease) => void;
    let rejectApplication!: (error: unknown) => void;
    const applied = new Promise<SteerApplicationLease>((resolve, reject) => {
      resolveApplication = resolve;
      rejectApplication = reject;
    });
    let resolveRelease!: () => void;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      resolveRelease();
    };
    const waiter: SteerApplicationWaiter = {
      sessionId,
      applied: false,
      resolve: resolveApplication,
      reject: rejectApplication,
      released: new Promise<void>((resolve) => {
        resolveRelease = resolve;
      }),
      release,
    };
    this.steerApplicationWaiters.set(steerId, waiter);

    let completion: Promise<acp.PromptResponse | undefined>;
    let submission: Promise<unknown>;
    if (capability.requestMethod) {
      const activePrompt = this.activePromptCompletion;
      if (!activePrompt || activePrompt.sessionId !== sessionId) {
        this.steerApplicationWaiters.delete(steerId);
        waiter.release();
        throw new Error('No active ACP prompt completion is available for steer handoff');
      }
      completion = activePrompt.promise;
      submission = this.requestSteeringExtension(
        capability.requestMethod,
        sessionId,
        prompt,
        steerId,
        options?.signal
      );
    } else {
      completion = this.prompt(sessionId, prompt, {
        signal: options?.signal,
        _meta: buildSteerRequestMeta(capability, steerId),
      });
      submission = completion;
    }
    const failUnapplied = (error: unknown) => {
      if (!waiter.applied && this.steerApplicationWaiters.get(steerId) === waiter) {
        this.steerApplicationWaiters.delete(steerId);
        waiter.reject(error);
        waiter.release();
      }
    };
    if (submission !== completion) {
      void submission.catch(failUnapplied);
    }
    void Promise.allSettled([submission, completion]).then(([submitted]) => {
      failUnapplied(
        submitted.status === 'rejected'
          ? submitted.reason
          : new Error(`Steer ${steerId} completed before application`)
      );
    });
    const outcome: Promise<SteerOutcomeResult> = applied.then(
      (application) => ({ outcome: 'applied', application }),
      (error: unknown) => ({
        outcome: error instanceof AgentSteerNotDeliveredError ? 'not-applied' : 'unknown',
        error,
      })
    );
    return { completion, outcome };
  }

  private async requestSteeringExtension(
    method: string,
    sessionId: ACPSessionId,
    prompt: acp.ContentBlock[],
    steerId: string,
    signal?: AbortSignal
  ): Promise<void> {
    let request: Promise<unknown>;
    try {
      this.ensureSessionMatch(sessionId);
      const connection = this.connection;
      if (!connection) {
        throw new Error('ACP connection is not available');
      }
      if (signal?.aborted) {
        throw new Error('Agent steer aborted');
      }
      request = connection.request<
        unknown,
        {
          sessionId: string;
          prompt: acp.ContentBlock[];
          steerId: string;
        }
      >(method, { sessionId, prompt, steerId });
      this.trackPendingExecution(request);
    } catch (error) {
      throw new AgentSteerNotDeliveredError(
        `Could not submit acknowledged steer ${steerId}: ${formatErrorMessage(error)}`,
        error
      );
    }
    let abortListener: (() => void) | undefined;
    const abort = signal
      ? new Promise<never>((_, reject) => {
          abortListener = () => reject(new Error('Agent steer aborted'));
          signal.addEventListener('abort', abortListener, { once: true });
        })
      : undefined;
    try {
      const response = await withAbort(request, abort).catch((error: unknown) => {
        throw isAcpInvalidRequestError(error)
          ? new AgentSteerNotDeliveredError(
              `Agent refused the acknowledged steer request ${method}: ${formatErrorMessage(error)}`,
              error
            )
          : error;
      });
      const parsed = z.object({ outcome: z.enum(['injected', 'failed']) }).safeParse(response);
      if (!parsed.success) {
        throw new Error(`Agent returned an invalid acknowledged steer response for ${method}`);
      }
      if (parsed.data.outcome === 'failed') {
        throw new AgentSteerNotDeliveredError(
          `Agent reported that acknowledged steer ${steerId} was not applied`
        );
      }
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }

  reportsSessionActivity(): boolean {
    return this.extensionCapabilities.sessionActivity?.version === 1;
  }

  getNativeWork(): NativeAgentWork {
    const activity = this.nativeActivity;
    if (!activity || activity.sessionId !== this.acpSessionId) return null;
    if (activity.state !== 'idle') return 'running';
    return activity.backgroundTaskCount > 0 ? 'background' : null;
  }

  get pendingPromptCompletion(): Promise<void> | null {
    return this.pendingPrompts.size > 0
      ? Promise.allSettled([...this.pendingPrompts]).then(() => undefined)
      : null;
  }

  private trackPendingExecution(request: Promise<unknown>): void {
    this.pendingPrompts.add(request);
    const release = () => {
      this.pendingPrompts.delete(request);
    };
    void request.then(release, release);
  }

  async prompt(
    sessionId: ACPSessionId,
    prompt: acp.ContentBlock[],
    options?: {
      signal?: AbortSignal;
      _meta?: acp.PromptRequest['_meta'];
      goalControl?: GoalPromptControl;
    }
  ) {
    const goalPrompt = options?.goalControl
      ? this.buildGoalControlPrompt(prompt, options.goalControl)
      : null;
    if (goalPrompt) {
      prompt = goalPrompt.prompt;
    }
    this.logger.debug(
      `[${this.options.sessionId}] AgentClient.prompt called (acpSessionId=${sessionId})`
    );
    try {
      this.ensureSessionMatch(sessionId);
      const abortSignal = options?.signal;
      if (abortSignal?.aborted) {
        throw new Error('Agent prompt aborted');
      }
      const promptMeta = goalPrompt?._meta ?? options?._meta;
      const promptPromise = this.connection?.prompt({
        sessionId,
        prompt,
        ...(promptMeta ? { _meta: promptMeta } : {}),
      });
      if (!promptPromise) {
        this.logger.error(
          `[${this.options.sessionId}] connection.prompt returned undefined - connection may be closed`
        );
        return undefined;
      }

      this.trackPendingExecution(promptPromise);

      let abortListener: (() => void) | undefined;
      let trackedPromptCompletion: ActivePromptCompletion | undefined;

      try {
        const abortPromise = abortSignal
          ? new Promise<never>((_, reject) => {
              abortListener = () => {
                this.logger.debug(
                  `[${this.options.sessionId}] AgentClient.prompt aborted; sending ACP cancel (acpSessionId=${sessionId})`
                );
                void this.cancel(sessionId).catch((error: unknown) => {
                  this.logger.debug(
                    `[${this.options.sessionId}] Failed to cancel aborted prompt: ${formatErrorMessage(error)}`
                  );
                });
                reject(new Error('Agent prompt aborted'));
              };
              abortSignal.addEventListener('abort', abortListener, { once: true });
            })
          : null;
        const completion = abortPromise
          ? Promise.race([promptPromise, abortPromise])
          : promptPromise;
        trackedPromptCompletion = { sessionId, promise: completion };
        this.activePromptCompletion = trackedPromptCompletion;
        return await completion;
      } catch (error) {
        this.logger.error(
          `[${this.options.sessionId}] connection.prompt failed (${this.describePromptDiagnosticContext()}): ${formatErrorMessage(error)}`
        );
        throw error;
      } finally {
        if (this.activePromptCompletion === trackedPromptCompletion) {
          this.activePromptCompletion = null;
        }
        if (abortSignal && abortListener) {
          abortSignal.removeEventListener('abort', abortListener);
        }
      }
    } finally {
      this.completeCodexRetryStatus();
    }
  }

  async cancel(sessionId: ACPSessionId) {
    this.ensureSessionMatch(sessionId);
    return await this.connection?.cancel({ sessionId });
  }

  async closeSession(sessionId: ACPSessionId, timeoutMs: number = 5000): Promise<boolean> {
    this.ensureSessionMatch(sessionId);
    return await this.closeDetachedSession(sessionId, timeoutMs);
  }

  async closeDetachedSession(sessionId: ACPSessionId, timeoutMs: number = 5000): Promise<boolean> {
    if (!this.supportsClose) {
      this.logger.debug(
        `[${this.options.sessionId}] Skipping ACP session close: agent did not advertise session.close`
      );
      return false;
    }

    const closeSession = this.connection?.closeSession;
    if (typeof closeSession !== 'function') {
      return false;
    }

    await withTimeout(
      closeSession.call(this.connection, { sessionId }),
      this.logger,
      'connection.closeSession',
      this.options.sessionId,
      timeoutMs,
      Math.min(timeoutMs, 1000)
    );
    return true;
  }

  async setSessionConfigOption(
    sessionId: ACPSessionId,
    configId: string,
    value: AcpConfigOptionValue
  ): Promise<acp.SessionConfigOption[] | undefined> {
    const request =
      typeof value === 'boolean'
        ? { sessionId, configId, type: 'boolean' as const, value }
        : { sessionId, configId, value };
    this.ensureSessionMatch(sessionId);

    const result = await withTransportRetry(
      async () => {
        const promise = this.connection?.setSessionConfigOption(request);
        return promise ? await promise : undefined;
      },
      this.logger,
      'setSessionConfigOption',
      this.options.sessionId
    );

    if (result?.configOptions !== undefined) {
      this.applyConfigOptionsState(result.configOptions, true);
    } else if (result) {
      this.retainLegacyConfigOptionValue(configId, value);
    }

    return result?.configOptions;
  }

  getConfigOptions(): acp.SessionConfigOption[] {
    return this.configOptions;
  }

  subscribeConfigOptions(listener: () => void): () => void {
    this.configOptionsListeners.add(listener);
    return () => {
      this.configOptionsListeners.delete(listener);
    };
  }

  getAutomaticToolPermissionOutcome(
    request: acp.RequestPermissionRequest,
    pending: boolean
  ): acp.RequestPermissionResponse['outcome'] | undefined {
    if (request.sessionId !== this.acpSessionId) return undefined;
    return getBuiltinToolPermissionOutcome({
      agentConfig: this.options.agentConfig,
      configOptions: this.configOptions,
      request,
      pending,
    });
  }

  private findConfigOptionByCategory(category: string): acp.SessionConfigOption | undefined {
    return this.configOptions.find((opt) => opt.category === category);
  }

  private resolveModelInfo(modelId: string): ModelInfo {
    const base: ModelInfo = {
      modelId,
      name:
        this.findModelConfigOptionName(modelId) ??
        this.legacySessionModelState?.availableModels.find((model) => model.modelId === modelId)
          ?.name ??
        modelId,
    };
    return this.attachThoughtLevel(base);
  }

  private attachThoughtLevel(model: ModelInfo): ModelInfo {
    const label = this.getCurrentThoughtLevelLabel();
    if (!label) return model;
    return {
      ...model,
      _meta: { ...(model._meta ?? {}), [MODEL_THOUGHT_LEVEL_META_KEY]: label },
    };
  }

  private getCurrentThoughtLevelLabel(): string | undefined {
    const opt = this.configOptions.find(
      (o) => o.category === 'thought_level' || o.id === 'reasoning_effort'
    );
    if (!opt || opt.type !== 'select') return undefined;
    return this.findSelectOptionName(opt.options, opt.currentValue);
  }

  private findModelConfigOptionName(value: string): string | undefined {
    const modelConfigOption = this.findConfigOptionByCategory('model');
    if (!modelConfigOption || modelConfigOption.type !== 'select') return undefined;
    return this.findSelectOptionName(modelConfigOption.options, value);
  }

  private findSelectOptionName(
    options: acp.SessionConfigSelectOptions,
    value: acp.SessionConfigValueId
  ): string | undefined {
    for (const entry of options) {
      if ('value' in entry) {
        if (entry.value === value) return entry.name;
      } else {
        const found = entry.options.find((opt) => opt.value === value);
        if (found) return found.name;
      }
    }
    return undefined;
  }

  private shouldUseProtocolSetModeRouting(): boolean {
    return this.options.agentConfig?.agentType === 'codex';
  }

  async setSessionMode(sessionId: ACPSessionId, modeId: string) {
    this.ensureSessionMatch(sessionId);

    const modeConfigOption = !this.shouldUseProtocolSetModeRouting()
      ? this.findConfigOptionByCategory('mode')
      : undefined;
    if (modeConfigOption) {
      try {
        await this.setSessionConfigOption(sessionId, modeConfigOption.id, modeId);
        return;
      } catch {
        // Fall through to legacy setSessionMode path below
      }
    }

    await withTransportRetry(
      async () => {
        const setModePromise = this.connection?.setSessionMode({ sessionId, modeId });
        if (setModePromise) {
          await setModePromise;
        }
      },
      this.logger,
      'setSessionMode',
      this.options.sessionId
    );
  }

  async unstable_setSessionModel(sessionId: ACPSessionId, modelId: string) {
    this.ensureSessionMatch(sessionId);

    const modelConfigOption = this.findConfigOptionByCategory('model');
    if (modelConfigOption) {
      try {
        const updatedConfigOptions = await this.setSessionConfigOption(
          sessionId,
          modelConfigOption.id,
          modelId
        );
        if (!updatedConfigOptions) return;
        this.currentModel = this.resolveModelInfo(modelId);
        return;
      } catch (error) {
        if (!this.legacySessionModelState || !isAcpMethodNotFoundError(error)) {
          throw error;
        }
      }
    }

    if (!this.legacySessionModelState) {
      throw new Error(
        `[ACP_MODEL_SWITCH_UNSUPPORTED] Agent reported neither a model config option nor legacy session models`
      );
    }

    const connection = this.connection;
    if (!connection) {
      throw new Error('[ACP_MODEL_SWITCH_UNSUPPORTED] ACP connection is not available');
    }
    const switched = await withTransportRetry(
      async () => {
        await connection.request<unknown, { sessionId: string; modelId: string }>(
          'session/set_model',
          { sessionId, modelId }
        );
        return true;
      },
      this.logger,
      'setSessionModel',
      this.options.sessionId
    );
    if (!switched) return;
    this.currentModel = this.resolveModelInfo(modelId);
  }

  private ensureSessionMatch(sessionId: ACPSessionId) {
    if (!this.acpSessionId) {
      throw new Error('ACP session has not been initialized yet.');
    }
    if (sessionId !== this.acpSessionId) {
      throw new Error(`Mismatched ACP session. Expected ${this.acpSessionId} but got ${sessionId}`);
    }
  }

  private resolvePath(inputPath: string): string {
    const base = this.sessionWorkdir ?? process.cwd();
    return path.resolve(base, inputPath);
  }
}

function isUsageUpdate(
  update: unknown
): update is { sessionUpdate: 'usage_update'; size?: unknown; used?: unknown } {
  return (
    typeof update === 'object' &&
    update !== null &&
    'sessionUpdate' in update &&
    (update as { sessionUpdate?: unknown }).sessionUpdate === 'usage_update'
  );
}

const sliceTextByLines = (content: string, line: number | null, limit: number | null): string => {
  if (line === null && limit === null) return content;
  const lines = content.split(/\r?\n/);
  const start = Math.max((line ?? 1) - 1, 0);
  const end = limit !== null ? start + Math.max(limit, 0) : undefined;
  return lines.slice(start, end).join('\n');
};
