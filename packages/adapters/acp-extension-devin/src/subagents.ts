import {
  isLodySubagentOutput,
  type LodySubagentEvent,
  type LodySubagentOutput,
  type LodySubagentProgress,
  type LodySubagentSnapshot,
} from "acp-extension-core";

import { privateWireContract as contract } from "./manifest.js";

const CONTEXT_META = contract.subagentContextMeta;
const SIDEKICK_META = contract.sidekickToolCallMeta;
const STARTED_META = contract.subagentStartedMeta;
const COMPLETED_META = contract.subagentCompletedMeta;
const SIDEKICK_ID_PREFIX = contract.sidekickToolCallIdPrefix;

const ROOT_ACTIVITY = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);
const TERMINAL_TOOL_STATUS = new Set(["completed", "failed"]);
const TOOL_DISPLAY_FIELDS = ["title", "kind", "rawInput", "locations"] as const;
const MAX_BUFFERED_CHILD_UPDATES = 64;

type Update = Record<string, unknown>;

export type SubagentOut =
  | { kind: "event"; event: LodySubagentEvent }
  | { kind: "root"; update: Update };

type EventPayload =
  | { type: "snapshot"; snapshot: LodySubagentSnapshot }
  | { type: "progress"; progress: LodySubagentProgress }
  | {
      type: "output";
      update: LodySubagentOutput;
      nativeTurnId?: string;
      messageId?: string;
    };

interface Run {
  runId: string;
  agentId: string;
  live: boolean;
  snapshot: LodySubagentSnapshot;
  /** toolCallIds this run emitted as output (for permission ownership). */
  toolIds: Set<string>;
  /** sidekick toolCallIds currently in progress. */
  inFlight: Set<string>;
  /** toolCallIds mirrored to root for permission prompts. */
  mirrors: Set<string>;
  /** display fields remembered per toolCallId for permission mirroring. */
  toolDisplay: Map<string, Record<string, unknown>>;
}

export interface DevinSubagentEventsOptions {
  newId?: () => string;
  /** epoch seconds */
  now?: () => number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function agentContext(update: Update): string | undefined {
  const meta = update["_meta"];
  if (!isRecord(meta)) return undefined;
  const ctx = meta[CONTEXT_META];
  if (!isRecord(ctx)) return undefined;
  const id = ctx["parentAgentId"];
  return typeof id === "string" ? id : undefined;
}

/** Merge the display fields a tool_call/_update carries into the run's record. */
function rememberToolDisplay(
  run: Run,
  toolCallId: string,
  update: Update,
): void {
  const entry = run.toolDisplay.get(toolCallId) ?? {};
  for (const field of TOOL_DISPLAY_FIELDS) {
    if (update[field] !== undefined) entry[field] = update[field];
  }
  run.toolDisplay.set(toolCallId, entry);
}

function usageProgress(update: Update): LodySubagentProgress {
  const progress: LodySubagentProgress = {};
  if (typeof update["used"] === "number")
    progress.contextTokens = update["used"];
  if (typeof update["size"] === "number")
    progress.contextWindowTokens = update["size"];
  return progress;
}

/**
 * Devin subagent + sidekick streams for one admitted root session.
 * run_subagent children publish explicit started/completed lifecycle rows;
 * sidekick has no lifecycle wire — a "handoff segment" of sk::/sidekick-flagged
 * activity is inferred as one run. Both are translated to Core subagentEvents.
 */
export class DevinSubagentEvents {
  private readonly runs = new Map<string, Run>();
  private sidekickRun: Run | undefined;
  private readonly buffered = new Map<string, Update[]>();
  private readonly overflowed = new Set<string>();
  /** toolCallIds owned by any closed sidekick run; late updates are dropped. */
  private readonly closedSkToolIds = new Set<string>();
  /** latest sidekick usage seen before a run exists. */
  private stashedProgress: LodySubagentProgress | undefined;
  /** root activity arrived while sidekick tools were still in flight. */
  private rootResumed = false;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(
    readonly sessionId: string,
    { newId, now }: DevinSubagentEventsOptions = {},
  ) {
    this.newId = newId ?? (() => crypto.randomUUID());
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
  }

  private emit(run: Run, payload: EventPayload): SubagentOut {
    return {
      kind: "event",
      event: {
        version: 1,
        sessionId: this.sessionId,
        runId: run.runId,
        ...payload,
      } as LodySubagentEvent,
    };
  }

