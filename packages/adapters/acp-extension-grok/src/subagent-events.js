import { randomUUID } from 'node:crypto';

import { LODY_SUBAGENT_EVENT_METHOD, isLodySubagentOutput } from 'acp-extension-core';

/** Native parent/child identities, scoped to this connection's admitted root sessions. */
export class GrokSubagentEvents {
  constructor() {
    this.children = new Map();
  }

  handle(message, roots) {
    const { sessionId, update } = message.params ?? {};
    const vendor = message.method === '_x.ai/session_notification';
    if (
      message.params?._meta?.isReplay === true &&
      (this.children.has(sessionId) ||
        (vendor &&
          ['subagent_spawned', 'subagent_progress', 'subagent_finished'].includes(
            update?.sessionUpdate,
          )))
    )
      return [];
    const output = [];
    const emit = (child, event) =>
      output.push({
        jsonrpc: '2.0',
        method: LODY_SUBAGENT_EVENT_METHOD,
        params: {
          version: 1,
          sessionId: child.root,
          runId: child.runId,
          ...event,
        },
      });
    if (vendor && update?.sessionUpdate === 'subagent_spawned') {
      const parentId = update.parent_session_id;
      const parent = this.children.get(parentId);
      if (sessionId !== parentId || (!roots.has(parentId) && !parent?.live)) return null;
      if (
        typeof update.child_session_id !== 'string' ||
        !update.child_session_id ||
        update.child_session_id === parentId ||
        roots.has(update.child_session_id)
      )
        return null;
      const previous = this.children.get(update.child_session_id);
      if (previous && previous.root !== (parent?.root ?? parentId)) return [];
      if (previous?.live && previous.attempt === update.attempt_id) return [];
      if (previous?.live) {
        previous.live = false;
        emit(previous, {
          type: 'snapshot',
          snapshot: {
            ...previous.snapshot,
            state: 'unknown',
            outputIncomplete: true,
            reason: { code: 'lost' },
          },
        });
      }
      const child = {
        root: parent?.root ?? parentId,
        runId: randomUUID(),
        parentId,
        attempt: update.attempt_id,
        live: true,
        tools: new Map(),
        mirrors: new Set(),
        snapshot: {
          state: 'running',
          parentRunId: parent?.runId ?? null,
          ...(typeof update.subagent_type === 'string' ? { name: update.subagent_type } : {}),
          ...(typeof update.description === 'string' ? { description: update.description } : {}),
          ...(typeof update.model === 'string' ? { modelId: update.model } : {}),
          support: {
            stream: ['text', 'thought', 'tool', 'plan'],
            progress: true,
            outputRead: 'none',
            cancel: false,
          },
        },
      };
      this.children.set(update.child_session_id, child);
      emit(child, { type: 'snapshot', snapshot: child.snapshot });
      return output;
    }
    if (vendor && ['subagent_progress', 'subagent_finished'].includes(update?.sessionUpdate)) {
      const child = this.children.get(update.child_session_id);
      if (!child || child.parentId !== sessionId) return null;
      if (!child.live || (child.attempt !== undefined && child.attempt !== update.attempt_id))
        return [];
      const progress = {};
      for (const [native, normalized] of Object.entries({
        duration_ms: 'durationMs',
        turn_count: 'turnCount',
        turns: 'turnCount',
        tool_call_count: 'toolCallCount',
        tool_calls: 'toolCallCount',
        tokens_used: 'contextTokens',
        context_window_tokens: 'contextWindowTokens',
        context_usage_pct: 'contextUsagePercent',
        error_count: 'errorCount',
      })) {
        if (
          typeof update[native] === 'number' &&
          Number.isFinite(update[native]) &&
          update[native] >= 0
        )
          progress[normalized] = update[native];
      }
      if (
        Array.isArray(update.tools_used) &&
        update.tools_used.every((item) => typeof item === 'string')
      )
        progress.toolsUsed = update.tools_used;
      emit(child, { type: 'progress', progress });
      if (update.sessionUpdate === 'subagent_finished') {
        child.live = false;
        const state = ['completed', 'failed', 'cancelled'].includes(update.status)
          ? update.status
          : 'unknown';
        child.snapshot = {
          ...child.snapshot,
          state,
          ...(typeof update.output === 'string' ? { summary: update.output } : {}),
          ...(typeof update.error === 'string'
            ? {
                reason: {
                  code: update.status === 'cancelled' ? 'cancelled' : 'error',
                  message: update.error,
                },
              }
            : {}),
          ...(state === 'unknown' ? { outputIncomplete: true } : {}),
        };
        emit(child, { type: 'snapshot', snapshot: child.snapshot });
      }
      return output;
    }
    const child = this.children.get(sessionId);
    if (!child) return null;
    if (message.method === 'session/request_permission') {
      if (!child.live || typeof message.params?.toolCall?.toolCallId !== 'string') return null;
      const id = message.params.toolCall.toolCallId;
      child.mirrors.add(id);
      return [
        {
          ...message,
          params: {
            ...message.params,
            sessionId: child.root,
            toolCall: { ...message.params.toolCall, toolCallId: this.toolId(child, id) },
            _meta: {
              ...message.params._meta,
              lody: { subagentRunId: child.runId, subagentToolCallId: id },
            },
          },
        },
      ];
    }
    if (!child.live) return message.id === undefined ? [] : null;
    if (vendor && update?.sessionUpdate === 'response_started') {
      child.messageId = typeof update.message_id === 'string' ? update.message_id : undefined;
      child.tools.clear();
      return [];
    }
    if (vendor && update?.sessionUpdate === 'tool_call_delta_chunk') {
      const id = update.tool_call_id;
      if (typeof id !== 'string') {
        child.snapshot = { ...child.snapshot, outputIncomplete: true };
        emit(child, { type: 'snapshot', snapshot: child.snapshot });
        return output;
      }
      const previous = child.tools.get(id);
      const tool = {
        name: update.name ?? previous?.name ?? 'Tool',
        args: (previous?.args ?? '') + (update.arguments_delta ?? ''),
      };
      child.tools.set(id, tool);
      emit(child, {
        type: 'output',
        update: {
          sessionUpdate: previous ? 'tool_call_update' : 'tool_call',
          toolCallId: id,
          title: tool.name,
          status: 'in_progress',
          rawInput: tool.args,
        },
        ...(child.messageId ? { messageId: child.messageId } : {}),
      });
      return output;
    }
    if (message.method !== 'session/update') return vendor ? [] : null;
    if (isLodySubagentOutput(update)) {
      let normalized = update;
      if (update.sessionUpdate === 'tool_call' && child.tools.has(update.toolCallId))
        normalized = { ...update, sessionUpdate: 'tool_call_update' };
      emit(child, {
        type: 'output',
        update: normalized,
        ...(child.messageId ? { messageId: child.messageId } : {}),
      });
      if (child.mirrors.has(update.toolCallId))
        output.push({
          ...message,
          params: {
            sessionId: child.root,
            update: {
              ...update,
              toolCallId: this.toolId(child, update.toolCallId),
              _meta: {
                ...update._meta,
                lody: { subagentRunId: child.runId, subagentToolCallId: update.toolCallId },
              },
            },
          },
        });
    } else if (['agent_message_chunk', 'agent_thought_chunk'].includes(update?.sessionUpdate)) {
      child.snapshot = { ...child.snapshot, outputIncomplete: true };
      emit(child, { type: 'snapshot', snapshot: child.snapshot });
    }
    return output;
  }

  toolId(child, id) {
    return `subagent:${encodeURIComponent(child.runId)}:${encodeURIComponent(id)}`;
  }
}
