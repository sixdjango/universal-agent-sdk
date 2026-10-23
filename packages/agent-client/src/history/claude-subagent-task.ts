import { z } from 'zod';
import { getExtensionMetaContainer } from '../client/extension-parser';
import type { SubagentTaskPayload } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const UA_SUBAGENT_TASK_LIFECYCLE_RAW_INPUT_KEY = 'uaSubagentTaskLifecycle';
export const LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY = 'lodyClaudeTaskLifecycle';
export const LODY_SUBAGENT_TASK_LIFECYCLE_RAW_INPUT_KEY = 'lodySubagentTaskLifecycle';

export const SUBAGENT_TASK_EVENTS = [
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
] as const;

export const SUBAGENT_TASK_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;

const SubagentTaskUsageSchema = z.object({
  totalTokens: z.number().optional(),
  toolUses: z.number().optional(),
  durationMs: z.number().optional(),
});

export const SubagentTaskPayloadSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(SUBAGENT_TASK_STATUSES),
  taskKind: z.enum(['subagent', 'background', 'scheduled']).optional(),
  actor: z.string().optional(),
  parentTaskId: z.string().optional(),
  modelId: z.string().optional(),
  startedAtEpochSeconds: z.number().nonnegative().optional(),
  endedAtEpochSeconds: z.number().nonnegative().optional(),
  event: z.enum(SUBAGENT_TASK_EVENTS).optional(),
  toolUseId: z.string().optional(),
  subagentType: z.string().optional(),
  taskType: z.string().optional(),
  workflowName: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  rawStatus: z.string().optional(),
  usage: SubagentTaskUsageSchema.optional(),
  lastToolName: z.string().optional(),
  isBackgrounded: z.boolean().optional(),
  error: z.string().optional(),
  skipTranscript: z.boolean().optional(),
  hasOutputFile: z.boolean().optional(),
});

const TaskMetaSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  kind: z.enum(['subagent', 'background', 'scheduled']),
  status: z.enum(SUBAGENT_TASK_STATUSES),
  description: z.string().optional(),
  actor: z.string().optional(),
  parentTaskId: z.string().optional(),
  parentToolCallId: z.string().optional(),
  modelId: z.string().optional(),
  startedAtEpochSeconds: z.number().nonnegative().optional(),
  endedAtEpochSeconds: z.number().nonnegative().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  lastToolName: z.string().optional(),
  usage: SubagentTaskUsageSchema.optional(),
  skipTranscript: z.boolean().optional(),
});

/** Read a provider-neutral task lifecycle snapshot from `_meta.ua.task` or `_meta.lody.task`. */
export const parseTaskMeta = (meta: unknown): SubagentTaskPayload | null => {
  const ext = getExtensionMetaContainer(meta);
  if (!ext) return null;
  const parsed = TaskMetaSchema.safeParse(ext.task);
  if (!parsed.success) return null;
  const task = parsed.data;
  return {
    taskId: task.taskId,
    status: task.status,
    taskKind: task.kind,
    ...(task.actor !== undefined ? { actor: task.actor } : {}),
    ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.parentToolCallId !== undefined ? { toolUseId: task.parentToolCallId } : {}),
    ...(task.modelId !== undefined ? { modelId: task.modelId } : {}),
    ...(task.startedAtEpochSeconds !== undefined
      ? { startedAtEpochSeconds: task.startedAtEpochSeconds }
      : {}),
    ...(task.endedAtEpochSeconds !== undefined
      ? { endedAtEpochSeconds: task.endedAtEpochSeconds }
      : {}),
    ...(task.description !== undefined ? { description: task.description } : {}),
    ...(task.summary !== undefined ? { summary: task.summary } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.lastToolName !== undefined ? { lastToolName: task.lastToolName } : {}),
    ...(task.usage !== undefined ? { usage: task.usage } : {}),
    isBackgrounded: task.kind === 'background',
    ...(task.skipTranscript !== undefined ? { skipTranscript: task.skipTranscript } : {}),
  };
};

export const parseLodyTaskMeta = parseTaskMeta;

export const parseSubagentTaskWire = (rawInput: unknown): SubagentTaskPayload | null => {
  if (!isRecord(rawInput)) return null;
  const carrier =
    rawInput[UA_SUBAGENT_TASK_LIFECYCLE_RAW_INPUT_KEY] ??
    rawInput[LODY_SUBAGENT_TASK_LIFECYCLE_RAW_INPUT_KEY] ??
    rawInput[LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY];
  if (!isRecord(carrier)) return null;
  const parsed = SubagentTaskPayloadSchema.safeParse(carrier);
  return parsed.success ? (parsed.data as SubagentTaskPayload) : null;
};

export const mergeSubagentTaskPayload = (
  prev: SubagentTaskPayload,
  incoming: SubagentTaskPayload
): SubagentTaskPayload => {
  const merged = { ...prev, ...incoming };
  const prevTerminal = prev.status === 'completed' || prev.status === 'failed';
  const incomingTerminal = incoming.status === 'completed' || incoming.status === 'failed';
  if (prevTerminal && !incomingTerminal) {
    merged.status = prev.status;
    merged.event = prev.event;
  }
  return merged;
};
