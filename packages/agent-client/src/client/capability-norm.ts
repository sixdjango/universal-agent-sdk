import type { SessionConfigOption, SessionConfigSelectGroup } from '@agentclientprotocol/sdk';
import {
  createPlanModeConfigOption,
  type RateLimitsCapability,
} from '@universal-agent/acp-extension-core';
import {
  DEEPSEEK_HARNESS_AGENT_PRESETS,
  DEEPSEEK_HARNESS_PERMISSION_MODES,
} from '@universal-agent/acp-extension-dsh/capabilities';
import { z } from 'zod';
import { isBuiltinAgentType, type BuiltinAgentType } from '../launcher/executable-resolver';
import type {
  AcpCommandSummary,
  AcpConfigOptionSummary,
  AcpConfigOptionValueSummary,
  AcpModelControls,
  SessionGoalAction,
} from '../types';
import { getExtensionMetaContainer } from './extension-parser';

export const FILTERED_ACP_CONFIG_OPTION_IDS: ReadonlySet<string> = new Set(['agent']);

export function filterAcpConfigOptions<T extends { id: string }>(options: readonly T[]): T[] {
  return options.filter((opt) => !FILTERED_ACP_CONFIG_OPTION_IDS.has(opt.id));
}

export type AcpCapabilitiesResult = {
  modes: Array<{ id: string; name: string; description?: string }>;
  models: Array<{ modelId: string; name?: string; description?: string }>;
  configOptions?: AcpConfigOptionSummary[];
  availableCommands?: AcpCommandSummary[];
  sessionFork: boolean;
  acknowledgedSteer: boolean;
  sessionTitle?: boolean;
  rateLimits?: RateLimitsCapability;
  goalActions?: SessionGoalAction[];
  modelReasoningEfforts?: Record<string, string[]>;
  modelCapabilities?: Record<string, AcpModelControls>;
};

export type FetchedAcpCapabilities = AcpCapabilitiesResult & {
  capabilitySourceVersion?: string;
};

function isSelectGroup(item: unknown): item is SessionConfigSelectGroup {
  return typeof item === 'object' && item !== null && 'group' in item;
}

export function normalizeConfigOptions(
  raw: SessionConfigOption[] | null | undefined
): AcpConfigOptionSummary[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const supported = filterAcpConfigOptions(raw);
  if (supported.length === 0) {
    return undefined;
  }
  return supported.map((opt) => {
    if (opt.type === 'boolean') {
      return {
        id: opt.id,
        name: opt.name,
        description: opt.description ?? undefined,
        category: opt.category ?? undefined,
        type: 'boolean' as const,
        currentValue: opt.currentValue,
        options: [],
      };
    }

    const flatOptions: AcpConfigOptionSummary['options'] = [];
    for (const entry of opt.options) {
      if (isSelectGroup(entry)) {
        for (const child of entry.options) {
          flatOptions.push({
            value: child.value,
            name: child.name,
            description: child.description ?? undefined,
            group: entry.name,
          });
        }
      } else {
        flatOptions.push({
          value: entry.value,
          name: entry.name,
          description: entry.description ?? undefined,
        });
      }
    }
    return {
      id: opt.id,
      name: opt.name,
      description: opt.description ?? undefined,
      category: opt.category ?? undefined,
      type: 'select' as const,
      currentValue: opt.currentValue,
      options: flatOptions,
    };
  });
}

const zLegacySessionModels = z.object({
  models: z
    .object({
      currentModelId: z.string().nullish(),
      availableModels: z
        .array(
          z.object({
            modelId: z.string(),
            name: z.string().nullish(),
            description: z.string().nullish(),
          })
        )
        .nullish(),
    })
    .nullish(),
});

export type LegacySessionModelState = {
  currentModelId?: string;
  availableModels: AcpCapabilitiesResult['models'];
};

const zSessionAvailableCommands = z.object({
  availableCommands: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().nullish(),
      })
    )
    .nullish(),
});

export function readLegacySessionModelState(
  sessionResponse: unknown
): LegacySessionModelState | undefined {
  const parsed = zLegacySessionModels.safeParse(sessionResponse);
  const modelState = parsed.success ? parsed.data.models : undefined;
  if (!modelState) {
    return undefined;
  }
  return {
    currentModelId: modelState.currentModelId ?? undefined,
    availableModels: (modelState.availableModels ?? []).map((model) => ({
      modelId: model.modelId,
      name: model.name ?? undefined,
      description: model.description ?? undefined,
    })),
  };
}

