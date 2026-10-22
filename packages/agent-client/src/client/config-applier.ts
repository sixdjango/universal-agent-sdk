import { PLAN_MODE_CONFIG_ID } from '@universal-agent/acp-extension-core';
import type {
  ACPSessionId,
  AcpConfigOptionSummary,
  AcpConfigOptionValue,
  AcpSessionNotification,
  AgentConfigCliType,
  Logger,
  SessionAcpRuntimeConfigPatch,
  SessionId,
} from '../types';
import type { AgentClient } from './agent-client';
import { filterAcpConfigOptions } from './capability-norm';

const SENSITIVE_ACP_CONFIG_ID_PATTERN =
  /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i;

export function isSensitiveAcpConfigOptionId(configId: string): boolean {
  return SENSITIVE_ACP_CONFIG_ID_PATTERN.test(configId);
}

export const ACP_FAST_MODE_CONFIG_IDS = ['fast-mode', 'fast'] as const;
export const ACP_COLLABORATION_MODE_CONFIG_ID = 'collaboration_mode';
export const ACP_REASONING_EFFORT_CONFIG_ID = 'reasoning_effort';
export const ACP_THOUGHT_LEVEL_CATEGORY = 'thought_level';
export const ACP_PLAN_PERMISSION_MODE_ID = 'plan';

export const isAcpFastModeConfigId = (configId: string): boolean =>
  (ACP_FAST_MODE_CONFIG_IDS as readonly string[]).includes(configId);

type ConfigOptionIdentity = Pick<AcpConfigOptionSummary, 'id' | 'category'>;

export const isAcpThoughtLevelConfigOption = (option: ConfigOptionIdentity): boolean =>
  option.id === ACP_REASONING_EFFORT_CONFIG_ID || option.category === ACP_THOUGHT_LEVEL_CATEGORY;

export const isAcpPlanModeConfigOption = (option: ConfigOptionIdentity): boolean =>
  option.id === PLAN_MODE_CONFIG_ID ||
  option.id === ACP_COLLABORATION_MODE_CONFIG_ID ||
  option.category === ACP_COLLABORATION_MODE_CONFIG_ID;

const readConfigOption = (
  value: unknown
): { id: string; category?: string; currentValue: AcpConfigOptionValue } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const option = value as Record<string, unknown>;
  if (typeof option.id !== 'string' || isSensitiveAcpConfigOptionId(option.id)) {
    return null;
  }
  if (
    (option.type !== 'select' || typeof option.currentValue !== 'string') &&
    (option.type !== 'boolean' || typeof option.currentValue !== 'boolean')
  ) {
    return null;
  }
  return {
    id: option.id,
    ...(typeof option.category === 'string' ? { category: option.category } : {}),
    currentValue: option.currentValue,
  };
};

export const getAcpRuntimeConfigPatchFromOptions = (
  acpSessionId: ACPSessionId,
  configOptions: readonly unknown[]
): SessionAcpRuntimeConfigPatch => {
  const options = filterAcpConfigOptions(
    configOptions.map(readConfigOption).filter((option) => option !== null)
  );
  const configOptionValues = Object.fromEntries(
    options.map((option) => [option.id, option.currentValue])
  );
  const mode = options.find((option) => option.category === 'mode');
  const model = options.find((option) => option.category === 'model');
  return {
    acpSessionId,
    configOptionValues,
    ...(typeof mode?.currentValue === 'string' ? { modeId: mode.currentValue } : {}),
    ...(typeof model?.currentValue === 'string' ? { modelId: model.currentValue } : {}),
  };
};

export const getAcpRuntimeConfigPatch = (
  notification: AcpSessionNotification
): SessionAcpRuntimeConfigPatch | null => {
  const update = notification.update;
  if (update.sessionUpdate === 'current_mode_update') {
    return {
      acpSessionId: notification.sessionId as ACPSessionId,
      modeId: update.currentModeId,
    };
  }
  if (update.sessionUpdate !== 'config_option_update') {
    return null;
  }

  return getAcpRuntimeConfigPatchFromOptions(
    notification.sessionId as ACPSessionId,
    update.configOptions
  );
};

