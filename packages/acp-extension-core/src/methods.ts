import type { SubagentEvent } from './subagent-events.js';
import type {
  RateLimitsGetRequest,
  RateLimitsGetResponse,
  RateLimitsUpdate,
} from './rate-limits.js';
import type {
  GoalControlRequest,
  SessionActivityUpdate,
  GoalControlResponse,
  SessionHistoryReadRequest,
  SessionHistoryReadResponse,
  SteerApplied,
  SteerRequest,
  SteerResponse,
  SubagentCancelRequest,
  SubagentCancelResponse,
  SubagentOutputRequest,
  SubagentOutputResponse,
  SubagentsListRequest,
  SubagentsListResponse,
} from './session.js';
import type { SessionUsageUpdate } from './usage.js';

export const EXTENSION_METHODS = {
  subagentEvent: '_lody/subagents/event',
  sessionUsageUpdate: '_lody/session/usage_update',
  rateLimitsGet: '_lody/rate_limits/get',
  rateLimitsUpdate: '_lody/rate_limits/update',
  sessionSteer: '_lody/session/steer',
  sessionSteerApplied: '_lody/session/steer_applied',
  sessionActivityUpdate: '_lody/session/activity_update',
  sessionGoal: '_lody/session/goal',
  sessionHistoryRead: '_lody/session/history/read',
  subagentsList: '_lody/subagents/list',
  subagentsCancel: '_lody/subagents/cancel',
  subagentsOutput: '_lody/subagents/output',
} as const;

export const UA_EXTENSION_METHODS = {
  subagentEvent: '_ua/subagents/event',
  sessionUsageUpdate: '_ua/session/usage_update',
  rateLimitsGet: '_ua/rate_limits/get',
  rateLimitsUpdate: '_ua/rate_limits/update',
  sessionSteer: '_ua/session/steer',
  sessionSteerApplied: '_ua/session/steer_applied',
  sessionActivityUpdate: '_ua/session/activity_update',
  sessionGoal: '_ua/session/goal',
  sessionHistoryRead: '_ua/session/history/read',
  subagentsList: '_ua/subagents/list',
  subagentsCancel: '_ua/subagents/cancel',
  subagentsOutput: '_ua/subagents/output',
} as const;

/** @deprecated Use `EXTENSION_METHODS` instead. */
export const LODY_EXTENSION_METHODS = EXTENSION_METHODS;

export type ExtensionMethod =
  (typeof EXTENSION_METHODS)[keyof typeof EXTENSION_METHODS];

/** @deprecated Use `ExtensionMethod` instead. */
export type LodyExtensionMethod = ExtensionMethod;

export type ExtensionRequestMap<TPrompt = unknown> = {
  [EXTENSION_METHODS.rateLimitsGet]: {
    params: RateLimitsGetRequest;
    result: RateLimitsGetResponse;
  };
  [EXTENSION_METHODS.sessionSteer]: {
    params: SteerRequest<TPrompt>;
    result: SteerResponse;
  };
  [EXTENSION_METHODS.sessionGoal]: {
    params: GoalControlRequest;
    result: GoalControlResponse;
  };
  [EXTENSION_METHODS.sessionHistoryRead]: {
    params: SessionHistoryReadRequest;
    result: SessionHistoryReadResponse;
  };
  [EXTENSION_METHODS.subagentsList]: {
    params: SubagentsListRequest;
    result: SubagentsListResponse;
  };
  [EXTENSION_METHODS.subagentsCancel]: {
    params: SubagentCancelRequest;
    result: SubagentCancelResponse;
  };
  [EXTENSION_METHODS.subagentsOutput]: {
    params: SubagentOutputRequest;
    result: SubagentOutputResponse;
  };
};

export type ExtensionNotificationMap = {
  [EXTENSION_METHODS.subagentEvent]: SubagentEvent;
  [EXTENSION_METHODS.sessionUsageUpdate]: SessionUsageUpdate;
  [EXTENSION_METHODS.rateLimitsUpdate]: RateLimitsUpdate;
  [EXTENSION_METHODS.sessionSteerApplied]: SteerApplied;
  [EXTENSION_METHODS.sessionActivityUpdate]: SessionActivityUpdate;
};

export type ExtensionRequestMethod = keyof ExtensionRequestMap;
export type ExtensionNotificationMethod = keyof ExtensionNotificationMap;

/** Provider-side request surface; adapters implement only advertised capabilities. */
export type ExtensionRequestHandlers<TPrompt = unknown> = {
  [TMethod in keyof ExtensionRequestMap<TPrompt>]?: (
    params: ExtensionRequestMap<TPrompt>[TMethod]['params']
  ) =>
    | ExtensionRequestMap<TPrompt>[TMethod]['result']
    | Promise<ExtensionRequestMap<TPrompt>[TMethod]['result']>;
};

/** @deprecated Use `ExtensionRequestMap` instead. */
export type LodyExtensionRequestMap<TPrompt = unknown> = ExtensionRequestMap<TPrompt>;
/** @deprecated Use `ExtensionNotificationMap` instead. */
export type LodyExtensionNotificationMap = ExtensionNotificationMap;
/** @deprecated Use `ExtensionRequestMethod` instead. */
export type LodyExtensionRequestMethod = ExtensionRequestMethod;
/** @deprecated Use `ExtensionNotificationMethod` instead. */
export type LodyExtensionNotificationMethod = ExtensionNotificationMethod;
/** @deprecated Use `ExtensionRequestHandlers` instead. */
export type LodyExtensionRequestHandlers<TPrompt = unknown> = ExtensionRequestHandlers<TPrompt>;

/**
 * Normalizes an extension method name:
 * - Ensures leading `_`
 * - Maps `_ua/...` wire alias to canonical `_lody/...` method key so both wire prefixes work seamlessly.
 */
export function normalizeExtensionMethod(method: string): string {
  const withPrefix = method.startsWith('_') ? method : `_${method}`;
  if (withPrefix.startsWith('_ua/')) {
    return `_lody/${withPrefix.slice(4)}`;
  }
  return withPrefix;
}

/** @deprecated Use `normalizeExtensionMethod` instead. */
export const normalizeLodyExtensionMethod = normalizeExtensionMethod;
