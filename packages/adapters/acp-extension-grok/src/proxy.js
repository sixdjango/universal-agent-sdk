import { GrokSessionForkBridge } from './session-fork.js';
import { GrokSubagentEvents } from './subagent-events.js';
import { GrokPlanReviewBridge } from './plan-review.js';
import runtimeManifest from '../runtime-manifest.json' with { type: 'json' };
import {
  LODY_EXTENSION_METHODS,
  LODY_TOOL_NAMES,
  LODY_PLAN_MODE_CONFIG_ID,
  createPlanModeConfigOption,
  SessionUsageAccumulator,
  supportsLodySubagentEvents,
} from 'acp-extension-core';

const contract = runtimeManifest.privateWireContract;

const PERMISSION_MODES = {
  ask: { permission_mode: 'ask', yolo_mode: false, auto_mode: false },
  auto: { permission_mode: 'auto', yolo_mode: false, auto_mode: true },
  'always-approve': {
    permission_mode: 'always-approve',
    yolo_mode: true,
    auto_mode: false,
  },
};

const INTERACTION_TO_RUNTIME = { agent: 'default', plan: 'plan' };
const INTERACTION_FROM_RUNTIME = { default: 'agent', plan: 'plan', ask: 'plan' };
// Grok 1.0.34 silently accepts `ask` without changing its runtime mode. Keep
// legacy persisted Ask selections safe by degrading them to Plan, but do not
// advertise Ask until the runtime reports and applies it.
const LEGACY_INTERACTION_ALIASES = { ask: 'plan' };

const INTERNAL_REQUESTS = {
  context: { contractKey: 'sessionInfoRequest', params: (sessionId) => ({ sessionId }) },
  billing: { contractKey: 'billingRequest', params: () => ({}) },
  rateLimits: { contractKey: 'billingRequest', params: () => ({}) },
};

const USD_TICKS_PER_USD = 10_000_000_000;
const MAX_TRACKED_PROMPTS = 256;
const GROK_LODY_CAPABILITIES = {
  tasks: { version: 1, scheduled: true },
  subagentEvents: { version: 1 },
  sessionTitle: { version: 1 },
  forkAtTurn: { version: 1 },
  usage: { version: 1 },
  rateLimits: { version: 1, query: true },
};
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const GROK_MODEL_SNAPSHOT_SETTLE_TIMEOUT_MS = 2_000;

function logicalExtensionMethod(method) {
  return typeof method === 'string' && method.startsWith('_') ? method.slice(1) : method;
}

const SCHEDULING_TOOLS = new Map([
  ['scheduler_create', LODY_TOOL_NAMES.cronCreate],
  ['scheduler_delete', LODY_TOOL_NAMES.cronDelete],
  ['scheduler_list', LODY_TOOL_NAMES.cronList],
]);

/** Translate schedule ownership, not the execution/result of each fired subagent. */
function scheduledTaskUpdate(message) {
  const { update } = message.params;
  const method = logicalExtensionMethod(message.method);
  if (
    message.method === 'session/update' &&
    ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)
  ) {
    const native = update._meta?.['x.ai/tool'];
    const toolName =
      native?.version === 1 && native.namespace === 'grok_build'
        ? SCHEDULING_TOOLS.get(native.name)
        : undefined;
    if (!toolName) return message;
    return {
      ...message,
      params: {
        ...message.params,
        update: {
          ...update,
          _meta: { ...update._meta, lody: { ...update._meta?.lody, toolName } },
        },
      },
    };
  }
  const event = update?.sessionUpdate;
  if (
    !['scheduled_task_created', 'scheduled_task_fired', 'scheduled_task_deleted'].includes(event) ||
    ![`x.ai/${event}`, contract.sessionNotification].includes(method) ||
    typeof update.task_id !== 'string' ||
    !update.task_id.trim()
  ) return message;
  const deleted = event === 'scheduled_task_deleted';
  if (!deleted && (typeof update.prompt !== 'string' || typeof update.human_schedule !== 'string'))
    return message;
  // Shutdown removes a UI chip, not the persisted schedule. Core has no suspended status.
  if (deleted && update.reason === 'shutdown') return null;
  const taskId = `grok-scheduled:${update.task_id}`;
  const status = deleted
    ? 'completed'
    : event === 'scheduled_task_created' ? 'pending' : 'in_progress';
  const task = {
    version: 1,
    taskId,
    kind: 'scheduled',
    status,
    ...(!deleted ? { description: `${update.prompt} (${update.human_schedule})` } : {}),
    ...(deleted
      ? { summary: `Schedule removed (${typeof update.reason === 'string' ? update.reason : 'unknown'})` }
      : {}),
  };
  return {
    ...message,
    method: 'session/update',
    params: {
      ...message.params,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: taskId,
        title: task.description ?? 'Scheduled task removed',
        kind: 'other',
        status,
        _meta: { ...update._meta, lody: { ...update._meta?.lody, task } },
      },
    },
  };
}

function wireExtensionMethod(method) {
  return `_${method}`;
}

function extensionNotification(contractKey, params) {
  return { jsonrpc: '2.0', method: wireExtensionMethod(contract[contractKey]), params };
}

function lodyNotification(method, params) {
  return { jsonrpc: '2.0', method, params };
}

function optionalNonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeNumber(value) {
  return optionalNonnegativeNumber(value) ?? 0;
}

function optionalAmount(value) {
  return optionalNonnegativeNumber(value?.val ?? value);
}

function billingUsagePercent(config, period) {
  // Only the current period may borrow the top-level balance fields; a
  // historical period must never be paired with today's totals.
  const fallback = period === config.currentPeriod ? config : {};
  const explicit =
    optionalNonnegativeNumber(period.creditUsagePercent) ??
    optionalNonnegativeNumber(fallback.creditUsagePercent);
  if (explicit !== undefined) return explicit;

  const limit = optionalAmount(period.monthlyLimit ?? fallback.monthlyLimit);
  const used = optionalAmount(
    period.totalUsed ?? period.includedUsed ?? period.used ?? fallback.totalUsed ?? fallback.used
  );
  if (limit && used !== undefined) return (used / limit) * 100;

  // Grok Build 1.0.34 omits creditUsagePercent for a fresh unified-billing
  // weekly period and reports each balance field as an explicit zero. Its own
  // `/usage` UI renders that exact response as "Weekly limit: 0%", so mirror
  // the official client only for this fully-zero, provider-authored shape.
  const hasOfficialZeroUsage =
    config.isUnifiedBillingUser === true &&
    config.currentPeriod?.type === contract.weeklyUsagePeriodType &&
    optionalAmount(config.onDemandCap) === 0 &&
    optionalAmount(config.onDemandUsed) === 0 &&
    optionalAmount(config.prepaidBalance) === 0;
  if (hasOfficialZeroUsage) return 0;

  return undefined;
}