function readSessionAvailableCommands(
  sessionResponse: unknown
): AcpCapabilitiesResult['availableCommands'] {
  const parsed = zSessionAvailableCommands.safeParse(sessionResponse);
  if (!parsed.success || parsed.data.availableCommands == null) {
    return undefined;
  }
  return parsed.data.availableCommands.map((command) => ({
    name: command.name,
    description: command.description ?? undefined,
  }));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseModelControls = (value: unknown): AcpModelControls | undefined => {
  if (!isRecord(value)) return undefined;
  const controls: AcpModelControls = {};
  if (value.effortValues !== undefined) {
    if (
      !Array.isArray(value.effortValues) ||
      !value.effortValues.every((effort) => typeof effort === 'string')
    ) {
      return undefined;
    }
    controls.effortValues = [...value.effortValues];
  }
  if (value.fastMode !== undefined) {
    if (typeof value.fastMode !== 'boolean') return undefined;
    controls.fastMode = value.fastMode;
  }
  return controls;
};

const parseModels = (value: unknown): Record<string, AcpModelControls> | undefined => {
  if (!isRecord(value)) return undefined;
  const models: Record<string, AcpModelControls> = {};
  for (const [modelId, controls] of Object.entries(value)) {
    const parsed = parseModelControls(controls);
    if (!parsed) return undefined;
    models[modelId] = parsed;
  }
  return Object.keys(models).length > 0 ? models : undefined;
};

export const readAcpModelCapabilitiesMeta = (
  sessionResponse: unknown
): Record<string, AcpModelControls> | undefined => {
  if (!isRecord(sessionResponse) || !isRecord(sessionResponse._meta)) return undefined;
  const container = getExtensionMetaContainer(sessionResponse._meta);
  if (!container || !isRecord(container.modelCapabilities)) return undefined;
  const declaration = container.modelCapabilities;
  return declaration.version === 1 ? parseModels(declaration.models) : undefined;
};

const zModelReasoningEfforts = z.object({
  modelReasoningEfforts: z.record(z.string(), z.array(z.string())),
});

export function readModelReasoningEfforts(
  sessionResponse: unknown
): Record<string, string[]> | undefined {
  if (!isRecord(sessionResponse) || !isRecord(sessionResponse._meta)) return undefined;
  const container = getExtensionMetaContainer(sessionResponse._meta);
  const parsed = zModelReasoningEfforts.safeParse(container);
  const map = parsed.success ? parsed.data.modelReasoningEfforts : undefined;
  return map && Object.keys(map).length > 0 ? map : undefined;
}

/** @deprecated Use `readModelReasoningEfforts`. */
export const readLodyModelReasoningEfforts = readModelReasoningEfforts;

export const deriveModelReasoningEffortsFromLegacyModelIds = (
  modelIds: readonly string[]
): Record<string, string[]> | undefined => {
  const efforts: Record<string, string[]> = {};
  for (const modelId of modelIds) {
    const match = /^(?<model>.+?)\[(?<effort>[^[\]]+)\]$/.exec(modelId);
    const model = match?.groups?.['model'];
    const effort = match?.groups?.['effort'];
    if (!model || !effort) {
      continue;
    }
    const existing = efforts[model];
    if (existing) {
      if (!existing.includes(effort)) {
        existing.push(effort);
      }
    } else {
      efforts[model] = [effort];
    }
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined;
};

type AcpSessionCapabilitiesResponse = {
  modes?: {
    availableModes?: Array<{ id: string; name: string; description?: string | null }> | null;
  } | null;
  configOptions?: SessionConfigOption[] | null;
  _meta?: Record<string, unknown> | null;
};

const usesCodexModelEffortIds = (agent?: { cliType: string; agentType: string }): boolean =>
  agent?.cliType === 'builtin' && agent.agentType === 'codex';

export function normalizeAcpSessionCapabilities(
  sessionResponse: AcpSessionCapabilitiesResponse,
  lifecycleCapabilities: {
    sessionFork?: boolean;
    acknowledgedSteer?: boolean;
    sessionTitle?: boolean;
    rateLimits?: RateLimitsCapability;
    goalActions?: SessionGoalAction[];
    agent?: { cliType: string; agentType: string };
  } = {}
): AcpCapabilitiesResult {
  const modes = (sessionResponse.modes?.availableModes ?? []).map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description ?? undefined,
  }));
  const configOptions = normalizeConfigOptions(sessionResponse.configOptions);
  const modelOption = configOptions?.find((option) => option.category === 'model');
  const modelsFromConfigOptions = (modelOption?.options ?? []).map((option) => ({
    modelId: option.value,
    name: option.name,
    description: option.description,
  }));
  const legacyModels = readLegacySessionModelState(sessionResponse)?.availableModels ?? [];
  const models = modelsFromConfigOptions.length > 0 ? modelsFromConfigOptions : legacyModels;
  const availableCommands = readSessionAvailableCommands(sessionResponse);
  const modelCapabilities = readAcpModelCapabilitiesMeta(sessionResponse);
  const modelReasoningEfforts = {
    ...readModelReasoningEfforts(sessionResponse),
    ...(usesCodexModelEffortIds(lifecycleCapabilities.agent)
      ? deriveModelReasoningEffortsFromLegacyModelIds(legacyModels.map((model) => model.modelId))
      : undefined),
  };

  return {
    modes,
    models,
    configOptions,
    availableCommands,
    sessionFork: lifecycleCapabilities.sessionFork === true,
    acknowledgedSteer: lifecycleCapabilities.acknowledgedSteer === true,
    sessionTitle: lifecycleCapabilities.sessionTitle === true,
    rateLimits: lifecycleCapabilities.rateLimits,
    ...(lifecycleCapabilities.goalActions?.length
      ? { goalActions: lifecycleCapabilities.goalActions }
      : {}),
    ...(Object.keys(modelReasoningEfforts).length > 0 ? { modelReasoningEfforts } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {}),
  };
}