  private createSubagentRun(
    agentId: string,
    started: Record<string, unknown>,
    ctx: string | undefined,
  ): Run {
    let parentRunId: string | null = null;
    if (ctx && ctx !== contract.rootAgentId) {
      if (ctx === contract.sidekickAgentId) {
        parentRunId = this.sidekickRun?.live ? this.sidekickRun.runId : null;
      } else {
        const parent = this.runs.get(ctx);
        parentRunId = parent?.live ? parent.runId : null;
      }
    }
    const description =
      typeof started["title"] === "string"
        ? started["title"]
        : typeof started["task"] === "string"
          ? started["task"]
          : undefined;
    const snapshot: LodySubagentSnapshot = {
      state: "running",
      parentRunId,
      ...(typeof started["profile"] === "string"
        ? { name: started["profile"] }
        : {}),
      ...(description !== undefined ? { description } : {}),
      ...(typeof started["model"] === "string"
        ? { modelId: started["model"] }
        : {}),
      startedAtEpochSeconds: this.now(),
      support: {
        stream: ["text", "thought", "tool", "plan"],
        progress: true,
        outputRead: "none",
        cancel: false,
      },
    };
    const run: Run = {
      runId: this.newId(),
      agentId,
      live: true,
      snapshot,
      toolIds: new Set(),
      inFlight: new Set(),
      mirrors: new Set(),
      toolDisplay: new Map(),
    };
    this.runs.set(agentId, run);
    return run;
  }

  /**
   * Open a new sidekick run. Returned outputs go to the client in order:
   * the snapshot first, then any stashed progress observed before the run.
   */
  private openSidekickRun(): { run: Run; out: SubagentOut[] } {
    const out: SubagentOut[] = [];
    const run: Run = {
      runId: this.newId(),
      agentId: contract.sidekickAgentId,
      live: true,
      snapshot: {
        state: "running",
        parentRunId: null,
        name: "Sidekick",
        startedAtEpochSeconds: this.now(),
        support: {
          stream: ["tool"],
          progress: true,
          outputRead: "none",
          cancel: false,
        },
      },
      toolIds: new Set(),
      inFlight: new Set(),
      mirrors: new Set(),
      toolDisplay: new Map(),
    };
    this.sidekickRun = run;
    out.push(this.emit(run, { type: "snapshot", snapshot: run.snapshot }));
    if (this.stashedProgress !== undefined) {
      const progress = this.stashedProgress;
      this.stashedProgress = undefined;
      out.push(this.emit(run, { type: "progress", progress }));
    }
    return { run, out };
  }

  private closeSidekickSnapshot(
    run: Run,
    patch: Partial<LodySubagentSnapshot>,
  ): SubagentOut {
    run.live = false;
    for (const id of run.toolIds) this.closedSkToolIds.add(id);
    this.rootResumed = false;
    run.snapshot = {
      ...run.snapshot,
      endedAtEpochSeconds: this.now(),
      ...patch,
    };
    return this.emit(run, { type: "snapshot", snapshot: run.snapshot });
  }

  private mirrorRootUpdate(
    run: Run,
    update: Update,
    toolCallId: string,
  ): Update {
    return {
      ...update,
      toolCallId: mirrorToolCallId(run.runId, toolCallId),
      _meta: {
        ...(isRecord(update["_meta"]) ? update["_meta"] : {}),
        lody: { subagentRunId: run.runId, subagentToolCallId: toolCallId },
      },
    };
  }

