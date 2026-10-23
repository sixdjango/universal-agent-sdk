import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  type ChiefReviewInput,
  ChiefUnavailableError,
  createWorkflowRuntime,
  DeterministicClock,
  SequentialIdGenerator,
} from '../src/index';

function setup(maxLevel: 'advise' | 'operate', withChief = true) {
  const seen: ChiefReviewInput[] = [];
  const builder = createWorkflowBuilder('chat')
    .addAgent({ id: 'draft', name: 'Draft', role: 'author', goal: 'Write' })
    .addAgent({ id: 'polish', name: 'Polish', role: 'author', goal: 'Polish' })
    .connectControl('draft', 'polish');
  if (withChief) builder.setChief({ maxLevel });
  const runtime = createWorkflowRuntime({
    clock: new DeterministicClock(),
    idGenerator: new SequentialIdGenerator(),
    chief: {
      async review(input) {
        seen.push(input);
        if (input.trigger.kind !== 'user.message') return { rationale: '', commands: [] };
        if (input.trigger.detail.includes('status')) {
          return { rationale: 'asked for status', reply: `Run is ${input.state.status}.`, commands: [] };
        }
        return {
          rationale: 'asked to redo polish with guidance',
          reply: 'Re-running polish with your note.',
          commands: [
            { kind: 'inject_guidance', nodeId: 'polish', text: 'Use British spelling' },
            { kind: 'rerun_from_node', scopeKey: '$root', nodeId: 'polish' },
          ],
        };
      },
    },
    executor: {
      async executeAgent() {
        return { status: 'COMPLETED' };
      },
      async executeScript() {
        throw new Error('unused');
      },
    },
  });
  return { runtime, seen, definition: builder.buildDefinition() };
}

describe('talking to the chief', () => {
  it('records the message, answers it, and does not spend the intervention budget on talk', async () => {
    const { runtime, seen, definition } = setup('operate');
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const { messageId, state } = await runtime.postChiefMessage({ runId: done.runId, text: 'status?', authorId: 'me' });
    expect(state.events.at(-1)).toMatchObject({ type: 'chief.user_message', messageId, text: 'status?', authorId: 'me' });

    const answered = await runtime.answerChiefMessage({ runId: done.runId, messageId });
    expect(seen.at(-1)!.trigger).toMatchObject({ kind: 'user.message', messageId, detail: 'status?' });
    expect(answered.events.at(-1)).toMatchObject({
      type: 'chief.intervened',
      trigger: 'user.message',
      inReplyTo: messageId,
      reply: 'Run is SUCCEEDED.',
      applied: [],
    });
    expect(answered.chief.interventionCount).toBe(0);
    expect(answered.status).toBe('SUCCEEDED');
  });

  it('applies commands the policy allows, and sets a finished run going again when asked', async () => {
    const { runtime, definition } = setup('operate');
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const { messageId } = await runtime.postChiefMessage({ runId: done.runId, text: 'redo polish in British English', authorId: 'me' });
    const answered = await runtime.answerChiefMessage({ runId: done.runId, messageId });
    const event = answered.events.at(-1)!;
    expect(event.type === 'chief.intervened' && event.applied.map((c) => c.kind)).toEqual(['inject_guidance', 'rerun_from_node']);
    expect(answered.status).toBe('RUNNING');
    expect(answered.chief.interventionCount).toBe(1);
    expect(answered.chief.guidance.map((g) => g.text)).toEqual(['Use British spelling']);
    expect((await runtime.resume(done.runId)).status).toBe('SUCCEEDED');
  });

  it('rejects commands above the policy level but still replies', async () => {
    const { runtime, definition } = setup('advise');
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const { messageId } = await runtime.postChiefMessage({ runId: done.runId, text: 'redo polish', authorId: 'me' });
    const answered = await runtime.answerChiefMessage({ runId: done.runId, messageId });
    const event = answered.events.at(-1)!;
    expect(event.type === 'chief.intervened' && event.applied.map((c) => c.kind)).toEqual(['inject_guidance']);
    expect(event.type === 'chief.intervened' && event.rejected.map((r) => r.command.kind)).toEqual(['rerun_from_node']);
    expect(answered.status).toBe('SUCCEEDED');
  });

  it('refuses messages to runs without a chief', async () => {
    const { runtime, definition } = setup('operate', false);
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    await expect(runtime.postChiefMessage({ runId: done.runId, text: 'hi', authorId: 'me' })).rejects.toBeInstanceOf(ChiefUnavailableError);
  });
});
