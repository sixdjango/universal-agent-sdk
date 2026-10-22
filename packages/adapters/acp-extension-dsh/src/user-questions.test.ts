import {
  AgentSideConnection,
  ClientSideConnection,
  type AnyMessage,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { UserQuestionBridge, type HarnessQuestion } from './user-questions.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const question: HarnessQuestion = {
  id: 'original-id',
  question: 'Choose?',
  options: [{ label: 'A', description: 'First choice' }, { label: 'B' }],
};
const accepted: CreateElicitationResponse = {
  action: 'accept',
  content: { question_0: 'A' },
};

function fixture(
  respond: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>,
  answerNotes = true
) {
  const requests: CreateElicitationRequest[] = [];
  const bridge = new UserQuestionBridge(
    'session',
    (request) => {
      requests.push(request);
      return respond(request);
    },
    () => ({ form: true, answerNotes })
  );
  return { bridge, requests };
}

describe('Harness user questions over ACP', () => {
  it('round trips multi-question, multi-select and custom answers over the SDK transport', async () => {
    let endAgent!: () => void;
    let endClient!: () => void;
    const toAgent = new TransformStream<AnyMessage, AnyMessage>({
      start: (controller) => {
        endAgent = () => controller.terminate();
      },
    });
    const toClient = new TransformStream<AnyMessage, AnyMessage>({
      start: (controller) => {
        endClient = () => controller.terminate();
      },
    });
    const agent = new AgentSideConnection(() => ({}) as never, {
      readable: toAgent.readable,
      writable: toClient.writable,
    });
    const requests: CreateElicitationRequest[] = [];
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        unstable_createElicitation: async (request) => {
          requests.push(request);
          return {
            action: 'accept',
            content: {
              question_0: 'A',
              question_1: ['A', 'B'],
              custom_1: 'Also C',
              question_2: 'Free text',
            },
          };
        },
      }),
      { readable: toClient.readable, writable: toAgent.writable }
    );
    const bridge = new UserQuestionBridge(
      'session',
      (request) => agent.unstable_createElicitation(request),
      () => ({ form: true, answerNotes: true })
    );
    try {
      await expect(
        bridge.ask({
          questions: [
            question,
            { ...question, id: 'multi', multiSelect: true },
            { id: '__proto__', question: 'Explain' },
          ],
        })
      ).resolves.toEqual({
        answers: [
          { id: 'original-id', selected: ['A'] },
          { id: 'multi', selected: ['A', 'B'], custom: 'Also C' },
          { id: '__proto__', selected: [], custom: 'Free text' },
        ],
      });
      expect(requests[0]).toMatchObject({
        sessionId: 'session',
        mode: 'form',
        requestedSchema: {
          properties: {
            question_0: {
              oneOf: [
                { const: 'A', title: 'A', description: 'First choice' },
                { const: 'B', title: 'B' },
              ],
            },
            custom_0: {
              _meta: {
                lody: {
                  elicitation: { version: 1, customAnswerFor: 'question_0' },
                },
              },
            },
            custom_1: {
              _meta: {
                lody: { elicitation: { version: 1, noteFor: 'question_1' } },
              },
            },
          },
        },
      });
    } finally {
      endAgent();
      endClient();
      await Promise.all([client.closed, agent.closed]);
    }
  });

  it('retains plan detail and returns the explicit approval label without changing plan state', async () => {
    const { bridge, requests } = fixture(async () => accepted);
    await expect(
      bridge.ask({
        questions: [
          {
            ...question,
            detail: '# Proposed plan\nDo the work',
            intent: { kind: 'plan-review', approve: 'B' },
          },
        ],
      })
    ).resolves.toEqual({ answers: [{ id: question.id, selected: ['A'] }] });
    expect(requests[0]?.message).toBe('Choose?\n\n# Proposed plan\nDo the work');
  });

  it.each([false, true])(
    'supports replacement Other without notes support=%s',
    async (answerNotes) => {
      const { bridge } = fixture(
        async () => ({
          action: 'accept',
          content: { custom_0: 'Typed answer' },
        }),
        answerNotes
      );
      await expect(bridge.ask({ questions: [question] })).resolves.toEqual({
        answers: [{ id: question.id, selected: [], custom: 'Typed answer' }],
      });
    }
  );

  it('keeps a real Other option distinct from the custom-only sentinel', async () => {
    const { bridge } = fixture(async () => ({
      action: 'accept',
      content: { question_0: ['Other', 'Other (custom)'], custom_0: 'C' },
    }));
    await expect(
      bridge.ask({
        questions: [{ ...question, multiSelect: true, options: [{ label: 'Other' }] }],
      })
    ).resolves.toEqual({
      answers: [{ id: question.id, selected: ['Other'], custom: 'C' }],
    });
  });

  it.each([
    ['decline', 'ASK_DECLINED'],
    ['cancel', 'ASK_ABORTED'],
  ] as const)('reports %s as a tool failure', async (action, code) => {
    const { bridge } = fixture(async () => ({ action }));
    await expect(bridge.ask({ questions: [question] })).rejects.toMatchObject({
      name: 'UserQuestionError',
      code,
    });
  });

  it.each([
    {},
    { question_0: 'forged' },
    { question_0: ['A'] },
    { question_0: 'A', custom_0: 'C' },
    { custom_0: 12 },
  ])('rejects malformed accepted answers %j', async (content) => {
    const { bridge } = fixture(
      async () => ({ action: 'accept', content }) as CreateElicitationResponse
    );
    await expect(bridge.ask({ questions: [question] })).rejects.toMatchObject({
      code: 'INVALID_ANSWER',
    });
  });

  it('releases the queue after a transport failure', async () => {
    let first = true;
    const { bridge } = fixture(async () => {
      if (first) {
        first = false;
        throw new Error('disconnected');
      }
      return accepted;
    });
    const failed = bridge.ask({ questions: [question] });
    const next = bridge.ask({ questions: [question] });
    await expect(failed).rejects.toMatchObject({ code: 'ANSWER_FAILED' });
    await expect(next).resolves.toEqual({
      answers: [{ id: question.id, selected: ['A'] }],
    });
  });

  it('queues requests, skips a cancelled waiter and ignores an aborted request’s late response', async () => {
    const sent = deferred<void>();
    const firstReply = deferred<CreateElicitationResponse>();
    const { bridge, requests } = fixture(async () => {
      if (requests.length === 1) {
        sent.resolve();
        return firstReply.promise;
      }
      return accepted;
    });
    const firstSignal = new AbortController();
    const queuedSignal = new AbortController();
    const first = bridge.ask({
      questions: [question],
      signal: firstSignal.signal,
    });
    const queued = bridge.ask({
      questions: [question],
      signal: queuedSignal.signal,
    });
    const third = bridge.ask({ questions: [question] });
    await sent.promise;
    expect(requests).toHaveLength(1);
    queuedSignal.abort();
    await expect(queued).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    // The third request must still wait for the first request's queue slot.
    expect(requests).toHaveLength(1);
    firstSignal.abort();
    await expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    await expect(third).resolves.toEqual({
      answers: [{ id: question.id, selected: ['A'] }],
    });
    firstReply.resolve({ action: 'accept', content: { question_0: 'B' } });
    expect(requests).toHaveLength(2);
  });

  it('cancels active and queued requests and permits the next turn to ask', async () => {
    const sent = deferred<void>();
    const pending = deferred<CreateElicitationResponse>();
    const { bridge, requests } = fixture(async () => {
      sent.resolve();
      return requests.length === 1 ? pending.promise : accepted;
    });
    const first = bridge.ask({ questions: [question] });
    const second = bridge.ask({ questions: [question] });
    await sent.promise;
    bridge.cancel();
    await expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    await expect(second).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    await expect(bridge.ask({ questions: [question] })).resolves.toMatchObject({
      answers: [{ selected: ['A'] }],
    });
    pending.resolve(accepted);
  });

  it('fails unsupported clients and invalid requests before dispatch', async () => {
    const bridge = new UserQuestionBridge(
      'session',
      async () => {
        throw new Error('must not send');
      },
      () => ({ form: false, answerNotes: false })
    );
    await expect(bridge.ask({ questions: [question] })).rejects.toMatchObject({
      code: 'NO_PROVIDER',
    });
    const { bridge: supported, requests } = fixture(async () => accepted);
    for (const questions of [
      [],
      [question, question],
      [{ ...question, intent: { kind: 'plan-review' as const, approve: 'A' } }],
    ]) {
      await expect(supported.ask({ questions })).rejects.toMatchObject({
        name: 'UserQuestionError',
      });
    }
    expect(requests).toEqual([]);
  });
});