export const mergeAcpRuntimeConfigUpdates = (
  notifications: readonly AcpSessionNotification[]
): SessionAcpRuntimeConfigPatch | null => {
  let merged: SessionAcpRuntimeConfigPatch | null = null;
  for (const notification of notifications) {
    const patch = getAcpRuntimeConfigPatch(notification);
    if (!patch) continue;
    if (merged && merged.acpSessionId === patch.acpSessionId) {
      const previous: SessionAcpRuntimeConfigPatch = merged;
      merged = { ...previous, ...patch };
    } else {
      merged = patch;
    }
  }
  return merged;
};

const MAX_ACP_CONFIG_VALUE_LOG_LENGTH = 160;

function formatAcpConfigValueForLog(configId: string, value: AcpConfigOptionValue): string {
  if (isSensitiveAcpConfigOptionId(configId)) {
    return '<redacted>';
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    const truncated =
      normalized.length > MAX_ACP_CONFIG_VALUE_LOG_LENGTH
        ? `${normalized.slice(0, MAX_ACP_CONFIG_VALUE_LOG_LENGTH)}...`
        : normalized;
    return JSON.stringify(truncated);
  }
  return String(value);
}

function shouldSkipFableFastModeDisable(args: {
  modelId: string | undefined;
  configId: string;
  value: AcpConfigOptionValue;
}): boolean {
  return (
    args.modelId?.toLowerCase().includes('fable') === true &&
    isAcpFastModeConfigId(args.configId) &&
    args.value === false
  );
}

export type AcpSessionConfigTarget = {
  sessionId: SessionId;
  acpSessionId: ACPSessionId | null;
  agentClient: Pick<
    AgentClient,
    | 'isCreated'
    | 'getConfigOptions'
    | 'setSessionMode'
    | 'unstable_setSessionModel'
    | 'setSessionConfigOption'
  > | null;
};