// A `window` of null means Grok could not tell us anything usable; Lody renders
// that as unavailable rather than as zero utilization.
function rateLimitsPayload(planName, window, now = Date.now()) {
  return {
    rateLimits: window
      ? [
          {
            limitId: 'grok',
            scope: { providerId: 'grok' },
            planName,
            limitName: 'Grok Build',
            windows: [window],
          },
        ]
      : [],
    fetchedAtEpochSeconds: Math.floor(now / 1_000),
  };
}

function normalizeUsageModel(usage, usageIsIncomplete) {
  const inputTokens = nonnegativeNumber(usage?.inputTokens);
  const outputTokens = nonnegativeNumber(usage?.outputTokens);
  const cacheReadInputTokens = nonnegativeNumber(usage?.cachedReadTokens);
  const cacheCreationInputTokens = nonnegativeNumber(usage?.cacheCreationTokens);
  const reasoningOutputTokens = nonnegativeNumber(usage?.reasoningTokens);
  const costUsdTicks = optionalNonnegativeNumber(usage?.costUsdTicks);
  const hasTrustworthyCost =
    !usageIsIncomplete && usage?.costIsPartial !== true && costUsdTicks !== undefined;

  return {
    // Grok's ACP totals include cache buckets in inputTokens and reasoning in
    // outputTokens. Lody stores disjoint buckets and adds them for reporting.
    inputTokens: Math.max(0, inputTokens - cacheReadInputTokens - cacheCreationInputTokens),
    outputTokens: Math.max(0, outputTokens - reasoningOutputTokens),
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    ...(hasTrustworthyCost ? { costUSD: costUsdTicks / USD_TICKS_PER_USD } : {}),
  };
}

export function normalizePromptUsage(promptUsage) {
  if (!promptUsage || typeof promptUsage !== 'object') return undefined;
  const usageIsIncomplete = promptUsage.usageIsIncomplete === true;
  const usage = normalizeUsageModel(promptUsage, usageIsIncomplete);
  const modelUsage = {};
  if (promptUsage.modelUsage && typeof promptUsage.modelUsage === 'object') {
    for (const [modelId, model] of Object.entries(promptUsage.modelUsage)) {
      if (model && typeof model === 'object') {
        modelUsage[modelId] = normalizeUsageModel(model, usageIsIncomplete);
      }
    }
  }
  return {
    usage,
    ...(Object.keys(modelUsage).length ? { modelUsage } : {}),
  };
}

export function normalizeBillingRateLimits(billing) {
  if (!billing || typeof billing !== 'object') return undefined;
  const config = billing.config;
  if (!config || typeof config !== 'object') return undefined;

  const latestHistory = Array.isArray(config.history) ? config.history.at(-1) : undefined;
  const period = config.currentPeriod ?? latestHistory ?? config;
  let usedPercent = billingUsagePercent(config, period);
  if (usedPercent !== undefined) usedPercent = Math.min(100, usedPercent);

  const start = period?.start ?? period?.billingPeriodStart ?? config.billingPeriodStart;
  const end = period?.end ?? period?.billingPeriodEnd ?? config.billingPeriodEnd;
  const startMs = typeof start === 'string' ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === 'string' ? Date.parse(end) : Number.NaN;
  const measuredWindowDurationSeconds =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 1_000)
      : null;
  const windowDurationSeconds =
    period?.type === contract.weeklyUsagePeriodType
      ? SEVEN_DAY_WINDOW_SECONDS
      : measuredWindowDurationSeconds;
  const resetsAtEpochSeconds = Number.isFinite(endMs) ? Math.floor(endMs / 1_000) : null;
  const tier = billing.subscriptionTier ?? billing.subscription_tier;
  const planName = typeof tier === 'string' && tier.trim() ? tier : null;

  if (usedPercent === undefined) {
    if (!planName && windowDurationSeconds === null && resetsAtEpochSeconds === null)
      return undefined;
    return rateLimitsPayload(planName, null);
  }
  return rateLimitsPayload(planName, {
    usedPercent,
    windowDurationSeconds,
    resetsAtEpochSeconds,
  });
}

function rateLimitsNotification(billing) {
  const params = normalizeBillingRateLimits(billing);
  return params && lodyNotification(LODY_EXTENSION_METHODS.rateLimitsUpdate, params);
}

function contextUsageNotification(sessionId, context) {
  const size = nonnegativeNumber(context?.total);
  const used = nonnegativeNumber(context?.used);
  if (size <= 0) return undefined;
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'usage_update', size, used },
    },
  };
}

function unwrapExtensionResult(result) {
  if (!result || typeof result !== 'object') return result;
  return Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
}

// Returns true when the prompt is new to `set` — including when Grok gave us no
// id to deduplicate on, in which case there is nothing to suppress.
function rememberPrompt(set, promptId) {
  if (!promptId) return true;
  if (set.has(promptId)) return false;
  set.add(promptId);
  if (set.size > MAX_TRACKED_PROMPTS) {
    set.delete(set.values().next().value);
  }
  return true;
}

function errorResponse(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32602, message } };
}

function unsupportedConfigOption(id, configId) {
  return {
    toRuntime: [],
    toClient: [errorResponse(id, `Unsupported Grok config option: ${configId}`)],
  };
}

function optionName(value) {
  if (value === 'xhigh') return 'X-High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function legacyOptions(result) {
  const options = result?._meta?.[contract.sessionConfigMeta]?.options;
  return Array.isArray(options) ? options : [];
}

function readReasoningOptions(model) {
  const raw = model?._meta?.reasoningEfforts ?? model?._meta?.reasoning_efforts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') {
        return {
          id: item,
          value: item,
          name: optionName(item),
          description: null,
          default: false,
        };
      }
      const id = item?.id ?? item?.reasoningEffort ?? item?.value;
      const value = item?.value ?? item?.reasoningEffort ?? item?.id;
      if (typeof id !== 'string' || typeof value !== 'string') return undefined;
      return {
        id,
        value,
        name: typeof item.label === 'string' ? item.label : optionName(id),
        description: typeof item.description === 'string' ? item.description : null,
        default: item.default === true,
      };
    })
    .filter(Boolean);
}

