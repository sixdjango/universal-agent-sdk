import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { nativeTurnId, type ForkEvent } from './session-fork.js';
import type { ToolCallBridge } from './tool-calls.js';
import type { HarnessUsageTracker } from './usage.js';

const blocks = z.array(z.object({ type: z.string() }).passthrough());
const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
});

/** Rebuild accounting in both paths; only load publishes historical transcript updates. */
export async function replaySessionHistory(
  events: readonly ForkEvent[],
  options: {
    sessionId: string;
    replay: boolean;
    tools: ToolCallBridge;
    usage: HarnessUsageTracker;
    content(block: { type: string }): Promise<ContentBlock | undefined>;
    emit(update: SessionUpdate): Promise<void>;
  }
): Promise<void> {
  let turn: number | undefined;
  for (const event of events) {
    const data = event.data;
    if (event.type === 'turn/start' && typeof data.turn === 'number') turn = data.turn;
    if (
      event.type === 'request/context' &&
      typeof data.provider === 'string' &&
      typeof data.model === 'string'
    )
      options.usage.setRoute(data.provider, data.model);
    if (event.type === 'assistant/message') {
      const usage = usageSchema.safeParse(data.usage);
      if (usage.success)
        options.usage.record(
          options.sessionId,
          event.seq,
          'time' in event && typeof event.time === 'number' ? event.time : NaN,
          usage.data
        );
    }
    if (!options.replay) continue;
    if (event.type.startsWith('tool/') || event.type === 'turn/end')
      await options.tools.event(event.type, data);
    if (event.type === 'session/title' && typeof data.title === 'string') {
      const source =
        data.source && typeof data.source === 'object' && 'kind' in data.source
          ? data.source.kind
          : undefined;
      await options.emit({
        sessionUpdate: 'session_info_update',
        title: data.title,
        _meta: {
          lody: {
            titleSource:
              source === 'provider' ? 'generated' : source === 'user' ? 'explicit' : 'fallback',
          },
        },
      });
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const user = event.type === 'user/message';
    // Synthetic injected context is not a human message in the ACP transcript.
    if (
      user &&
      data.source &&
      typeof data.source === 'object' &&
      'kind' in data.source &&
      data.source.kind !== 'user'
    )
      continue;
    const parsed = blocks.safeParse(
      user
        ? data.content
        : data.message && typeof data.message === 'object' && 'content' in data.message
          ? data.message.content
          : undefined
    );
    if (!parsed.success) throw new Error(`Invalid persisted message at event ${event.seq}`);
    for (const block of parsed.data) {
      const thought = block.type === 'reasoning' && typeof block.text === 'string';
      const content = thought
        ? { type: 'text' as const, text: block.text as string }
        : await options.content(block);
      if (!content) continue;
      const nativeTurn = typeof data.turn === 'number' ? data.turn : turn;
      await options.emit({
        sessionUpdate: user
          ? 'user_message_chunk'
          : thought
            ? 'agent_thought_chunk'
            : 'agent_message_chunk',
        content,
        ...(nativeTurn === undefined
          ? {}
          : { _meta: { lody: { turnId: nativeTurnId(nativeTurn) } } }),
      });
    }
  }
}

const selectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
});
/** A selection made during an older request remains pending until that route is used. */
export function restoredSelection(events: readonly ForkEvent[]) {
  type Selection = z.infer<typeof selectionSchema>;
  let pending: Selection | undefined;
  let last: Selection | undefined;
  for (const event of events) {
    if (event.type === 'model/selection') pending = selectionSchema.parse(event.data);
    if (event.type === 'request/header') {
      const header = z.object({ config: selectionSchema }).parse(event.data.header);
      last = header.config;
      if (
        pending &&
        pending.provider === last.provider &&
        pending.model === last.model &&
        pending.reasoningEffort === last.reasoningEffort
      )
        pending = undefined;
    }
  }
  return pending ?? last;
}
