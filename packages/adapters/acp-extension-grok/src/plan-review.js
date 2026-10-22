function update(sessionId, value) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } };
}

/** Translate the native reverse request; approval remains a user decision even under YOLO. */
export class GrokPlanReviewBridge {
  constructor() {
    this.pending = new Map();
  }

  start(message, sessions, capabilities) {
    const wrapped = message.params?.method === 'x.ai/exit_plan_mode';
    const params = wrapped ? message.params.params : message.params;
    const { sessionId, toolCallId, planContent } = params ?? {};
    if (message.id === undefined) return { toRuntime: [], toClient: [] };
    if (
      !sessions.has(sessionId) ||
      typeof toolCallId !== 'string' ||
      !toolCallId ||
      (planContent != null && typeof planContent !== 'string')
    ) {
      return {
        toRuntime: [
          {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: 'Invalid plan approval request' },
          },
        ],
        toClient: [],
      };
    }
    const plan = planContent ?? '';
    const review = {
      id: message.id,
      sessionId,
      toolCallId,
      wrapped,
      feedbackSupported: Boolean(capabilities.elicitation?.form),
      phase: 'approval',
    };
    this.pending.set(message.id, review);
    const separatePlan = capabilities.plan != null;
    const toolCall = {
      toolCallId,
      title: 'Implement this plan?',
      kind: 'switch_mode',
      status: 'pending',
      rawInput: { plan },
      content: separatePlan && plan.trim()
        ? []
        : [
            {
              type: 'content',
              content: {
                type: 'text',
                text: plan.trim() ? plan : 'No plan written yet.',
              },
            },
          ],
    };
    const toClient = [];
    if (separatePlan)
      toClient.push(
        update(sessionId, {
          sessionUpdate: 'plan_update',
          plan: { type: 'markdown', planId: toolCallId, content: plan },
        })
      );
    toClient.push(update(sessionId, { sessionUpdate: 'tool_call', ...toolCall }));
    toClient.push({
      jsonrpc: '2.0',
      id: message.id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: 'approve', name: 'Implement this plan', kind: 'allow_once' },
          { optionId: 'revise', name: 'Keep planning', kind: 'reject_once' },
          { optionId: 'abandon', name: 'Exit without implementing this plan', kind: 'reject_once' },
        ],
      },
    });
    return { toRuntime: [], toClient };
  }

  response(message) {
    if (typeof message.method === 'string') return undefined;
    const review = this.pending.get(message.id);
    if (!review) return undefined;
    if (review.phase === 'feedback') {
      const feedback =
        !message.error && message.result?.action === 'accept' && typeof message.result.content?.feedback === 'string'
          ? message.result.content.feedback
          : undefined;
      return this.finish(review, 'cancelled', feedback);
    }
    const selected =
      message.result?.outcome?.outcome === 'selected' ? message.result.outcome.optionId : undefined;
    if (!message.error && selected === 'approve') return this.finish(review, 'approved');
    if (!message.error && selected === 'abandon') return this.finish(review, 'abandoned');
    if (!message.error && selected === 'revise' && review.feedbackSupported) {
      review.phase = 'feedback';
      return {
        toRuntime: [],
        toClient: [
          {
            jsonrpc: '2.0',
            id: review.id,
            method: 'elicitation/create',
            params: {
              sessionId: review.sessionId,
              toolCallId: `${review.toolCallId}:feedback`,
              mode: 'form',
              message: 'What should change in the plan?',
              requestedSchema: {
                type: 'object',
                properties: { feedback: { type: 'string', title: 'Feedback' } },
              },
              _meta: { lody: { elicitation: { version: 1 } } },
            },
          },
        ],
      };
    }
    return this.finish(review, 'cancelled');
  }

  finish(review, outcome, feedback) {
    this.pending.delete(review.id);
    const result = { outcome, ...(feedback ? { feedback } : {}) };
    const toClient = [
      update(review.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: review.toolCallId,
        status: 'completed',
        rawOutput: result,
      }),
    ];
    if (review.phase === 'feedback')
      toClient.push(
        update(review.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: `${review.toolCallId}:feedback`,
          status: 'completed',
        })
      );
    return {
      toRuntime: [{ jsonrpc: '2.0', id: review.id, result: review.wrapped ? { result } : result }],
      toClient,
    };
  }

  cancel(sessionId) {
    const output = { toRuntime: [], toClient: [] };
    for (const review of [...this.pending.values()]) {
      if (review.sessionId !== sessionId) continue;
      const result = this.finish(review, 'cancelled');
      output.toRuntime.push(...result.toRuntime);
      output.toClient.push(...result.toClient);
    }
    return output;
  }
}
