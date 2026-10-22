export type ActivityKind = 'context_compaction' | 'retry';

/** Canonical identities for tool flows handled specially. */
export const EXTENSION_TOOL_NAMES = {
  imageGeneration: 'ImageGeneration',
  cronCreate: 'CronCreate',
  cronDelete: 'CronDelete',
  cronList: 'CronList',
  scheduleWakeup: 'ScheduleWakeup',
} as const;

/** @deprecated Use `EXTENSION_TOOL_NAMES` instead. */
export const LODY_TOOL_NAMES = EXTENSION_TOOL_NAMES;

export type ActivityMeta = {
  version: 1;
  kind: ActivityMetaKind;
  automatic?: boolean;
  usedTokensBefore?: number;
  usedTokensAfter?: number;
  durationMs?: number;
  failureReason?: string;
};

type ActivityMetaKind = ActivityKind;

/**
 * What the native agent is doing right now, whether or not a client prompt is
 * open. `running` covers work the agent starts by itself, for example the turn
 * that follows a finished background shell; `requires_action` means it waits
 * on a permission request or question.
 */
export type SessionActivityState = 'idle' | 'running' | 'requires_action';

/**
 * A level, not an event: each update replaces the previous one for its
 * session. Sent whenever either field changes. A client that never receives
 * one, or whose agent process exits, must assume `idle` with no tasks.
 */
export type SessionActivityUpdate = {
  version: 1;
  sessionId: string;
  state: SessionActivityState;
  /**
   * Live background tasks that will wake the agent when they finish or emit:
   * shells, monitors, and background subagents. Excludes ambient tasks such
   * as internal watchers that never count as user-visible work.
   */
  backgroundTaskCount: number;
};

export type TaskKind = 'subagent' | 'background' | 'scheduled';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type TaskUsage = {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
};

export type TaskMeta = {
  version: 1;
  taskId: string;
  kind: TaskKind;
  status: TaskStatus;
  description?: string;
  actor?: string;
  parentTaskId?: string;
  parentToolCallId?: string;
  modelId?: string;
  startedAtEpochSeconds?: number;
  endedAtEpochSeconds?: number;
  summary?: string;
  error?: string;
  lastToolName?: string;
  usage?: TaskUsage;
  skipTranscript?: boolean;
};

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'limited' | 'complete';

export type GoalSnapshot = {
  objective: string;
  status: GoalStatus;
  iterations?: number;
  lastReason?: string | null;
  createdAtEpochSeconds?: number;
  updatedAtEpochSeconds?: number;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};

export type GoalControlRequest =
  | { sessionId: string; action: 'set'; objective: string }
  | { sessionId: string; action: 'pause' | 'resume' | 'clear' };

export type GoalControlResponse = {
  goal: GoalSnapshot | null;
};

/**
 * Client→agent prompt metadata that makes a prompt carry a goal action instead
 * of user-visible command text.
 */
export type GoalPromptControl =
  | { version: 1; action: 'set'; objective: string }
  | { version: 1; action: 'pause' | 'resume' | 'clear' };

export type SteerPromptMeta = {
  id: string;
};

export type SteerRequest<TContent = unknown> = {
  sessionId: string;
  prompt: TContent[];
  steerId: string;
};

export type SteerResponse = {
  outcome: 'injected' | 'failed';
};

export type SteerApplied = {
  sessionId: string;
  steerId: string;
};

export type SubagentTask = {
  taskId: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  agentId?: string;
  subagentType?: string;
  modelId?: string;
  thinkingEffort?: string;
  startedAtEpochSeconds: number;
  endedAtEpochSeconds: number | null;
  stopReason?: string;
};

export type SubagentsListRequest = {
  sessionId: string;
  activeOnly?: boolean;
};

export type SubagentsListResponse = {
  tasks: SubagentTask[];
};

export type SubagentCancelRequest = {
  sessionId: string;
  taskId: string;
  reason?: string;
};

export type SubagentCancelResponse = Record<string, never>;

export type SubagentOutputRequest = {
  sessionId: string;
  taskId: string;
  tail?: number;
};

export type SubagentOutputResponse = {
  output: string;
};

export type Notice = {
  level: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
};

/** Logical local project identity; ACP cwd remains the actual execution directory. */
export type WorktreeProject = {
  version: 1;
  /** Absolute project root on the agent host, including when cwd is a worktree. */
  originProjectPath: string;
};