// ============================================================================
// Static Builtin ACP Capabilities (Fast Path before Live Probe)
// ============================================================================

export type StaticBuiltinAcpCapabilities = {
  modes: Array<{ id: string; name: string; description?: string }>;
  models: Array<{ modelId: string; name: string; description?: string }>;
  configOptions: AcpConfigOptionSummary[];
  modelReasoningEfforts?: Record<string, string[]>;
};

export const CODEX_AUTO_REVIEW_MODE_ID = 'agent-auto-review';

const BUILTIN_DEFAULT_MODE_IDS = {
  kimi: 'auto',
  grok: 'default',
  claude: 'auto',
  codex: CODEX_AUTO_REVIEW_MODE_ID,
  deepseek: 'workspace-write',
} as const satisfies Partial<Record<BuiltinAgentType, string>>;

const CODEX_STATIC_MODES: StaticBuiltinAcpCapabilities['modes'] = [
  {
    id: 'read-only',
    name: 'Read-only',
    description: 'Requires approval to edit files and run commands.',
  },
  {
    id: 'agent',
    name: 'Agent',
    description: 'Read and edit files, and run commands.',
  },
  {
    id: CODEX_AUTO_REVIEW_MODE_ID,
    name: 'Auto review',
    description:
      'Read and edit files, and run commands. Approval requests are reviewed automatically by a Codex subagent.',
  },
  {
    id: 'agent-full-access',
    name: 'Full access',
    description:
      'Codex can edit files outside this workspace and run commands with network access. Exercise caution when using.',
  },
];

const CODEX_STATIC_MODELS: StaticBuiltinAcpCapabilities['models'] = [
  {
    modelId: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
  },
  {
    modelId: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
  },
  {
    modelId: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
  },
  {
    modelId: 'gpt-5.5',
    name: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
  },
  {
    modelId: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
  },
  {
    modelId: 'gpt-5.4-mini',
    name: 'GPT-5.4-Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
  },
];

const CODEX_REASONING_OPTIONS: AcpConfigOptionValueSummary[] = [
  { value: 'low', name: 'Low', description: 'Fastest responses' },
  { value: 'medium', name: 'Medium', description: 'Balanced reasoning' },
  { value: 'high', name: 'High', description: 'More reasoning for difficult tasks' },
  { value: 'xhigh', name: 'XHigh', description: 'Extra reasoning for complex tasks' },
];

const CODEX_STATIC_CONFIG_OPTIONS: AcpConfigOptionSummary[] = [
  {
    id: 'mode',
    name: 'Mode',
    description: 'Approval and sandboxing preset for the session',
    category: 'mode',
    type: 'select',
    currentValue: CODEX_AUTO_REVIEW_MODE_ID,
    options: CODEX_STATIC_MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description ?? undefined,
    })),
  },
  {
    id: 'model',
    name: 'Model',
    description: 'Model Codex uses for the session',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-5.6-sol',
    options: CODEX_STATIC_MODELS.map((model) => ({
      value: model.modelId,
      name: model.name,
      description: model.description ?? undefined,
    })),
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    description: 'How much reasoning effort the model should use',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: CODEX_REASONING_OPTIONS,
  },
  {
    id: 'fast-mode',
    name: 'Fast mode',
    description: '1.5x speed, increased usage',
    category: 'model_config',
    type: 'boolean',
    currentValue: false,
    options: [],
  },
  {
    ...createPlanModeConfigOption(false),
    options: [],
  },
];