function readReasoningEfforts(model) {
  return readReasoningOptions(model).map((option) => option.id);
}

function reasoningOptionsFromConfig(option) {
  if (!Array.isArray(option?.options)) return [];
  return option.options
    .map((item) => {
      if (!item || typeof item.value !== 'string') return undefined;
      return {
        id: item.value,
        value: item.value,
        name: typeof item.name === 'string' ? item.name : optionName(item.value),
        description: typeof item.description === 'string' ? item.description : null,
        default: false,
      };
    })
    .filter(Boolean);
}

function reasoningSelector(options, reportedValue) {
  if (typeof reportedValue !== 'string') return undefined;
  return (
    options.find((option) => option.id === reportedValue)?.id ??
    options.find((option) => option.value === reportedValue)?.id
  );
}

function standardConfigOptions(result) {
  return Array.isArray(result?.configOptions)
    ? result.configOptions.filter(
        (option) => option && typeof option === 'object' && typeof option.id === 'string'
      )
    : [];
}

function configOption(options, id) {
  return options.find((option) => option.id === id);
}

function readModelSnapshot(params) {
  if (!params || typeof params !== 'object' || !Array.isArray(params.availableModels)) {
    return undefined;
  }
  if (
    params.availableModels.length === 0 ||
    params.availableModels.some(
      (model) => !model || typeof model !== 'object' || typeof model.modelId !== 'string'
    )
  ) {
    return undefined;
  }
  const currentModelId = params.currentModelId;
  if (
    typeof currentModelId !== 'string' ||
    !params.availableModels.some((model) => model.modelId === currentModelId)
  ) {
    return undefined;
  }
  return {
    currentModelId,
    availableModels: params.availableModels,
  };
}

function selectOption(id, name, description, currentValue, options, category) {
  return {
    id,
    name,
    description,
    category,
    type: 'select',
    currentValue,
    options,
  };
}

export function permissionNotification(clientIdentifier, mode) {
  const mapped = PERMISSION_MODES[mode];
  if (!mapped) return undefined;
  return extensionNotification('permissionNotification', { clientIdentifier, ...mapped });
}

function stripLodySessionConfig(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const lody = meta.lody;
  if (!lody || typeof lody !== 'object' || !Object.hasOwn(lody, 'sessionConfig')) return meta;
  const { sessionConfig: _sessionConfig, ...remainingLody } = lody;
  const { lody: _lody, ...remainingMeta } = meta;
  return Object.keys(remainingLody).length > 0
    ? { ...remainingMeta, lody: remainingLody }
    : remainingMeta;
}

function readLodySessionConfigOption(meta, configId) {
  if (!meta || typeof meta !== 'object') return undefined;
  const sessionConfig = meta.lody?.sessionConfig;
  if (
    !sessionConfig ||
    typeof sessionConfig !== 'object' ||
    sessionConfig.version !== 1 ||
    !sessionConfig.configOptionValues ||
    typeof sessionConfig.configOptionValues !== 'object'
  ) {
    return undefined;
  }
  const value = sessionConfig.configOptionValues[configId];
  return typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
}

function translateSessionStart(message, previousMode) {
  const params = message.params ?? {};
  const requestedMode = readLodySessionConfigOption(params._meta, 'permission_mode');
  // Seed every attach, including explicit false. A client notification cannot
  // initialize a future session, and omitting the seeds inherits native defaults.
  const permissionMode = requestedMode ?? previousMode ?? 'ask';
  const mapped = typeof permissionMode === 'string' ? PERMISSION_MODES[permissionMode] : undefined;
  if (!mapped) return { message, permissionMode: undefined };

  const translated = {
    ...message,
    params: {
      ...params,
      _meta: {
        ...stripLodySessionConfig(params._meta),
        yoloMode: mapped.yolo_mode,
        autoMode: mapped.auto_mode,
      },
    },
  };
  return {
    message: translated,
    permissionMode,
  };
}

function translateInitialize(message) {
  const params = message.params ?? {};
  const clientCapabilities = params.clientCapabilities ?? {};
  return {
    ...message,
    params: {
      ...params,
      clientCapabilities: {
        ...clientCapabilities,
        _meta: {
          ...(clientCapabilities._meta ?? {}),
          [contract.userMessageEchoCapability]: true,
        },
      },
    },
  };
}

export class GrokAcpCompatibilityProxy {
  constructor({ deferSessionResponseUntilModelSnapshot = false } = {}) {
    this.subagents = new GrokSubagentEvents();
    this.sessions = new Map();
    this.planReviews = new GrokPlanReviewBridge();
    this.clientCapabilities = {};
    this.pending = new Map();
    this.pendingSessionResponses = new Map();
    this.clientVisibleSessions = new Set();
    this.latestModelSnapshot = undefined;
    this.latestModelSnapshotFingerprint = undefined;
    this.deferSessionResponseUntilModelSnapshot = deferSessionResponseUntilModelSnapshot;
    // Grok scopes permission mode to the Lody clientIdentifier, not to a session,
    // so the selection outlives any single session and is stored by client.
    this.permissionModes = new Map();
    this.runtimeVersion = undefined;
    this.nextInternalRequestId = Number.MAX_SAFE_INTEGER;
    this.forks = new GrokSessionForkBridge((kind, operation, method, params) =>
      this.runtimeRequest({ kind, operation }, method, params)
    );
  }