/** Driving-turn configuration for new/load/resume/fork, before native session establishment. */
export type SessionConfig = {
  version: 1;
  modelId?: string | undefined;
  configOptionValues: Record<string, string | boolean>;
};

export type SessionMeta = {
  sessionConfig?: SessionConfig;
  worktreeProject?: WorktreeProject;
  turnId?: string;
  forkAtTurn?: { version: 1; turnId?: string };
  steer?: SteerPromptMeta;
  toolName?: string;
  activity?: ActivityMeta;
  task?: TaskMeta;
  /** Agent→client goal snapshot published on session updates. */
  goal?: GoalSnapshot | null;
  /** Client→agent goal action carried by `session/prompt`. */
  goalControl?: GoalPromptControl;
  notice?: Notice;
  titleSource?: 'explicit' | 'generated' | 'fallback' | 'unset';
  messagePhase?: 'commentary' | 'final_answer';
};

export type SessionHistoryReadRequest = {
  sessionId: string;
};

export type SessionHistoryReadResponse = Record<string, never>;

/** @deprecated Use `ActivityKind` instead. */
export type LodyActivityKind = ActivityKind;
/** @deprecated Use `ActivityMeta` instead. */
export type LodyActivityMeta = ActivityMeta;
/** @deprecated Use `SessionActivityState` instead. */
export type LodySessionActivityState = SessionActivityState;
/** @deprecated Use `SessionActivityUpdate` instead. */
export type LodySessionActivityUpdate = SessionActivityUpdate;
/** @deprecated Use `TaskKind` instead. */
export type LodyTaskKind = TaskKind;
/** @deprecated Use `TaskStatus` instead. */
export type LodyTaskStatus = TaskStatus;
/** @deprecated Use `TaskUsage` instead. */
export type LodyTaskUsage = TaskUsage;
/** @deprecated Use `TaskMeta` instead. */
export type LodyTaskMeta = TaskMeta;
/** @deprecated Use `GoalStatus` instead. */
export type LodyGoalStatus = GoalStatus;
/** @deprecated Use `GoalSnapshot` instead. */
export type LodyGoalSnapshot = GoalSnapshot;
/** @deprecated Use `GoalControlRequest` instead. */
export type LodyGoalControlRequest = GoalControlRequest;
/** @deprecated Use `GoalControlResponse` instead. */
export type LodyGoalControlResponse = GoalControlResponse;
/** @deprecated Use `GoalPromptControl` instead. */
export type LodyGoalPromptControl = GoalPromptControl;
/** @deprecated Use `SteerPromptMeta` instead. */
export type LodySteerPromptMeta = SteerPromptMeta;
/** @deprecated Use `SteerRequest` instead. */
export type LodySteerRequest<TContent = unknown> = SteerRequest<TContent>;
/** @deprecated Use `SteerResponse` instead. */
export type LodySteerResponse = SteerResponse;
/** @deprecated Use `SteerApplied` instead. */
export type LodySteerApplied = SteerApplied;
/** @deprecated Use `SubagentTask` instead. */
export type LodySubagentTask = SubagentTask;
/** @deprecated Use `SubagentsListRequest` instead. */
export type LodySubagentsListRequest = SubagentsListRequest;
/** @deprecated Use `SubagentsListResponse` instead. */
export type LodySubagentsListResponse = SubagentsListResponse;
/** @deprecated Use `SubagentCancelRequest` instead. */
export type LodySubagentCancelRequest = SubagentCancelRequest;
/** @deprecated Use `SubagentCancelResponse` instead. */
export type LodySubagentCancelResponse = SubagentCancelResponse;
/** @deprecated Use `SubagentOutputRequest` instead. */
export type LodySubagentOutputRequest = SubagentOutputRequest;
/** @deprecated Use `SubagentOutputResponse` instead. */
export type LodySubagentOutputResponse = SubagentOutputResponse;
/** @deprecated Use `Notice` instead. */
export type LodyNotice = Notice;
/** @deprecated Use `WorktreeProject` instead. */
export type LodyWorktreeProject = WorktreeProject;
/** @deprecated Use `SessionConfig` instead. */
export type LodySessionConfig = SessionConfig;
/** @deprecated Use `SessionMeta` instead. */
export type LodySessionMeta = SessionMeta;
/** @deprecated Use `SessionHistoryReadRequest` instead. */
export type LodySessionHistoryReadRequest = SessionHistoryReadRequest;
/** @deprecated Use `SessionHistoryReadResponse` instead. */
export type LodySessionHistoryReadResponse = SessionHistoryReadResponse;
