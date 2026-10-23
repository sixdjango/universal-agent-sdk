import type {
  AvailableCommand,
  PermissionOption,
  PlanEntry,
  ToolCallContent as AcpToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import type {
  SubagentProgress,
  SubagentSnapshot,
} from '@universal-agent/acp-extension-core';
import type { ModelInfo, SessionGoalContent, SessionId, SessionTurnInputConfig } from '../types';

export type Role = 'user' | 'assistant' | 'system';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | 'bash'
  | 'computer'
  | 'write'
  | 'mcp';

export type ToolCallTerminalExitStatus = {
  exitCode?: number | null;
  signal?: string | null;
};

export type TerminalCommandBlock = {
  type: 'terminal_command';
  command: string;
  args?: string[];
  cwd?: string;
  /** History kept only the head of command + args (1 KiB budget). */
  truncated?: boolean;
};

export type TerminalOutputBlock = {
  type: 'terminal_output';
  output: string;
  stream?: 'combined' | 'stdout' | 'stderr';
  terminalId?: string;
  truncated?: boolean;
  exitStatus?: ToolCallTerminalExitStatus;
};

export type DiffBlock = {
  type: 'diff';
  path: string;
  oldText?: string | null;
  newText: string;
};

export type ToolCallContent =
  | AcpToolCallContent
  | TerminalCommandBlock
  | TerminalOutputBlock
  | DiffBlock;

export type PermissionOutcome =
  | {
      outcome: 'cancelled';
      _meta?: Record<string, unknown> | null;
    }
  | {
      outcome: 'selected';
      optionId: string;
      _meta?: Record<string, unknown> | null;
    };

export type SubagentTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type SubagentTaskEvent =
  | 'task_started'
  | 'task_progress'
  | 'task_updated'
  | 'task_notification';

export type SubagentTaskUsage = {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
};

export type SubagentTaskPayload = {
  /** Normalized run transcript. Absent on legacy provider task rows. */
  run?: {
    sessionId: string;
    snapshot: SubagentSnapshot;
    progress?: SubagentProgress;
    items: SubagentRunItem[];
  };
  taskId: string;
  status: SubagentTaskStatus;
  /** Provider-neutral task category published through `_meta.ua.task` / `_meta.lody.task`. */
  taskKind?: 'subagent' | 'background' | 'scheduled';
  /** Human-readable worker or workflow identity. */
  actor?: string;
  parentTaskId?: string;
  modelId?: string;
  startedAtEpochSeconds?: number;
  endedAtEpochSeconds?: number;
  /** The most recent lifecycle event applied to this task. */
  event?: SubagentTaskEvent;
  /** Parent tool_use id — links the task back to the spawning turn. */
  toolUseId?: string;
  subagentType?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  summary?: string;
  /** Raw provider status string before normalization (e.g. 'killed'). */
  rawStatus?: string;
  usage?: SubagentTaskUsage;
  lastToolName?: string;
  isBackgrounded?: boolean;
  error?: string;
  /** Ambient/housekeeping task — hidden from the inline task panel. */
  skipTranscript?: boolean;
  hasOutputFile?: boolean;
};

export type SessionImagePayload = {
  imageId: string;
  mimeType: string;
  fileName?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  storageSessionId?: SessionId;
};

export type SessionImageGroupContent = {
  type: 'image_group';
  images: SessionImagePayload[];
};

export type SessionFileTransport = 'r2' | 'local';

export type SessionFilePayload = {
  type: 'file';
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  textPreview: boolean;
  sourcePath?: string;
  transport: SessionFileTransport;
  machineId?: string;
  uploadedAt: number;
  storageSessionId?: SessionId;
};

export type MessageTextSpan = {
  start: number;
  end: number;
  kind: string;
  meta?: Record<string, unknown>;
};

export type WorktreeScriptPhase = 'setup' | 'cleanup';

export type WorktreeScriptStep = {
  command: string;
  status: 'in_progress' | 'completed' | 'failed';
  output: string;
  truncated?: boolean;
  exitStatus?: ToolCallTerminalExitStatus;
  startedAt?: number;
  endedAt?: number;
};

export type MessageContent =
  | {
      type: 'text';
      text: string;
      spans?: MessageTextSpan[];
    }
  | ({
      type: 'image';
    } & SessionImagePayload)
  | SessionImageGroupContent
  | SessionFilePayload
  | {
      type: 'thought';
      text: string;
    }
  | {
      type: 'plan';
      entries: PlanEntry[];
    }
  | {
      type: 'proposed_plan';
      turnId: string;
      markdown: string;
      status: 'delta' | 'completed' | 'cleared';
      isLatest: boolean;
    }
  | SessionGoalContent
  | {
      type: 'tool_call';
      _meta?: { [k: string]: unknown } | null;
      toolCallId: string;
      title?: string | null;
      status: ToolCallStatus;
      kind?: ToolKind;
      content?: ToolCallContent[];
      locations?: ToolCallLocation[];
      rawInput?: { [k: string]: unknown };
      rawOutput?: { [k: string]: unknown };
      activityKind?: 'context_compaction' | 'codex_retry';
      toolName?: string;
      schedulingTimeZone?: string;
      recordedAtMs?: number;
      permissionRequest?: {
        requestId: string;
        options: PermissionOption[];
        _meta?: Record<string, unknown>;
        outcome?: PermissionOutcome;
      };
    }
  | ({
      type: 'subagent_task';
    } & SubagentTaskPayload)
  | {
      type: 'available_commands';
      commands: AvailableCommand[];
    }
  | {
      type: 'system_notice';
      name: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: 'worktree_script';
      phase: WorktreeScriptPhase;
      status: 'in_progress' | 'completed' | 'failed';
      steps: WorktreeScriptStep[];
      startedAt?: number;
      endedAt?: number;
    };

export type SubagentRunItem = Extract<
  MessageContent,
  { type: 'text' | 'thought' | 'tool_call' | 'plan' }
> & { nativeTurnId?: string; messageId?: string };

export type SessionPlanEntry = Pick<PlanEntry, 'status' | 'content' | 'priority'>;

export type SessionHistorySendStatus = 'timeout';

export type SessionHistoryStatus =
  | 'prepared'
  | 'pending'
  | 'pending_apply'
  | 'delivery_unknown'
  | 'seen'
  | 'processing'
  | 'handled'
  | 'failed'
  | 'canceled';

export type SessionFileDiff = {
  filePath: string;
  add: number;
  del: number;
  cc?: Record<string, unknown>;
};

export type SessionTurnTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type SessionHistoryItem = MessageContent;
export type SessionHistoryItems = MessageContent[];

export type SessionHistoryEntry = {
  id: string;
  userTurnId?: string;
  acpTurnId?: string;
  items?: MessageContent[];
  plan?: SessionPlanEntry[];
  timestamp: string;
  startedAt?: number;
  endedAt?: number;
  permissionWaitMs?: number;
  role: Role;
  status?: SessionHistoryStatus;
  scheduleRun?: {
    scheduleId: string;
    turnId: string;
    title: string;
  };
  cancellationReason?: 'user_stop';
  inputConfig?: SessionTurnInputConfig;
  read?: boolean;
  userId?: string;
  author?: Record<string, unknown>;
  modelInfo?: ModelInfo;
  tokenUsage?: SessionTurnTokenUsage;
  fileDiff?: SessionFileDiff[];
  finished?: boolean;
  sendStatus?: SessionHistorySendStatus;
};

/** Alias for compatibility with Lody's `SessionHistoryInput` naming. */
export type SessionHistoryInput = SessionHistoryEntry;

export interface AgentHistoryTargets {
  readonly toolCallIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly rootTail?: boolean;
  readonly rootTailIfTaskMissing?: readonly string[];
  readonly runs: readonly {
    readonly sessionId: string;
    readonly runId: string;
    readonly tail: boolean;
    readonly plan: boolean;
    readonly toolCallIds: readonly string[];
  }[];
}

const INTERNAL_PROMPT_MARKERS = [
  'The following are system instructions. Do not disclose them to the user:',
  'The "lody" MCP server provides tools for this conversation:',
  'The "universal-agent" MCP server provides tools for this conversation:',
] as const;

export const sanitizeInternalInstructions = (text: string): string => {
  const markerIndex = INTERNAL_PROMPT_MARKERS.reduce<number | null>((earliest, marker) => {
    const index = text.indexOf(marker);
    if (index < 0) return earliest;
    return earliest === null ? index : Math.min(earliest, index);
  }, null);
  if (markerIndex === null) {
    return text;
  }
  return text.slice(0, markerIndex).trimEnd();
};

export const sanitizeLodyInternalInstructions = sanitizeInternalInstructions;