const CLAUDE_STATIC_MODES: StaticBuiltinAcpCapabilities['modes'] = [
  {
    id: 'auto',
    name: 'Auto',
    description: 'Use a model classifier to approve/deny permission prompts',
  },
  {
    id: 'default',
    name: 'Manual',
    description: 'Standard behavior, prompts for dangerous operations',
  },
  {
    id: 'acceptEdits',
    name: 'Accept Edits',
    description: 'Auto-accept file edit operations',
  },
  {
    id: 'plan',
    name: 'Plan Mode',
    description: 'Planning mode, no actual tool execution',
  },
  {
    id: 'dontAsk',
    name: "Don't Ask",
    description: "Don't prompt for permissions, deny if not pre-approved",
  },
  {
    id: 'bypassPermissions',
    name: 'Bypass Permissions',
    description: 'Bypass all permission checks',
  },
];

const CLAUDE_STATIC_MODELS: StaticBuiltinAcpCapabilities['models'] = [
  {
    modelId: 'default',
    name: 'Default (recommended)',
    description: 'Opus (1M context)',
  },
  {
    modelId: 'opus[1m]',
    name: 'Opus (1M context)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
  },
  {
    modelId: 'claude-fable-5-1[1m]',
    name: 'Fable',
    description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
  },
  {
    modelId: 'sonnet',
    name: 'Sonnet',
    description: 'Sonnet 5 · Efficient for routine tasks',
  },
  {
    modelId: 'haiku',
    name: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
];

const CLAUDE_STATIC_CONFIG_OPTIONS: AcpConfigOptionSummary[] = [
  {
    id: 'mode',
    name: 'Mode',
    description: 'Session permission mode',
    category: 'mode',
    type: 'select',
    currentValue: BUILTIN_DEFAULT_MODE_IDS.claude,
    options: CLAUDE_STATIC_MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description ?? undefined,
    })),
  },
  {
    id: 'model',
    name: 'Model',
    description: 'AI model to use',
    category: 'model',
    type: 'select',
    currentValue: 'default',
    options: CLAUDE_STATIC_MODELS.map((model) => ({
      value: model.modelId,
      name: model.name,
      description: model.description ?? undefined,
    })),
  },
  {
    id: 'effort',
    name: 'Effort',
    description: 'Available effort levels for this model',
    category: 'thought_level',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Xhigh' },
      { value: 'max', name: 'Max' },
    ],
  },
  {
    id: 'fast',
    name: 'Fast mode',
    description: 'Faster responses on supported models',
    category: 'model_config',
    type: 'boolean',
    currentValue: false,
    options: [],
  },
];

const KIMI_STATIC_MODES: StaticBuiltinAcpCapabilities['modes'] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Manual approvals; tools execute normally.',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only planning; no tool execution.',
  },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Auto-approve safe operations.',
  },
  {
    id: 'yolo',
    name: 'YOLO',
    description: 'Auto-approve everything.',
  },
];

const KIMI_STATIC_CONFIG_OPTIONS: AcpConfigOptionSummary[] = [
  {
    id: 'permission_mode',
    name: 'Permission',
    category: '_permission',
    type: 'select',
    currentValue: BUILTIN_DEFAULT_MODE_IDS.kimi,
    options: KIMI_STATIC_MODES.filter((mode) => mode.id !== 'plan').map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description ?? undefined,
    })),
  },
  { ...createPlanModeConfigOption(false), options: [] },
];

const GROK_STATIC_MODES: StaticBuiltinAcpCapabilities['modes'] = [
  {
    id: 'default',
    name: 'Agent',
    description: 'Use tools and make changes when needed',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Plan and reason without modifying the workspace',
  },
];

const GROK_STATIC_MODELS: StaticBuiltinAcpCapabilities['models'] = [
  {
    modelId: 'grok-4.6',
    name: 'Grok 4.6',
    description: "SpaceXAI's latest frontier model",
  },
  {
    modelId: 'grok-4.5',
    name: 'Grok 4.5',
  },
];

