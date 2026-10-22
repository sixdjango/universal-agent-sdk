import type * as acp from '@agentclientprotocol/sdk';
import type {
  ExtensionCapabilities,
  RateLimit,
  RateLimitsGetRequest,
  RateLimitsSnapshot,
  SessionUsageUpdate,
  SubagentEvent,
  WorktreeProject,
} from '@universal-agent/acp-extension-core';
import { isSubagentEvent } from '@universal-agent/acp-extension-core';
import { z } from 'zod';
import type { BuiltinAgentType } from './launcher/executable-resolver';
import type { AcpStartupTimeoutOptions } from './launcher/npx-cache';
import type { RegistryAgentId } from './launcher/registry';
import type { CustomAcpLaunchSpec } from './launcher/setting';
import type { Logger } from './process/stream';
import type { TerminalManager } from './process/terminal-manager';
import type { AgentClient } from './client/agent-client';

export type {
  BuiltinAgentType,
  RegistryAgentId,
  CustomAcpLaunchSpec,
  Logger,
  TerminalManager,
  AcpStartupTimeoutOptions,
};

export type AgentConfigCliType = 'builtin' | 'registry' | 'custom';
export type ACPSessionId = string;
export type SessionId = string;
export type AcpConfigOptionValue = string | boolean;

export type ModelId = string;
export type ModelInfo = {
  _meta?: { [key: string]: unknown } | null;
  description?: string | null;
  modelId: ModelId;
  name: string;
};

export const MODEL_THOUGHT_LEVEL_META_KEY = 'lodyThoughtLevel';

export type AcpConfigOptionValueSummary = {
  value: string;
  name: string;
  description?: string;
  group?: string;
};

export type AcpConfigOptionSummary = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: 'select' | 'boolean';
  currentValue: AcpConfigOptionValue;
  options: AcpConfigOptionValueSummary[];
};

export type AcpCommandSummary = {
  name: string;
  description?: string;
};

export type AcpModelControls = {
  effortValues?: string[];
  fastMode?: boolean;
};

export type SessionContextWindowUsage = {
  size: number;
  used: number;
};

export type SessionGoalAction = 'set' | 'pause' | 'resume' | 'clear';

export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'
  | 'cleared';

export type SessionGoalContent = {
  type: 'goal';
  threadId: string;
  turnId?: string | null;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  updatedAt?: number;
};

export function sanitizeGoalObjective(objective: string): string {
  return objective.replace(/\r\n/g, '\n').trim();
}

export type SessionTurnInputConfig = {
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

export type SessionAcpRuntimeConfigPatch = {
  acpSessionId: ACPSessionId;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

export type AgentSessionWarning = {
  message: string;
  source?: string;
};

export type AcpWriteTextFileEvidence = {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
};

export type ImageGenerationBeginEvent = {
  acpSessionId: ACPSessionId;
  callId: string;
};

export type ImageGenerationEndEvent = {
  acpSessionId: ACPSessionId;
  callId: string;
  status: string;
  revisedPrompt?: string;
  savedPath?: string;
  image?: {
    data: string;
    mimeType: string;
    uri?: string;
  };
};

export type AcpStartupStageEvent =
  | { type: 'initialize_start' }
  | { type: 'initialize_end'; durationMs: number }
  | { type: 'new_session_start' }
  | { type: 'new_session_end'; durationMs: number };

export type SteerApplicationLease = {
  release: () => void;
};

export type SteerOutcome = 'applied' | 'not-applied' | 'unknown';

export type SteerOutcomeResult =
  | { outcome: 'applied'; application: SteerApplicationLease }
  | { outcome: 'not-applied'; error: unknown }
  | { outcome: 'unknown'; error: unknown };

export type SteerPromptRun = {
  completion: Promise<acp.PromptResponse | undefined>;
  outcome: Promise<SteerOutcomeResult>;
};

// ============================================================================
// ACP Session Notification Zod Schema & Parser
// ============================================================================

const zMeta = z.record(z.string(), z.unknown()).nullish();

const withMeta = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      ...shape,
      _meta: zMeta,
    })
    .passthrough();