  /**
   * Classify one runtime `session/update` for this session.
   * Returns run events and root-bound updates in order; drops consumed rows.
   */
  handleSessionUpdate(update: Update): SubagentOut[] {
    const out: SubagentOut[] = [];
    const meta = isRecord(update["_meta"]) ? update["_meta"] : undefined;
    const ctx = agentContext(update);
    const sessionUpdate = update["sessionUpdate"];

    // 1. lifecycle rows: completed wins over started
    const completedMeta = meta?.[COMPLETED_META];
    const startedMeta = meta?.[STARTED_META];
    if (
      (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") &&
      (completedMeta !== undefined || startedMeta !== undefined)
    ) {
      if (completedMeta !== undefined) {
        if (
          !isRecord(completedMeta) ||
          typeof completedMeta["agentId"] !== "string"
        ) {
          out.push({ kind: "root", update });
          return out;
        }
        const run = this.runs.get(completedMeta["agentId"]);
        if (run?.live) {
          const failed = completedMeta["success"] === false;
          const patch: Partial<LodySubagentSnapshot> = {
            state: failed ? "failed" : "completed",
            endedAtEpochSeconds: this.now(),
            ...(typeof completedMeta["summary"] === "string"
              ? { summary: completedMeta["summary"] }
              : {}),
            ...(failed && typeof completedMeta["summary"] === "string"
              ? {
                  reason: {
                    code: "error" as const,
                    message: completedMeta["summary"],
                  },
                }
              : {}),
          };
          run.live = false;
          run.snapshot = { ...run.snapshot, ...patch };
          out.push(
            this.emit(run, { type: "snapshot", snapshot: run.snapshot }),
          );
        }
        return out; // lifecycle row never reaches root
      }
      // started
      if (
        !isRecord(startedMeta) ||
        typeof startedMeta["agentId"] !== "string"
      ) {
        out.push({ kind: "root", update });
        return out;
      }
      const agentId = startedMeta["agentId"];
      const existing = this.runs.get(agentId);
      if (existing?.live) return out; // duplicate start for a live run
      const run = this.createSubagentRun(agentId, startedMeta, ctx);
      out.push(this.emit(run, { type: "snapshot", snapshot: run.snapshot }));
      if (this.overflowed.delete(agentId)) {
        run.snapshot = { ...run.snapshot, outputIncomplete: true };
        out.push(this.emit(run, { type: "snapshot", snapshot: run.snapshot }));
      }
      const buffered = this.buffered.get(agentId);
      if (buffered) {
        this.buffered.delete(agentId);
        for (const u of buffered) out.push(...this.childUpdate(run, u));
      }
      return out;
    }

    // 2. subagent-internal updates
    if (
      typeof ctx === "string" &&
      ctx !== contract.rootAgentId &&
      ctx !== contract.sidekickAgentId
    ) {
      const run = this.runs.get(ctx);
      if (run?.live) {
        out.push(...this.childUpdate(run, update));
      } else if (!run) {
        // no run yet — started may not have arrived; buffer bounded
        const buf = this.buffered.get(ctx) ?? [];
        if (buf.length >= MAX_BUFFERED_CHILD_UPDATES) {
          this.overflowed.add(ctx);
        } else {
          buf.push(update);
          this.buffered.set(ctx, buf);
        }
      }
      // run terminated → drop
      return out;
    }

    // 3. sidekick
    const toolCallId =
      typeof update["toolCallId"] === "string"
        ? update["toolCallId"]
        : undefined;
    const isSidekick =
      ctx === contract.sidekickAgentId ||
      ((sessionUpdate === "tool_call" ||
        sessionUpdate === "tool_call_update") &&
        (meta?.[SIDEKICK_META] === true ||
          (toolCallId !== undefined &&
            toolCallId.startsWith(SIDEKICK_ID_PREFIX))));
    if (isSidekick) {
      // late update for a tool owned by any closed sidekick run
      if (toolCallId && this.closedSkToolIds.has(toolCallId)) {
        return out;
      }
      // usage alone never opens a run — keep the latest progress for later
      if (sessionUpdate === "usage_update" && !this.sidekickRun?.live) {
        this.stashedProgress = usageProgress(update);
        return out;
      }
      let run = this.sidekickRun;
      if (!run?.live) {
        const opened = this.openSidekickRun();
        run = opened.run;
        out.push(...opened.out);
      }
      if (sessionUpdate === "usage_update") {
        out.push(
          this.emit(run, { type: "progress", progress: usageProgress(update) }),
        );
        return out;
      }
      if (sessionUpdate === "tool_call" && toolCallId) {
        run.toolIds.add(toolCallId);
        run.inFlight.add(toolCallId);
      } else if (
        sessionUpdate === "tool_call_update" &&
        toolCallId &&
        TERMINAL_TOOL_STATUS.has(String(update["status"]))
      ) {
        run.inFlight.delete(toolCallId);
        if (toolCallId) run.toolIds.add(toolCallId);
      }
      if (
        (sessionUpdate === "tool_call" ||
          sessionUpdate === "tool_call_update") &&
        toolCallId
      ) {
        rememberToolDisplay(run, toolCallId, update);
      }
      if (isLodySubagentOutput(update)) {
        out.push(this.emit(run, { type: "output", update }));
        if (toolCallId && run.mirrors.has(toolCallId)) {
          out.push({
            kind: "root",
            update: this.mirrorRootUpdate(run, update, toolCallId),
          });
        }
      }
      // close deferred: root activity already seen, this was the last in-flight tool
      if (this.rootResumed && run.inFlight.size === 0) {
        out.push(this.closeSidekickSnapshot(run, { state: "completed" }));
      }
      return out;
    }

    // 4. root
    if (this.sidekickRun?.live && ROOT_ACTIVITY.has(String(sessionUpdate))) {
      if (this.sidekickRun.inFlight.size === 0) {
        out.push(
          this.closeSidekickSnapshot(this.sidekickRun, { state: "completed" }),
        );
      } else {
        this.rootResumed = true;
      }
    }
    out.push({ kind: "root", update });
    return out;
  }

  private childUpdate(run: Run, update: Update): SubagentOut[] {
    const out: SubagentOut[] = [];
    if (update["sessionUpdate"] === "usage_update") {
      out.push(
        this.emit(run, { type: "progress", progress: usageProgress(update) }),
      );
      return out;
    }
    if (
      (update["sessionUpdate"] === "tool_call" ||
        update["sessionUpdate"] === "tool_call_update") &&
      typeof update["toolCallId"] === "string"
    ) {
      rememberToolDisplay(run, update["toolCallId"], update);
    }
    if (isLodySubagentOutput(update)) {
      const toolCallId =
        "toolCallId" in update && typeof update["toolCallId"] === "string"
          ? update["toolCallId"]
          : undefined;
      if (toolCallId) run.toolIds.add(toolCallId);
      out.push(this.emit(run, { type: "output", update }));
      if (toolCallId && run.mirrors.has(toolCallId)) {
        out.push({
          kind: "root",
          update: this.mirrorRootUpdate(run, update, toolCallId),
        });
      }
      return out;
    }
    if (
      update["sessionUpdate"] === "agent_message_chunk" ||
      update["sessionUpdate"] === "agent_thought_chunk"
    ) {
      // failed the output contract — mark sticky, do not forward
      if (run.snapshot.outputIncomplete !== true) {
        run.snapshot = { ...run.snapshot, outputIncomplete: true };
        out.push(this.emit(run, { type: "snapshot", snapshot: run.snapshot }));
      }
      return out;
    }
    return out;
  }

  /**
   * Runtime `session/request_permission` for this session. Returns the
   * rewritten params when the toolCallId belongs to a live run, else null.
   */
  rewritePermissionParams(
    params: unknown,
  ): { events: SubagentOut[]; params: Record<string, unknown> } | null {
    if (!isRecord(params)) return null;
    const toolCall = params["toolCall"];
    if (!isRecord(toolCall) || typeof toolCall["toolCallId"] !== "string")
      return null;
    const id = toolCall["toolCallId"];

    const events: SubagentOut[] = [];
    let run: Run | undefined;
    for (const r of this.runs.values()) {
      if (r.live && r.toolIds.has(id)) {
        run = r;
        break;
      }
    }
    if (!run && this.sidekickRun?.live && this.sidekickRun.toolIds.has(id)) {
      run = this.sidekickRun;
    }
    if (!run && id.startsWith(SIDEKICK_ID_PREFIX)) {
      // any sk:: toolCallId belongs to the sidekick — attach to the live run
      // or open one so the client sees the run before this request.
      if (this.sidekickRun?.live) {
        run = this.sidekickRun;
      } else {
        const opened = this.openSidekickRun();
        events.push(...opened.out);
        run = opened.run;
      }
      run.toolIds.add(id);
    }
    if (!run) return null;
    run.mirrors.add(id);
    // Devin's request carries only toolCallId + _meta; merge the display
    // fields remembered from the run's own tool_call/_update so the client
    // can render a command-specific prompt and history card.
    const known = run.toolDisplay.get(id) ?? {};
    return {
      events,
      params: {
        ...params,
        toolCall: {
          ...known,
          ...toolCall,
          toolCallId: mirrorToolCallId(run.runId, id),
        },
        _meta: {
          ...(isRecord(params["_meta"]) ? params["_meta"] : {}),
          lody: { subagentRunId: run.runId, subagentToolCallId: id },
        },
      },
    };
  }

  /**
   * Client `session/prompt` response arrived. Close any live sidekick run
   * before the response; subagent runs are unaffected (may be background).
   */
  handlePromptDone(
    stopReason: string | undefined,
    isError: boolean,
  ): SubagentOut[] {
    this.stashedProgress = undefined;
    const run = this.sidekickRun;
    if (!run?.live) return [];
    let patch: Partial<LodySubagentSnapshot>;
    if (isError) {
      patch = {
        state: "unknown",
        outputIncomplete: true,
        reason: { code: "error" },
      };
    } else if (stopReason === "cancelled") {
      patch = { state: "cancelled", reason: { code: "cancelled" } };
    } else {
      patch = { state: "completed" };
    }
    return [this.closeSidekickSnapshot(run, patch)];
  }
}

export function mirrorToolCallId(runId: string, toolCallId: string): string {
  return `subagent:${encodeURIComponent(runId)}:${encodeURIComponent(toolCallId)}`;
}