  supportsAutoPermission() {
    if (!contract.autoPermissionMode) return false;
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(this.runtimeVersion ?? '');
    if (!version) return false;
    const minimum = contract.autoPermissionMinimumVersion.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      const difference = Number(version[i + 1]) - minimum[i];
      if (difference !== 0) return difference > 0;
    }
    return true;
  }

  applyCurrentModel(state, currentModelId, reportedReasoningEffort) {
    const previousModelId = state.currentModelId;
    const currentModel = state.models.find((model) => model.modelId === currentModelId);
    const reasoningOptions = readReasoningOptions(currentModel);
    const reasoningEfforts = reasoningOptions.map((option) => option.id);
    const metadataReasoningEffort =
      currentModel?._meta?.reasoningEffort ?? currentModel?._meta?.reasoning_effort;
    state.currentModelId = currentModelId;
    if (reasoningEfforts.length === 0) {
      // A model switch to a model that publishes no ladders withdraws the
      // control: the previous model's list must not masquerade as validated
      // values for the new one. A repeat for the same model keeps whatever
      // the session already reported.
      if (previousModelId !== currentModelId) {
        state.reasoningOptions = [];
        state.reasoningEfforts = [];
      }
      if (typeof reportedReasoningEffort === 'string') {
        state.reasoningEffort = reportedReasoningEffort;
      }
      return;
    }
    state.reasoningOptions = reasoningOptions;
    state.reasoningEfforts = reasoningEfforts;
    const reportedValue =
      reasoningSelector(reasoningOptions, reportedReasoningEffort) ??
      (typeof reportedReasoningEffort === 'string' ? reportedReasoningEffort : undefined);
    const metadataValue =
      reasoningSelector(reasoningOptions, metadataReasoningEffort) ??
      (typeof metadataReasoningEffort === 'string' ? metadataReasoningEffort : undefined);
    state.reasoningEffort =
      reportedValue !== undefined
        ? reportedValue
        : previousModelId === currentModelId && typeof state.reasoningEffort === 'string'
          ? state.reasoningEffort
          : (metadataValue ??
            reasoningOptions.find((option) => option.default)?.id ??
            reasoningEfforts[0]);
  }

  applyRuntimeConfigOptions(state, options) {
    if (!Array.isArray(options)) return;
    state.runtimeConfigOptions = options.filter(
      (option) =>
        option &&
        typeof option === 'object' &&
        typeof option.id === 'string' &&
        option.id !== LODY_PLAN_MODE_CONFIG_ID &&
        option.id !== 'permission_mode' &&
        option.id !== 'interaction_mode'
    );

    const modelOption = configOption(state.runtimeConfigOptions, 'model');
    if (Array.isArray(modelOption?.options)) {
      state.models = modelOption.options
        .filter((option) => option && typeof option.value === 'string')
        .map((option) => {
          const existing = state.models.find((model) => model.modelId === option.value);
          return {
            ...(existing ?? {}),
            modelId: option.value,
            name: typeof option.name === 'string' ? option.name : (existing?.name ?? option.value),
            description: option.description ?? existing?.description,
          };
        });
    }
    if (typeof modelOption?.currentValue === 'string') {
      this.applyCurrentModel(state, modelOption.currentValue);
    }

    const reasoningOption = configOption(state.runtimeConfigOptions, 'reasoning_effort');
    if (!reasoningOption) return;
    const currentModel = state.models.find((model) => model.modelId === state.currentModelId);
    const metadataReasoningOptions = readReasoningOptions(currentModel);
    if (metadataReasoningOptions.length) {
      state.reasoningOptions = metadataReasoningOptions;
      state.reasoningEfforts = metadataReasoningOptions.map((option) => option.id);
    } else {
      state.reasoningOptions = reasoningOptionsFromConfig(reasoningOption);
      state.reasoningEfforts = state.reasoningOptions.map((option) => option.id);
    }
    const selected = reasoningSelector(state.reasoningOptions, reasoningOption.currentValue);
    if (selected !== undefined) {
      state.reasoningEffort = selected;
    } else if (typeof reasoningOption.currentValue === 'string') {
      // Grok deliberately reports real values such as `none` or `max` even
      // when they are not selectable. Preserve that authoritative state while
      // continuing to validate client selections against the published menu.
      state.reasoningEffort = reasoningOption.currentValue;
    }
  }

  applyModelSnapshot(state, snapshot) {
    state.models = snapshot.availableModels;
    this.applyCurrentModel(state, snapshot.currentModelId);
  }

  sessionResponseWithState(message, state) {
    const models =
      typeof state.currentModelId === 'string' && state.models.length > 0
        ? {
            currentModelId: state.currentModelId,
            availableModels: state.models,
          }
        : message.result?.models;
    const modelReasoningEfforts = {};
    for (const model of state.models) {
      const efforts = readReasoningEfforts(model);
      if (efforts.length) modelReasoningEfforts[model.modelId] = efforts;
    }
    return {
      ...message,
      result: {
        ...message.result,
        ...(models ? { models } : {}),
        ...(Object.keys(modelReasoningEfforts).length > 0
          ? {
              _meta: {
                ...(message.result?._meta ?? {}),
                lody: {
                  modelReasoningEfforts,
                },
              },
            }
          : {}),
        configOptions: this.configOptions(state),
      },
    };
  }

  exposePendingSessionResponse(id) {
    const pending = this.pendingSessionResponses.get(id);
    if (!pending) return { toRuntime: [], toClient: [] };
    this.pendingSessionResponses.delete(id);
    const state = this.sessions.get(pending.sessionId);
    if (!state) return { toRuntime: [], toClient: [pending.message] };
    this.clientVisibleSessions.add(pending.sessionId);
    return {
      toRuntime: [],
      toClient: [this.sessionResponseWithState(pending.message, state)],
    };
  }

  flushPendingSessionResponse(id) {
    return this.exposePendingSessionResponse(id);
  }

  handleModelSnapshot(message) {
    const snapshot = readModelSnapshot(message.params);
    if (!snapshot) return { toRuntime: [], toClient: [message] };
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === this.latestModelSnapshotFingerprint) {
      return { toRuntime: [], toClient: [] };
    }
    this.latestModelSnapshot = snapshot;
    this.latestModelSnapshotFingerprint = fingerprint;

    for (const state of this.sessions.values()) {
      this.applyModelSnapshot(state, snapshot);
    }

    const toClient = [];
    const pendingSessionIds = new Set();
    const settledSessionResponseIds = [];
    for (const id of [...this.pendingSessionResponses.keys()]) {
      const pending = this.pendingSessionResponses.get(id);
      if (pending) pendingSessionIds.add(pending.sessionId);
      toClient.push(...this.exposePendingSessionResponse(id).toClient);
      settledSessionResponseIds.push(id);
    }
    for (const sessionId of this.clientVisibleSessions) {
      if (pendingSessionIds.has(sessionId)) continue;
      const state = this.sessions.get(sessionId);
      if (!state) continue;
      toClient.push({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: this.configOptions(state),
          },
        },
      });
    }
    return {
      toRuntime: [],
      toClient,
      ...(settledSessionResponseIds.length > 0 ? { settledSessionResponseIds } : {}),
    };
  }

  runtimeRequest(pending, method, params) {
    while (this.pending.has(this.nextInternalRequestId)) this.nextInternalRequestId -= 1;
    const id = this.nextInternalRequestId--;
    this.pending.set(id, pending);
    return { jsonrpc: '2.0', id, method, params };
  }

  internalRequest(kind, sessionId, responseId) {
    const { contractKey, params } = INTERNAL_REQUESTS[kind];
    return this.runtimeRequest(
      { kind, sessionId, responseId },
      wireExtensionMethod(contract[contractKey]),
      params(sessionId)
    );
  }

  usageRefreshRequests(sessionId) {
    return [this.internalRequest('context', sessionId), this.internalRequest('billing', sessionId)];
  }

  usageRefreshRequestsForPrompt(state, promptId) {
    if (!rememberPrompt(state.usageRefreshPromptIds, promptId)) return [];
    return this.usageRefreshRequests(state.sessionId);
  }

  usageForPrompt(state, promptId, promptUsage) {
    const normalized = normalizePromptUsage(promptUsage);
    // Both native completion channels must identify the same prompt. Without
    // an ID we cannot safely distinguish another request from a replay.
    if (!normalized || promptId == null) return undefined;
    const modelUsage = normalized.modelUsage;
    // Do not invent model attribution for multi-model prompts. A later complete
    // snapshot can fill in missing rows without first-result-wins deduplication.
    if (!modelUsage) return undefined;
    const update = state.usageAccumulator.update(state.sessionId, String(promptId), modelUsage);
    if (!update) return undefined;
    update.usage = normalized.usage;
    return lodyNotification(LODY_EXTENSION_METHODS.sessionUsageUpdate, update);
  }

  handleClient(message) {
    if (!message || typeof message !== 'object') return { toRuntime: [message], toClient: [] };
    const planResponse = this.planReviews.response(message);
    if (planResponse) return planResponse;
    const params = message.params ?? {};
    if (message.method === 'session/cancel') {
      const cancelled = this.planReviews.cancel(params.sessionId);
      return { toRuntime: [...cancelled.toRuntime, message], toClient: cancelled.toClient };
    }
    if (message.method === 'initialize' && message.id !== undefined) {
      const translated = translateInitialize(message);
      this.clientCapabilities = translated.params.clientCapabilities;
      this.pending.set(message.id, { kind: 'initialize' });
      return { toRuntime: [translated], toClient: [] };
    }
    if (message.method === LODY_EXTENSION_METHODS.rateLimitsGet) {
      return {
        toRuntime: [this.internalRequest('rateLimits', undefined, message.id)],
        toClient: [],
      };
    }
    if (
      ['session/new', 'session/load', 'session/resume', 'session/fork'].includes(message.method)
    ) {
      const mode = readLodySessionConfigOption(params._meta, 'permission_mode');
      if (mode !== undefined && !Object.hasOwn(PERMISSION_MODES, mode)) {
        return {
          toRuntime: [],
          toClient: [errorResponse(message.id, 'Unsupported Grok permission mode')],
        };
      }
      if (mode === 'auto' && !this.supportsAutoPermission()) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              `Auto requires a Grok runtime reporting version ${contract.autoPermissionMinimumVersion} or newer`
            ),
          ],
        };
      }
      if (
        mode === 'auto' &&
        (typeof params._meta?.clientIdentifier !== 'string' || !params._meta.clientIdentifier)
      ) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              'Grok Auto permission mode requires the current Lody clientIdentifier'
            ),
          ],
        };
      }
    }
    if (message.method === 'session/fork') return this.forks.start(message);
    if (
      message.method === 'session/new' ||
      message.method === 'session/load' ||
      message.method === 'session/resume'
    ) {
      this.forks.turnBySession.delete(params.sessionId);
      const clientIdentifier = params._meta?.clientIdentifier;
      const translated = translateSessionStart(message, this.permissionModes.get(clientIdentifier));
      if (translated.permissionMode && typeof clientIdentifier === 'string') {
        this.permissionModes.set(clientIdentifier, translated.permissionMode);
      }
      if (message.id !== undefined) {
        this.pending.set(message.id, {
          kind: 'session',
          method: message.method,
          sessionId: params.sessionId,
          clientIdentifier,
        });
      }
      return {
        toRuntime: [translated.message],
        toClient: [],
      };
    }
    if (message.method === 'session/prompt') {
      this.forks.turnBySession.delete(params.sessionId);
      if (message.id !== undefined) {
        this.pending.set(message.id, {
          kind: 'prompt',
          sessionId: params.sessionId,
        });
      }
      return { toRuntime: [message], toClient: [] };
    }
    if (message.method !== 'session/set_config_option') {
      return { toRuntime: [message], toClient: [] };
    }

    const { sessionId, configId, value } = params;
    const state = this.sessions.get(sessionId);
    const runtimeOption = configOption(state?.runtimeConfigOptions ?? [], configId);
    const expectsBoolean =
      configId === LODY_PLAN_MODE_CONFIG_ID || runtimeOption?.type === 'boolean';
    if (!state || (expectsBoolean ? typeof value !== 'boolean' : typeof value !== 'string')) {
      return {
        toRuntime: [],
        toClient: [errorResponse(message.id, 'Unknown Grok session or invalid config value')],
      };
    }

    if (configId === 'permission_mode') {
      if (!Object.hasOwn(PERMISSION_MODES, value)) {
        return unsupportedConfigOption(message.id, configId);
      }
      if (value === 'auto' && !this.supportsAutoPermission()) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              `Auto requires a Grok runtime reporting version ${contract.autoPermissionMinimumVersion} or newer`
            ),
          ],
        };
      }
      const notification = permissionNotification(state.clientIdentifier, value);
      if (!notification || !state.clientIdentifier) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              'Grok permission mode requires the current Lody clientIdentifier'
            ),
          ],
        };
      }
      this.permissionModes.set(state.clientIdentifier, value);
      return {
        toRuntime: [notification],
        toClient: [
          {
            jsonrpc: '2.0',
            id: message.id,
            result: { configOptions: this.configOptions(state) },
          },
        ],
      };
    }

    let translated;
    let effectiveValue = value;
    if (configId === 'reasoning_effort') {
      if (!state.currentModelId || !state.reasoningEfforts.includes(value)) {
        return {
          toRuntime: [],
          toClient: [errorResponse(message.id, 'Unsupported Grok reasoning effort')],
        };
      }
      translated = configOption(state.runtimeConfigOptions, configId)
        ? message
        : {
            jsonrpc: '2.0',
            id: message.id,
            method: 'session/set_model',
            params: {
              sessionId,
              modelId: state.currentModelId,
              _meta: {
                [contract.reasoningEffortMeta]:
                  state.reasoningOptions.find((option) => option.id === value)?.value ?? value,
              },
            },
          };
    } else if (configId === 'model') {
      translated = configOption(state.runtimeConfigOptions, configId)
        ? message
        : {
            jsonrpc: '2.0',
            id: message.id,
            method: 'session/set_model',
            params: { sessionId, modelId: value },
          };
    } else if (configId === LODY_PLAN_MODE_CONFIG_ID || configId === 'interaction_mode') {
      effectiveValue =
        configId === LODY_PLAN_MODE_CONFIG_ID
          ? value
            ? 'plan'
            : 'agent'
          : (LEGACY_INTERACTION_ALIASES[value] ?? value);
      const modeId = INTERACTION_TO_RUNTIME[effectiveValue];
      if (!modeId) return unsupportedConfigOption(message.id, configId);
      translated = {
        jsonrpc: '2.0',
        id: message.id,
        method: 'session/set_mode',
        params: { sessionId, modeId },
      };
    } else if (configOption(state.runtimeConfigOptions, configId)) {
      translated = message;
    } else {
      return unsupportedConfigOption(message.id, configId);
    }
    this.pending.set(message.id, {
      kind: 'config',
      sessionId,
      configId,
      value: effectiveValue,
    });
    return { toRuntime: [translated], toClient: [] };
  }

  handleRuntime(message) {
    if (!message || typeof message !== 'object') return { toRuntime: [], toClient: [message] };

    // JSON-RPC request IDs are scoped independently in each direction. Never
    // mistake a reverse request from Grok for a response to a Lody request that
    // happens to use the same numeric ID.
    if (typeof message.method === 'string') return this.handleRuntimeMethod(message);

    const pending = this.pending.get(message.id);
    if (!pending) return { toRuntime: [], toClient: [message] };
    this.pending.delete(message.id);

    if (pending.kind === 'fork-list' || pending.kind === 'fork-copy') {
      return this.forks.response(message, pending, (request) => {
        const output = this.handleClient(request);
        this.pending.get(request.id).forkSessionId = request.params.sessionId;
        return output;
      });
    }

    if (pending.kind === 'context') {
      if (message.error) return { toRuntime: [], toClient: [] };
      const sessionInfo = unwrapExtensionResult(message.result);
      const contextNotification = contextUsageNotification(pending.sessionId, sessionInfo?.context);
      return {
        toRuntime: [],
        toClient: contextNotification ? [contextNotification] : [],
      };
    }

    if (pending.kind === 'billing') {
      const notification = message.error
        ? lodyNotification(LODY_EXTENSION_METHODS.rateLimitsUpdate, rateLimitsPayload(null, null))
        : rateLimitsNotification(unwrapExtensionResult(message.result));
      return {
        toRuntime: [],
        toClient: notification ? [notification] : [],
      };
    }

    if (pending.kind === 'rateLimits') {
      const result = message.error
        ? rateLimitsPayload(null, null)
        : (normalizeBillingRateLimits(unwrapExtensionResult(message.result)) ??
          rateLimitsPayload(null, null));
      return {
        toRuntime: [],
        toClient: [{ jsonrpc: '2.0', id: pending.responseId, result }],
      };
    }

    if (pending.kind === 'initialize') {
      if (message.error) return { toRuntime: [], toClient: [message] };
      const result = message.result ?? {};
      this.runtimeVersion = result._meta?.agentVersion ?? result.agentInfo?.version;
      const agentCapabilities = result.agentCapabilities ?? {};
      return {
        toRuntime: [],
        toClient: [
          {
            ...message,
            result: {
              ...result,
              agentCapabilities: {
                ...agentCapabilities,
                sessionCapabilities: { ...agentCapabilities.sessionCapabilities, fork: {} },
                _meta: {
                  ...(agentCapabilities._meta ?? {}),
                  lody: GROK_LODY_CAPABILITIES,
                },
              },
            },
          },
        ],
      };
    }

    if (message.error) {
      if (pending.forkSessionId) {
        message = {
          ...message,
          error: {
            ...message.error,
            data: {
              forkedSessionId: pending.forkSessionId,
              ...(message.error.data === undefined ? {} : { runtimeErrorData: message.error.data }),
            },
          },
        };
      }
      return { toRuntime: [], toClient: [message] };
    }

    if (pending.kind === 'session') {
      if (pending.forkSessionId) {
        message = { ...message, result: { ...message.result, sessionId: pending.forkSessionId } };
      }
      const result = message.result ?? {};
      const sessionId = result.sessionId ?? pending.sessionId;
      if (!sessionId) return { toRuntime: [], toClient: [message] };
      const state = this.stateFromSessionResponse(sessionId, pending.clientIdentifier, result);
      if (this.latestModelSnapshot) {
        this.applyModelSnapshot(state, this.latestModelSnapshot);
      }
      this.sessions.set(sessionId, state);
      const sessionResponse = this.sessionResponseWithState(message, state);
      if (
        this.deferSessionResponseUntilModelSnapshot &&
        !this.latestModelSnapshot &&
        message.id !== undefined
      ) {
        this.pendingSessionResponses.set(message.id, {
          message: sessionResponse,
          sessionId,
        });
        return {
          toRuntime: this.usageRefreshRequests(sessionId),
          toClient: [],
          deferredSessionResponseIds: [message.id],
        };
      }
      this.clientVisibleSessions.add(sessionId);
      return {
        toRuntime: this.usageRefreshRequests(sessionId),
        toClient: [sessionResponse],
      };
    }

    if (pending.kind === 'prompt') {
      const state = this.sessions.get(pending.sessionId);
      if (!state) return { toRuntime: [], toClient: [message] };
      const meta = message.result?._meta;
      const promptId = meta?.promptId ?? meta?.requestId;
      const usage = this.usageForPrompt(state, promptId, meta?.usage);
      return {
        toRuntime: this.usageRefreshRequestsForPrompt(state, promptId),
        toClient: usage ? [message, usage] : [message],
      };
    }

    const state = this.sessions.get(pending.sessionId);
    if (!state) return { toRuntime: [], toClient: [message] };
    if (message.error) return { toRuntime: [], toClient: [message] };
    if (Array.isArray(message.result?.configOptions)) {
      this.applyRuntimeConfigOptions(state, message.result.configOptions);
    } else {
      if (pending.configId === 'model') this.applyCurrentModel(state, pending.value);
      if (pending.configId === 'reasoning_effort') state.reasoningEffort = pending.value;
      if (pending.configId === LODY_PLAN_MODE_CONFIG_ID || pending.configId === 'interaction_mode')
        state.interactionMode = pending.value;
    }
    return {
      toRuntime: [],
      toClient: [
        {
          ...message,
          result: { ...(message.result ?? {}), configOptions: this.configOptions(state) },
        },
      ],
    };
  }

  handleRuntimeMethod(message) {
    message = this.forks.update(message);
    if (!message) return { toRuntime: [], toClient: [] };
    const scheduleSessionId = message.params?.sessionId;
    const ownsScheduleSession = this.sessions.has(scheduleSessionId) ||
      (typeof scheduleSessionId === 'string' && [...this.pending.values()].some(
        (pending) => pending.kind === 'session' && pending.sessionId === scheduleSessionId &&
          ['session/load', 'session/resume'].includes(pending.method)
      ));
    if (ownsScheduleSession) {
      message = scheduledTaskUpdate(message);
      if (!message) return { toRuntime: [], toClient: [] };
    }
    if (supportsLodySubagentEvents(this.clientCapabilities)) {
      const normalized = this.subagents.handle(message, this.sessions);
      if (normalized?.length === 1 && normalized[0].method === 'session/request_permission') message = normalized[0];
      else if (normalized !== null) return { toRuntime: [], toClient: normalized };
    }
    const passthrough = { toRuntime: [], toClient: [message] };
    const logicalMethod = logicalExtensionMethod(message.method);
    if (logicalMethod === contract.planApprovalRequest) {
      return this.planReviews.start(message, this.sessions, this.clientCapabilities);
    }
    if (logicalMethod === contract.modelsUpdateNotification) {
      return this.handleModelSnapshot(message);
    }
    const sessionId = message.params?.sessionId;
    const update = message.params?.update;
    const state = this.sessions.get(sessionId);
    if (!state) return passthrough;

    // The official runtime owns these titles but does not distinguish generated
    // names from manual renames. Match Core's explicit-name semantics; never
    // upgrade an upstream source tag (especially fallback/unset).
    if (
      message.method === 'session/update' &&
      update?.sessionUpdate === 'session_info_update' &&
      typeof update.title === 'string' &&
      update.title.trim() &&
      !Object.hasOwn(update._meta?.lody ?? {}, 'titleSource')
    ) {
      return {
        toRuntime: [],
        toClient: [{
          ...message,
          params: {
            ...message.params,
            update: {
              ...update,
              _meta: {
                ...update._meta,
                lody: { ...update._meta?.lody, titleSource: 'explicit' },
              },
            },
          },
        }],
      };
    }

    // YOLO is also a client-side policy in Grok. Resolve native permission
    // requests here so clients never briefly render an unanswered request.
    // Prefer a one-shot grant, but honor YOLO when only AllowAlways is offered.
    if (
      message.method === 'session/request_permission' &&
      message.id !== undefined &&
      this.permissionModes.get(state.clientIdentifier) === 'always-approve' &&
      !message.params?._meta?.lody?.elicitation &&
      message.params?.toolCall?.kind !== 'switch_mode' &&
      Array.isArray(message.params?.options)
    ) {
      const options = message.params.options;
      const isSelectable = (option) => typeof option?.optionId === 'string';
      const allow =
        options.find((option) => isSelectable(option) && option.kind === 'allow_once') ??
        options.find((option) => isSelectable(option) && option.kind === 'allow_always');
      if (allow) {
        return {
          toRuntime: [
            {
              jsonrpc: '2.0',
              id: message.id,
              result: { outcome: { outcome: 'selected', optionId: allow.optionId } },
            },
          ],
          toClient: [],
        };
      }
    }

    if (
      logicalMethod === contract.sessionUpdateNotification &&
      update?.sessionUpdate === contract.turnCompletedUpdate
    ) {
      if (message.params?._meta?.isReplay === true) return passthrough;
      const promptId = update.prompt_id ?? update.promptId;
      const usage = this.usageForPrompt(state, promptId, update.usage);
      return {
        toRuntime: this.usageRefreshRequestsForPrompt(state, promptId),
        toClient: usage ? [message, usage] : [message],
      };
    }

    if (
      message.method === 'session/update' &&
      update?.sessionUpdate === 'config_option_update' &&
      Array.isArray(update.configOptions)
    ) {
      this.applyRuntimeConfigOptions(state, update.configOptions);
      return {
        toRuntime: [],
        toClient: [
          {
            ...message,
            params: {
              ...message.params,
              update: { ...update, configOptions: this.configOptions(state) },
            },
          },
        ],
      };
    }

    if (message.method === 'session/update' && update?.sessionUpdate === 'current_mode_update') {
      const interactionMode = INTERACTION_FROM_RUNTIME[update.currentModeId];
      if (!interactionMode) return passthrough;
      state.interactionMode = interactionMode;
      return {
        toRuntime: [],
        toClient: [
          message,
          {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: this.configOptions(state),
              },
            },
          },
        ],
      };
    }

    if (
      logicalMethod === contract.sessionNotification &&
      update?.sessionUpdate === 'model_changed'
    ) {
      const modelId = update.model_id ?? update.modelId;
      const reasoningEffort = update.reasoning_effort ?? update.reasoningEffort;
      if (typeof modelId === 'string') {
        this.applyCurrentModel(state, modelId, reasoningEffort);
      }
      const publishesStandardConfig =
        configOption(state.runtimeConfigOptions, 'model') !== undefined ||
        configOption(state.runtimeConfigOptions, 'reasoning_effort') !== undefined;
      if (publishesStandardConfig) {
        // Grok 1.0.34 emits a complete standard config_option_update directly
        // after this private precursor. Keep the internal state current, but
        // let that authoritative snapshot be the single client-visible update.
        return {
          toRuntime: [this.internalRequest('context', sessionId)],
          toClient: [],
        };
      }
      // The vendor notification is not standard ACP and Lody ignores it, so
      // legacy sessions receive the state change as a standard config update.
      return {
        toRuntime: [this.internalRequest('context', sessionId)],
        toClient: [
          {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: this.configOptions(state),
              },
            },
          },
        ],
      };
    }

    return passthrough;
  }

  stateFromSessionResponse(sessionId, clientIdentifier, result) {
    const old = this.sessions.get(sessionId);
    const legacy = legacyOptions(result);
    const legacyModels = legacy.filter((option) => option.category === 'model');
    const legacyEfforts = legacy.filter((option) => option.category === 'mode');
    const hasRuntimeConfigOptions = Array.isArray(result.configOptions);
    const runtimeConfigOptions = standardConfigOptions(result);
    const runtimeModelOption = configOption(runtimeConfigOptions, 'model');
    const runtimeReasoningOption = configOption(runtimeConfigOptions, 'reasoning_effort');
    const availableModels = result.models?.availableModels ?? [];
    const currentModelId =
      result.models?.currentModelId ??
      runtimeModelOption?.currentValue ??
      legacyModels.find((option) => option.selected)?.id ??
      old?.currentModelId;
    const currentModel = availableModels.find((model) => model.modelId === currentModelId);
    const metadataReasoningOptions = readReasoningOptions(currentModel);
    const runtimeReasoningOptions = reasoningOptionsFromConfig(runtimeReasoningOption);
    const legacyReasoningOptions = legacyEfforts.map((option) => ({
      id: option.id,
      value: option.id,
      name: option.label ?? optionName(option.id),
      description: option.description ?? null,
      default: false,
    }));
    const reasoningOptions = metadataReasoningOptions.length
      ? metadataReasoningOptions
      : runtimeReasoningOptions.length
        ? runtimeReasoningOptions
        : legacyReasoningOptions;
    const reportedReasoningEffort =
      runtimeReasoningOption?.currentValue ??
      legacyEfforts.find((option) => option.selected)?.id ??
      currentModel?._meta?.reasoningEffort ??
      currentModel?._meta?.reasoning_effort;
    const state = {
      sessionId,
      clientIdentifier: clientIdentifier ?? old?.clientIdentifier,
      interactionMode:
        INTERACTION_FROM_RUNTIME[result.modes?.currentModeId] ?? old?.interactionMode ?? 'agent',
      currentModelId,
      models: availableModels.length
        ? availableModels
        : legacyModels.map((option) => ({
            modelId: option.id,
            name: option.label,
            description: option.description,
          })),
      runtimeConfigOptions: hasRuntimeConfigOptions
        ? runtimeConfigOptions
        : (old?.runtimeConfigOptions ?? []),
      reasoningOptions,
      reasoningEfforts: reasoningOptions.map((option) => option.id),
      reasoningEffort:
        reasoningSelector(reasoningOptions, reportedReasoningEffort) ??
        (typeof reportedReasoningEffort === 'string' ? reportedReasoningEffort : undefined) ??
        old?.reasoningEffort ??
        reasoningOptions.find((option) => option.default)?.id ??
        reasoningOptions[0]?.id,
      usageAccumulator: old?.usageAccumulator ?? new SessionUsageAccumulator(),
      usageRefreshPromptIds: old?.usageRefreshPromptIds ?? new Set(),
    };
    if (hasRuntimeConfigOptions) this.applyRuntimeConfigOptions(state, runtimeConfigOptions);
    return state;
  }

  configOptions(state) {
    const permissions = [
      {
        value: 'ask',
        name: 'Ask Every Time',
        description: 'Request approval for protected actions',
      },
      {
        value: 'always-approve',
        name: 'Always Approve',
        description: 'Approve protected actions automatically',
      },
    ];
    if (this.supportsAutoPermission()) {
      permissions.splice(1, 0, {
        value: 'auto',
        name: 'Auto',
        description: 'Ask Grok to assess actions automatically; native policy can still require approval',
      });
    }
    const options = [
      createPlanModeConfigOption(state.interactionMode === 'plan'),
      selectOption(
        'permission_mode',
        'Permission Mode',
        this.permissionModes.get(state.clientIdentifier) === 'auto'
          ? 'Auto requested. Grok may fall back to Ask if Auto is disabled; this selection is not a runtime confirmation.'
          : 'Requested policy for protected tool approvals',
        this.permissionModes.get(state.clientIdentifier) ?? 'ask',
        permissions,
        '_permission'
      ),
    ];
    const runtimeOptions = state.runtimeConfigOptions ?? [];
    const emittedRuntimeIds = new Set();
    for (const runtimeOption of runtimeOptions) {
      if (runtimeOption.id === 'model') {
        emittedRuntimeIds.add(runtimeOption.id);
        options.push({
          ...runtimeOption,
          ...(state.currentModelId ? { currentValue: state.currentModelId } : {}),
          ...(state.models.length
            ? {
                options: state.models.map((model) => {
                  const published = runtimeOption.options?.find(
                    (option) => option?.value === model.modelId
                  );
                  return {
                    ...published,
                    value: model.modelId,
                    name: published?.name || model.name || model.modelId,
                    description: published?.description ?? model.description ?? null,
                  };
                }),
              }
            : {}),
        });
      } else if (
        runtimeOption.id === 'reasoning_effort' &&
        state.reasoningOptions.length &&
        state.reasoningEffort
      ) {
        emittedRuntimeIds.add(runtimeOption.id);
        options.push({
          ...runtimeOption,
          ...(state.reasoningEffort ? { currentValue: state.reasoningEffort } : {}),
          ...(state.reasoningOptions.length
            ? {
                options: state.reasoningOptions.map((option) => {
                  const published = runtimeOption.options?.find(
                    (candidate) => candidate?.value === option.id
                  );
                  return {
                    ...published,
                    value: option.id,
                    name: published?.name || option.name || optionName(option.id),
                    description: published?.description ?? option.description ?? null,
                  };
                }),
              }
            : {}),
        });
      } else if (runtimeOption.id !== 'model' && runtimeOption.id !== 'reasoning_effort') {
        emittedRuntimeIds.add(runtimeOption.id);
        options.push(runtimeOption);
      }
    }
    if (state.currentModelId && !emittedRuntimeIds.has('model')) {
      options.push(
        selectOption(
          'model',
          'Model',
          'Select the model used for this session',
          state.currentModelId,
          state.models.map((model) => ({
            value: model.modelId,
            name: model.name || model.modelId,
            description: model.description ?? null,
          })),
          'model'
        )
      );
    }
    if (
      state.reasoningOptions.length &&
      state.reasoningEffort &&
      !emittedRuntimeIds.has('reasoning_effort')
    ) {
      options.push(
        selectOption(
          'reasoning_effort',
          'Reasoning Effort',
          'Controls how much reasoning the model performs',
          state.reasoningEffort,
          state.reasoningOptions.map((option) => ({
            value: option.id,
            name: option.name,
            description: option.description,
          })),
          'thought_level'
        )
      );
    }
    return options;
  }
}