const GROK_STATIC_CONFIG_OPTIONS: AcpConfigOptionSummary[] = [
  { ...createPlanModeConfigOption(false), options: [] },
  {
    id: 'permission_mode',
    name: 'Permission Mode',
    description: 'Controls how protected tool actions are approved',
    category: '_permission',
    type: 'select',
    currentValue: 'ask',
    options: [
      {
        value: 'ask',
        name: 'Ask Every Time',
        description: 'Request approval before protected actions',
      },
      {
        value: 'always-approve',
        name: 'Always Approve',
        description: 'Approve protected actions automatically',
      },
    ],
  },
  {
    id: 'model',
    name: 'Model',
    description: 'Select the model used for this session',
    category: 'model',
    type: 'select',
    currentValue: 'grok-4.6',
    options: GROK_STATIC_MODELS.map((model) => ({
      value: model.modelId,
      name: model.name ?? model.modelId,
      description: model.description,
    })),
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning Effort',
    description: 'Controls how much reasoning the model performs',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'xhigh', name: 'X-High' },
      { value: 'high', name: 'High' },
      { value: 'medium', name: 'Medium' },
      { value: 'low', name: 'Low' },
    ],
  },
];

const DEEPSEEK_HARNESS_CONFIG_OPTIONS: AcpConfigOptionSummary[] = [
  { ...createPlanModeConfigOption(false), options: [] },
  {
    id: 'mode',
    name: 'Permission',
    description: 'Sandbox and approval policy for the session',
    category: 'mode',
    type: 'select',
    currentValue: BUILTIN_DEFAULT_MODE_IDS.deepseek,
    options: DEEPSEEK_HARNESS_PERMISSION_MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
    })),
  },
  {
    id: 'agent_preset',
    name: 'Agent preset',
    description: 'Tools, prompt, and capabilities composed for the session',
    category: 'agent_preset',
    type: 'select',
    currentValue: 'standard',
    options: DEEPSEEK_HARNESS_AGENT_PRESETS.map((preset) => ({ ...preset })),
  },
];

const STATIC_BUILTIN_ACP_CAPABILITIES: Partial<
  Record<BuiltinAgentType, StaticBuiltinAcpCapabilities>
> = {
  claude: {
    modes: CLAUDE_STATIC_MODES,
    models: CLAUDE_STATIC_MODELS,
    configOptions: CLAUDE_STATIC_CONFIG_OPTIONS,
  },
  codex: {
    modes: CODEX_STATIC_MODES,
    models: CODEX_STATIC_MODELS,
    configOptions: CODEX_STATIC_CONFIG_OPTIONS,
  },
  kimi: {
    modes: KIMI_STATIC_MODES,
    models: [],
    configOptions: KIMI_STATIC_CONFIG_OPTIONS,
  },
  grok: {
    modes: GROK_STATIC_MODES,
    models: GROK_STATIC_MODELS,
    configOptions: GROK_STATIC_CONFIG_OPTIONS,
    modelReasoningEfforts: {
      'grok-4.6': ['xhigh', 'high', 'medium', 'low'],
      'grok-4.5': ['high', 'medium', 'low'],
    },
  },
  deepseek: {
    modes: DEEPSEEK_HARNESS_PERMISSION_MODES.map((mode) => ({ ...mode })),
    models: [],
    configOptions: DEEPSEEK_HARNESS_CONFIG_OPTIONS,
  },
};

const cloneConfigOption = (option: AcpConfigOptionSummary): AcpConfigOptionSummary => ({
  ...option,
  options: option.options.map((value) => ({ ...value })),
});

const cloneStaticCapabilities = (
  capabilities: StaticBuiltinAcpCapabilities
): StaticBuiltinAcpCapabilities => ({
  modes: capabilities.modes.map((mode) => ({ ...mode })),
  models: capabilities.models.map((model) => ({ ...model })),
  configOptions: capabilities.configOptions.map(cloneConfigOption),
  ...(capabilities.modelReasoningEfforts
    ? {
        modelReasoningEfforts: Object.fromEntries(
          Object.entries(capabilities.modelReasoningEfforts).map(([modelId, efforts]) => [
            modelId,
            [...efforts],
          ])
        ),
      }
    : {}),
});

export const getStaticBuiltinAcpCapabilities = (
  agentType: BuiltinAgentType | string | null | undefined
): StaticBuiltinAcpCapabilities | undefined => {
  if (!agentType || !isBuiltinAgentType(agentType)) {
    return undefined;
  }
  const capabilities = STATIC_BUILTIN_ACP_CAPABILITIES[agentType];
  return capabilities ? cloneStaticCapabilities(capabilities) : undefined;
};
