import type * as acp from '@agentclientprotocol/sdk';
import { conversationJson } from './store';
import type { ConversationEvent, ConversationEventData, ConversationExtensions } from './types';

type MessageBase = { id: string; turnId?: string; sequence: number; extensions?: ConversationExtensions };
export type ConversationMessage = MessageBase & (
  | { kind: 'content'; role: 'user' | 'assistant' | 'system'; channel: 'message' | 'thought'; content: acp.ContentBlock[] }
  | { kind: 'tool_call'; role: 'tool'; toolCall: acp.ToolCallUpdate }
  | { kind: 'plan'; role: 'assistant'; plan: acp.Plan }
  | { kind: 'event'; role: 'system'; event: ConversationEventData }
);

/**
 * Lossless content/tool view of a complete turn's events. Read paged raw events for streaming
 * or exact deltas. Tool updates retain arbitrary JSON rawInput/rawOutput and merge by id;
 * null/omitted ACP update fields leave the previous value intact.
 */
export function projectConversationMessages(input: readonly ConversationEvent[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const tools = new Map<string, Extract<ConversationMessage, { kind: 'tool_call' }>>();
  const events = conversationJson([...input]).sort((a, b) => a.sequence - b.sequence);
  for (const event of events) {
    const base: MessageBase = { id: `${event.conversationId}:${event.sequence}`, turnId: event.turnId, sequence: event.sequence };
    const data = event.data;
    if (data.type === 'turn.queued') {
      messages.push({ ...base, kind: 'content', role: 'user', channel: 'message', content: data.turn.content, extensions: data.turn.extensions });
    } else if (data.type === 'message') {
      messages.push({ ...base, kind: 'content', channel: 'message', ...data.message });
    } else if (data.type === 'acp.update') {
      const update = data.notification.update;
      if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'user_message_chunk') {
        const channel = update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'message';
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
        const last = messages.at(-1);
        if (last?.kind === 'content' && last.role === role && last.channel === channel && last.turnId === event.turnId) last.content.push(update.content);
        else messages.push({ ...base, kind: 'content', role, channel, content: [update.content] });
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const key = JSON.stringify([event.turnId, update.toolCallId]);
        let tool = tools.get(key);
        if (!tool) {
          tool = { ...base, kind: 'tool_call', role: 'tool', toolCall: { toolCallId: update.toolCallId } };
          messages.push(tool); tools.set(key, tool);
        }
        const { sessionUpdate: _, ...fields } = update;
        tool.toolCall = { ...tool.toolCall, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined)) };
      } else if (update.sessionUpdate === 'plan') {
        const { sessionUpdate: _, ...plan } = update;
        messages.push({ ...base, kind: 'plan', role: 'assistant', plan });
      } else messages.push({ ...base, kind: 'event', role: 'system', event: data });
    } else if (data.type === 'custom' || data.type === 'session.event' || data.type === 'permission.requested' || data.type === 'permission.resolved') {
      messages.push({ ...base, kind: 'event', role: 'system', event: data });
    }
  }
  return messages;
}
