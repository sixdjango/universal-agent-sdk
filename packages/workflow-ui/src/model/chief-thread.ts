import type { ChiefCommand, ChiefTriggerKind, LiveAttemptProgress, WaitRequest } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';
import { buildChiefThinkingTrace, type ThinkingTraceModel } from './thinking';

export type ChiefThreadItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string; readonly atMs: number; readonly answered: boolean }
  | {
      readonly kind: 'chief';
      readonly id: string;
      /** What prompted it: a human message, or something the chief noticed on its own. */
      readonly trigger: ChiefTriggerKind;
      readonly nodeName?: string;
      /** The chief's words: its reply, or its rationale when it acted on its own. */
      readonly text: string;
      readonly applied: readonly string[];
      readonly rejected: readonly string[];
      readonly thinking?: ThinkingTraceModel;
      readonly atMs: number;
    }
  | { readonly kind: 'escalation'; readonly id: string; readonly wait: WaitRequest; readonly atMs: number };

export interface ChiefThread {
  readonly items: readonly ChiefThreadItem[];
  /** A message has no answer yet. */
  readonly waitingForChief: boolean;
  /** Live thinking trace while the chief is actively working on an answer or intervention. */
  readonly activeThinking: ThinkingTraceModel;
  /** Entries the chief added (replies and interventions), for unread counts. */
  readonly chiefEntryCount: number;
}

export const TRIGGER_LABEL: Readonly<Record<ChiefTriggerKind, string>> = {
  'node.failed': 'a step failed',
  'loop.round_needs_fix': 'a loop round needs fixes',
  'wait.requested': 'an agent asked a question',
  'run.stalled': 'the run stalled',
  'budget.exceeded': 'the budget ran out',
  'escalation.resolved': 'you answered',
  'user.message': 'your message',
};

/** One readable line per command, e.g. "Retried Draft". */
export function describeCommand(command: ChiefCommand, nodeName: (id: string) => string): string {
  switch (command.kind) {
    case 'report':
      return `Noted: ${command.summary}`;
    case 'inject_guidance':
      return `Told ${nodeName(command.nodeId)}: “${command.text}”`;
    case 'retry_node':
      return `Retried ${nodeName(command.nodeId)}`;
    case 'rerun_from_node':
      return `Re-ran from ${nodeName(command.nodeId)}`;
    case 'swap_agent':
      return `Gave ${nodeName(command.nodeId)} to ${command.agentRef}`;
    case 'answer_wait':
      return `Answered a question: ${typeof command.answer === 'string' ? command.answer : JSON.stringify(command.answer)}`;
    case 'extend_loop':
      return `Gave ${nodeName(command.nodeId)} ${command.extraRounds} more round${command.extraRounds === 1 ? '' : 's'}`;
    case 'escalate':
      return `Asked you: ${command.prompt}`;
  }
}

/**
 * The conversation with a run's chief, from its log: your messages, the chief's replies and
 * the interventions it made on its own, plus its open question to you, in time order.
 */
export function buildChiefThread(
  run: WorkflowRunState | null,
  nodeName: (id: string) => string,
  liveProgress?: readonly LiveAttemptProgress[]
): ChiefThread {
  const chiefLive = liveProgress?.find((p) => p.nodeId === '$chief');
  const activeThinking = buildChiefThinkingTrace({ running: true, ...(chiefLive ? { live: chiefLive } : {}) });
  if (!run) return { items: [], waitingForChief: false, activeThinking, chiefEntryCount: 0 };
  const answered = new Set<string>();
  for (const e of run.events) if (e.type === 'chief.intervened' && e.inReplyTo) answered.add(e.inReplyTo);

  const items: ChiefThreadItem[] = [];
  let chiefEntryCount = 0;
  run.events.forEach((e, index) => {
    if (e.type === 'chief.user_message') {
      items.push({ kind: 'user', id: e.messageId, text: e.text, atMs: e.timestampMs, answered: answered.has(e.messageId) });
    } else if (e.type === 'chief.intervened') {
      // Silent automatic reviews (nothing done, nothing said) are noise in a conversation.
      if (e.trigger !== 'user.message' && !e.reply && e.applied.length === 0 && e.rejected.length === 0) return;
      chiefEntryCount += 1;
      const applied = e.applied.filter((c) => c.kind !== 'escalate').map((c) => describeCommand(c, nodeName));
      const rejected = e.rejected.map((r) => `${describeCommand(r.command, nodeName)} — not allowed: ${r.reason}`);
      const resolvedNodeName = e.nodeId ? nodeName(e.nodeId) : undefined;
      const thinking = buildChiefThinkingTrace({
        running: false,
        triggerLabel: TRIGGER_LABEL[e.trigger],
        ...(resolvedNodeName ? { nodeName: resolvedNodeName } : {}),
        rationale: e.rationale,
        applied,
        rejected,
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        ...(e.steps ? { steps: e.steps } : {}),
      });
      items.push({
        kind: 'chief',
        id: `chief-${index}`,
        trigger: e.trigger,
        ...(resolvedNodeName ? { nodeName: resolvedNodeName } : {}),
        text: e.reply ?? e.rationale,
        applied,
        rejected,
        thinking,
        atMs: e.timestampMs,
      });
    }
  });

  const pendingId = run.chief.pendingEscalationId;
  const wait = pendingId ? run.waitRequests[pendingId] : undefined;
  if (wait?.status === 'PENDING') {
    chiefEntryCount += 1;
    items.push({ kind: 'escalation', id: wait.requestId, wait, atMs: wait.createdAtMs });
  }

  return {
    items,
    waitingForChief: items.some((i) => i.kind === 'user' && !i.answered) || !!chiefLive,
    activeThinking,
    chiefEntryCount,
  };
}
