export type VersionOneCapability = {
  version: 1;
};

/** Client support for Core semantics layered on standard ACP form elicitation. */
export type ElicitationCapability = VersionOneCapability & {
  /** Preserve a selection and its optional, separately keyed note end to end. */
  answerNotes?: true;
};

/** Advertised under InitializeRequest.clientCapabilities._meta.ua (or _meta.lody). */
export type ClientExtensionCapabilities = {
  subagentEvents?: VersionOneCapability;
  elicitation?: ElicitationCapability;
};

export type SteeringCapability = VersionOneCapability & {
  transport: 'request' | 'prompt';
  upstreamTurn: 'same' | 'handoff';
  configPolicy: 'active' | 'apply';
};

export type GoalAction = 'set' | 'pause' | 'resume' | 'clear';

export type GoalCapability = VersionOneCapability & {
  /** Every action the agent implements, on any transport. */
  actions: readonly GoalAction[];
  /**
   * Actions the agent accepts on `_ua/session/goal` (`_lody/session/goal`) while a prompt is in
   * flight. These only move durable goal state and never start a turn, so a
   * client can send them without owning the session's prompt slot.
   */
  controlActions?: readonly GoalAction[];
  /**
   * Actions the agent accepts through `prompt._meta.ua.goalControl` (`prompt._meta.lody.goalControl`). Actions
   * that start work appear only here: running them inside the client's own
   * prompt is what keeps the resulting turns attributable to a conversation.
   */
  promptActions?: readonly GoalAction[];
};

export type SubagentCapability = VersionOneCapability & {
  lifecycle: true;
  list?: true;
  cancel?: true;
  output?: true;
};

export type TaskCapability = VersionOneCapability & {
  background?: true;
  scheduled?: true;
};

export type RateLimitsCapability = VersionOneCapability & {
  query?: true;
};

export type ExtensionCapabilities = {
  subagentEvents?: VersionOneCapability;
  /** Owns title generation; pushes tagged session_info_update titles without a client request. */
  sessionTitle?: VersionOneCapability;
  usage?: VersionOneCapability;
  rateLimits?: RateLimitsCapability;
  forkAtTurn?: VersionOneCapability;
  steering?: SteeringCapability;
  tasks?: TaskCapability;
  subagents?: SubagentCapability;
  goal?: GoalCapability;
  compaction?: VersionOneCapability;
  sessionHistory?: VersionOneCapability;
  worktreeProject?: VersionOneCapability;
  /** Pushes `_ua/session/activity_update` (`_lody/session/activity_update`) levels, including outside client prompts. */
  sessionActivity?: VersionOneCapability;
};

/** @deprecated Use `VersionOneCapability` instead. */
export type LodyVersionOneCapability = VersionOneCapability;
/** @deprecated Use `ElicitationCapability` instead. */
export type LodyElicitationCapability = ElicitationCapability;
/** @deprecated Use `ClientExtensionCapabilities` instead. */
export type LodyClientExtensionCapabilities = ClientExtensionCapabilities;
/** @deprecated Use `SteeringCapability` instead. */
export type LodySteeringCapability = SteeringCapability;
/** @deprecated Use `GoalAction` instead. */
export type LodyGoalAction = GoalAction;
/** @deprecated Use `GoalCapability` instead. */
export type LodyGoalCapability = GoalCapability;
/** @deprecated Use `SubagentCapability` instead. */
export type LodySubagentCapability = SubagentCapability;
/** @deprecated Use `TaskCapability` instead. */
export type LodyTaskCapability = TaskCapability;
/** @deprecated Use `RateLimitsCapability` instead. */
export type LodyRateLimitsCapability = RateLimitsCapability;
/** @deprecated Use `ExtensionCapabilities` instead. */
export type LodyExtensionCapabilities = ExtensionCapabilities;