const zAnnotations = withMeta({
  audience: z.array(z.enum(['assistant', 'user'])).nullish(),
  lastModified: z.string().nullish(),
  priority: z.number().nullish(),
});

export const zContentBlock = z.discriminatedUnion('type', [
  withMeta({
    type: z.literal('text'),
    text: z.string(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
    uri: z.string().nullish(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('audio'),
    data: z.string(),
    mimeType: z.string(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('resource_link'),
    name: z.string(),
    uri: z.string(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    mimeType: z.string().nullish(),
    size: z.number().nullish(),
    annotations: zAnnotations.nullish(),
  }),
  withMeta({
    type: z.literal('resource'),
    resource: z.union([
      withMeta({ uri: z.string(), text: z.string(), mimeType: z.string().nullish() }),
      withMeta({ uri: z.string(), blob: z.string(), mimeType: z.string().nullish() }),
    ]),
    annotations: zAnnotations.nullish(),
  }),
]);

const zToolKind = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
const zToolCallStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);
const zToolCallLocation = withMeta({
  path: z.string(),
  line: z.number().int().nonnegative().nullish(),
});
const zToolCallContent = z.union([
  withMeta({ type: z.literal('content'), content: zContentBlock }),
  withMeta({
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string().nullish(),
    newText: z.string(),
  }),
  withMeta({ type: z.literal('terminal'), terminalId: z.string() }),
]);

export const zToolCall = withMeta({
  toolCallId: z.string(),
  title: z.string(),
  kind: zToolKind.optional(),
  status: zToolCallStatus.optional(),
  content: z.array(zToolCallContent).optional(),
  locations: z.array(zToolCallLocation).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

export const zToolCallUpdate = withMeta({
  toolCallId: z.string(),
  kind: zToolKind.nullish(),
  status: zToolCallStatus.nullish(),
  title: z.string().nullish(),
  content: z.array(zToolCallContent).nullish(),
  locations: z.array(zToolCallLocation).nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

const zPlanEntry = withMeta({
  content: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export const zPlan = withMeta({ entries: z.array(zPlanEntry) });

const zPlanUpdateContent = z.discriminatedUnion('type', [
  withMeta({ type: z.literal('items'), planId: z.string(), entries: z.array(zPlanEntry) }),
  withMeta({ type: z.literal('file'), planId: z.string(), uri: z.string() }),
  withMeta({ type: z.literal('markdown'), planId: z.string(), content: z.string() }),
]);

const zAvailableCommand = withMeta({
  name: z.string(),
  description: z.string(),
  input: withMeta({ hint: z.string() }).nullish(),
});

export const zAvailableCommandsUpdate = withMeta({
  availableCommands: z.array(zAvailableCommand),
});

export const zCurrentModeUpdate = withMeta({ currentModeId: z.string() });

export const zConfigOptionUpdate = withMeta({
  configOptions: z.array(z.record(z.string(), z.unknown())),
});

const zContentChunk = withMeta({
  content: zContentBlock,
  messageId: z.string().nullish(),
});

export const zSessionUpdate = z.discriminatedUnion('sessionUpdate', [
  withMeta({
    sessionUpdate: z.literal('subagent_event'),
    event: z.custom<SubagentEvent>(isSubagentEvent),
  }),
  zContentChunk.extend({ sessionUpdate: z.literal('user_message_chunk') }),
  zContentChunk.extend({ sessionUpdate: z.literal('agent_message_chunk') }),
  zContentChunk.extend({ sessionUpdate: z.literal('agent_thought_chunk') }),
  zToolCall.extend({ sessionUpdate: z.literal('tool_call') }),
  zToolCallUpdate.extend({ sessionUpdate: z.literal('tool_call_update') }),
  zPlan.extend({ sessionUpdate: z.literal('plan') }),
  withMeta({ sessionUpdate: z.literal('plan_update'), plan: zPlanUpdateContent }),
  withMeta({ sessionUpdate: z.literal('plan_removed'), planId: z.string() }),
  zAvailableCommandsUpdate.extend({ sessionUpdate: z.literal('available_commands_update') }),
  zCurrentModeUpdate.extend({ sessionUpdate: z.literal('current_mode_update') }),
  zConfigOptionUpdate.extend({ sessionUpdate: z.literal('config_option_update') }),
  withMeta({
    sessionUpdate: z.literal('session_info_update'),
    title: z.string().nullish(),
    updatedAt: z.string().nullish(),
  }),
  withMeta({
    sessionUpdate: z.literal('usage_update'),
    used: z.number(),
    size: z.number(),
    cost: withMeta({ amount: z.number(), currency: z.string() }).nullish(),
  }),
]);

export const zSessionNotification = withMeta({
  sessionId: z.string(),
  update: zSessionUpdate,
});

export type AcpSessionUpdate =
  | acp.SessionUpdate
  | {
      sessionUpdate: 'subagent_event';
      event: SubagentEvent;
      _meta?: Record<string, unknown> | null;
    }
  | {
      sessionUpdate: 'plan_update';
      plan: z.infer<typeof zPlanUpdateContent>;
      _meta?: Record<string, unknown> | null;
    }
  | {
      sessionUpdate: 'plan_removed';
      planId: string;
      _meta?: Record<string, unknown> | null;
    };

export type AcpSessionNotification = Omit<acp.SessionNotification, 'update'> & {
  update: AcpSessionUpdate;
};

export const parseSessionNotification = (value: unknown): AcpSessionNotification => {
  return zSessionNotification.parse(value) as AcpSessionNotification;
};

// ============================================================================
// High-Level Host SDK Options & Session Handle (Section 6 of Plan)
// ============================================================================

export type AgentLaunchTarget =
  | {
      cliType: 'builtin';
      agentType: BuiltinAgentType;
      /** Optional: override local default detected CLI executable path */
      executablePath?: string;
      /** Optional: Pi extension paths */
      piExtensions?: string[];
      /** Optional: DeepSeek Provider isolation identifier */
      providerId?: string;
      extraArgs?: string[];
    }
  | {
      cliType: 'registry';
      agentType: RegistryAgentId | (string & {});
      /** Optional: override local executable path */
      executablePath?: string;
      extraArgs?: string[];
    }
  | {
      cliType: 'custom';
      agentType: string;
      command: string;
      args?: string[];
    };

export type StartAgentSessionOptions = {
  /** Optional host session identifier (defaults to a random UUID) */
  sessionId?: string;
  /** Structured launch target (builtin, registry, or custom) */
  target?: AgentLaunchTarget;
  /** Builtin Agent type, Registry Agent ID (e.g. 'antigravity-acp', 'antigravity', 'gemini', 'cursor', 'opencode'), or 'custom' */
  agentType?: BuiltinAgentType | RegistryAgentId | 'custom' | (string & {});
  /** Working directory */
  workdir: string;
  /** Optional: explicitly specify the local Agent CLI executable path (highest priority) */
  executablePath?: string;
  /** Required when agentType === 'custom' without `target` */
  customCommand?: CustomAcpLaunchSpec;
  /** Pi Agent extension paths */
  piExtensions?: string[];
  /** DeepSeek Provider isolation identifier */
  providerId?: string;
  /** Extra CLI arguments appended to the adapter/agent launch */
  extraArgs?: string[];
  /** Environment variables merged over login shell env */
  env?: NodeJS.ProcessEnv;
  /** Custom data directory (defaults to ~/.universal-agent) */
  dataDir?: string;

  /** Session resumption & forking */
  resumeSessionId?: string;
  forkSessionId?: string;
  forkSessionTurnId?: string;

  /** Structured initial model / mode / config options */
  initialConfig?: {
    modelId?: string;
    modeId?: string;
    configOptionValues?: Record<string, AcpConfigOptionValue>;
  };

  /** Flat initial model / mode / config options (shorthand alternative to `initialConfig`) */
  modelId?: string;
  modeId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;

  /** External MCP servers to mount into the session */
  mcpServers?: acp.McpServer[];
  /** Dynamically resolve MCP servers after `initialize` reports HTTP capability */
  resolveMcpServers?: (capabilities: {
    http: boolean;
  }) => Promise<acp.McpServer[]> | acp.McpServer[];

  /** Optional worktree project resolver */
  resolveWorktreeProject?: () => Promise<WorktreeProject>;

  /** Core event callbacks */
  onUpdateMessage: (notification: AcpSessionNotification) => void;
  onRequestPermission: (
    requestId: string,
    request: acp.RequestPermissionRequest
  ) => Promise<acp.RequestPermissionResponse>;

  /** Optional extension callbacks */
  onUsageUpdate?: (usage: SessionUsageUpdate, accountingId?: string) => void;
  onContextWindowUsageUpdate?: (usage: SessionContextWindowUsage) => void;
  onRateLimitUpdate?: (limits: RateLimit) => void;
  onThreadGoalUpdated?: (goal: SessionGoalContent) => void;
  onThreadGoalCleared?: (threadId: string) => void;
  onSessionTitleUpdate?: (title: string) => void;
  onAgentWarning?: (warning: AgentSessionWarning) => void;
  onImageGenerationBegin?: (event: ImageGenerationBeginEvent) => void;
  onImageGenerationEnd?: (event: ImageGenerationEndEvent) => void;
  onWriteTextFile?: (evidence: AcpWriteTextFileEvidence) => void | Promise<void>;
  onStartupStage?: (stage: AcpStartupStageEvent) => void;

  /** Runtime controls */
  terminalEnabled?: boolean;
  terminalManager?: TerminalManager;
  logger?: Logger;
  signal?: AbortSignal;
  startupTimeouts?: AcpStartupTimeoutOptions;
  /** Max concurrent ACP session starts (default: 2) */
  concurrency?: number;
};

export interface ManagedAgentSession {
  readonly sessionId: string;
  readonly acpSessionId: string;
  readonly client: AgentClient;
  readonly sessionResponse: acp.NewSessionResponse;
  readonly capabilities: ExtensionCapabilities;

  /** Send a user prompt (supports text, images, files, and goal control) */
  prompt(
    blocks: acp.ContentBlock[],
    options?: {
      signal?: AbortSignal;
      _meta?: acp.PromptRequest['_meta'];
      goalControl?: { action: SessionGoalAction; objective?: string };
    }
  ): Promise<acp.PromptResponse | undefined>;

  /** Acknowledged steer into a running turn (inject-or-refuse) */
  steer(blocks: acp.ContentBlock[], options?: { signal?: AbortSignal }): SteerPromptRun;
  /** Alias for `steer` */
  steerPrompt(blocks: acp.ContentBlock[], options?: { signal?: AbortSignal }): SteerPromptRun;

  /** Safely apply runtime config in `mode -> model -> dependent options` order */
  applyConfig(config: {
    modeId?: string;
    modelId?: string;
    configOptionValues?: Record<string, AcpConfigOptionValue>;
  }): Promise<void>;

  /** Cancel the active turn */
  cancel(): Promise<void>;

  /** Dynamically switch mode / model / config options */
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setConfigOption(
    configId: string,
    value: AcpConfigOptionValue
  ): Promise<acp.SessionConfigOption[] | undefined>;
  getConfigOptions(): acp.SessionConfigOption[];

  /** Extension capabilities: subagent cancellation, out-of-band goal control, rate-limit query */
  cancelSubagent(taskId: string, reason?: string): Promise<void>;
  controlGoal(action: 'pause' | 'clear'): Promise<void>;
  getRateLimits(request?: RateLimitsGetRequest): Promise<RateLimitsSnapshot>;

  /** Gracefully close the session and terminate the entire child process tree */
  shutdown(options?: { closeSessionTimeoutMs?: number; exitTimeoutMs?: number }): Promise<void>;
}