export type AcpSessionRunConfig = {
  cliType?: AgentConfigCliType;
  agentType?: string;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

export type AcpSessionRunConfigApplyResult = {
  rejectedSelections: string[];
  warningSelections: string[];
  runtimeConfigPatch: SessionAcpRuntimeConfigPatch | null;
};

function isCodexOrClaudeRunConfig(config: AcpSessionRunConfig): boolean {
  return config.agentType === 'codex' || config.agentType === 'claude';
}

function isKnownRunConfigOption(
  configId: string,
  agentConfigOptions: ReadonlyArray<{ id: string; category?: string | null }>
): boolean {
  if (
    configId === ACP_REASONING_EFFORT_CONFIG_ID ||
    isAcpFastModeConfigId(configId) ||
    isAcpPlanModeConfigOption({ id: configId })
  ) {
    return true;
  }
  const option = agentConfigOptions.find((candidate) => candidate.id === configId);
  return option
    ? isAcpThoughtLevelConfigOption({ id: option.id, category: option.category ?? undefined })
    : false;
}

export async function applyAcpSessionRunConfig(args: {
  session: AcpSessionConfigTarget;
  config: AcpSessionRunConfig;
  logger: Logger;
  signal?: AbortSignal;
}): Promise<AcpSessionRunConfigApplyResult> {
  const { session, config, logger, signal } = args;
  const assertNotAborted = (): void => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('ACP run configuration was aborted');
  };
  const { sessionId, acpSessionId, agentClient } = session;
  const configOptionValues = config.configOptionValues;
  const configOptionEntries = configOptionValues ? Object.entries(configOptionValues) : [];
  const configOptionSummary =
    configOptionEntries.length > 0
      ? configOptionEntries
          .map(([configId, value]) => `${configId}=${formatAcpConfigValueForLog(configId, value)}`)
          .join(',')
      : 'none';
  logger.debug(
    `[${sessionId}] applyAcpSessionRunConfig called (cliType=${config.cliType ?? 'unknown'} agentType=${
      config.agentType ?? 'unknown'
    } modeId=${config.modeId ?? 'none'} modelId=${
      config.modelId ?? 'none'
    } configOptions=${configOptionEntries.length} configOptionValues=${configOptionSummary})`
  );
  if (!agentClient?.isCreated() || !acpSessionId) {
    logger.debug(`[${sessionId}] applyAcpSessionRunConfig skipped (agentClient not ready)`);
    return { rejectedSelections: [], warningSelections: [], runtimeConfigPatch: null };
  }

  const rejectedSelections: string[] = [];
  const warningSelections: string[] = [];
  let confirmedLegacyModeId: string | undefined;
  let confirmedLegacyModelId: string | undefined;
  const agentConfigOptions = agentClient.getConfigOptions?.() ?? [];
  const suppressKnownRunConfigWarnings = isCodexOrClaudeRunConfig(config);
  const recordRejection = (selection: string, suppressWarning: boolean): void => {
    rejectedSelections.push(selection);
    if (!suppressWarning) {
      warningSelections.push(selection);
    }
  };
  const modeConfigId =
    agentConfigOptions.find((option) => option.category === 'mode')?.id ?? 'mode';
  const modelConfigId =
    agentConfigOptions.find((option) => option.category === 'model')?.id ?? 'model';
  const configOptionModeId = configOptionValues?.[modeConfigId];
  const targetModeId =
    config.modeId ?? (typeof configOptionModeId === 'string' ? configOptionModeId : undefined);
  const configOptionModelId = configOptionValues?.[modelConfigId];
  const targetModelId =
    config.modelId ?? (typeof configOptionModelId === 'string' ? configOptionModelId : undefined);

  if (targetModeId) {
    assertNotAborted();
    try {
      await agentClient.setSessionMode?.(acpSessionId, targetModeId);
      confirmedLegacyModeId = targetModeId;
    } catch (error) {
      assertNotAborted();
      recordRejection(
        `mode=${JSON.stringify(targetModeId)}`,
        suppressKnownRunConfigWarnings && targetModeId === ACP_PLAN_PERMISSION_MODE_ID
      );
      logger.debug(
        `[${sessionId}] Failed to set ACP mode ${JSON.stringify(targetModeId)}: ${String(error)}`
      );
    }
    assertNotAborted();
  }
  if (targetModelId) {
    assertNotAborted();
    try {
      await agentClient.unstable_setSessionModel?.(acpSessionId, targetModelId);
      confirmedLegacyModelId = targetModelId;
    } catch (error) {
      assertNotAborted();
      recordRejection(`model=${JSON.stringify(targetModelId)}`, false);
      logger.debug(
        `[${sessionId}] Failed to set ACP model ${JSON.stringify(targetModelId)}: ${String(error)}`
      );
    }
    assertNotAborted();
  }

  for (const [configId, value] of configOptionEntries) {
    assertNotAborted();
    if (configId === modeConfigId || configId === modelConfigId) {
      continue;
    }
    if (shouldSkipFableFastModeDisable({ modelId: targetModelId, configId, value })) {
      continue;
    }
    try {
      await agentClient.setSessionConfigOption(acpSessionId, configId, value);
    } catch (error) {
      assertNotAborted();
      recordRejection(
        `${configId}=${formatAcpConfigValueForLog(configId, value)}`,
        suppressKnownRunConfigWarnings && isKnownRunConfigOption(configId, agentConfigOptions)
      );
      logger.debug(`[${sessionId}] Failed to set ACP config option ${configId}: ${String(error)}`);
    }
    assertNotAborted();
  }

  assertNotAborted();
  logger.debug(`[${sessionId}] applyAcpSessionRunConfig completed`);
  const runtimeConfigPatch = getAcpRuntimeConfigPatchFromOptions(
    acpSessionId,
    agentClient.getConfigOptions()
  );
  if (confirmedLegacyModeId) {
    runtimeConfigPatch.modeId = confirmedLegacyModeId;
    if (
      !isSensitiveAcpConfigOptionId(modeConfigId) &&
      agentConfigOptions.some((option) => option.id === modeConfigId)
    ) {
      runtimeConfigPatch.configOptionValues = {
        ...runtimeConfigPatch.configOptionValues,
        [modeConfigId]: confirmedLegacyModeId,
      };
    }
  }
  if (confirmedLegacyModelId && !runtimeConfigPatch.modelId) {
    runtimeConfigPatch.modelId = confirmedLegacyModelId;
  }
  return {
    rejectedSelections,
    warningSelections,
    runtimeConfigPatch,
  };
}
