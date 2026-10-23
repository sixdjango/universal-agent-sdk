import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, DeterministicClock, SequentialIdGenerator } from '@universal-agent/workflow-runtime';
import { describe, expect, it } from 'vitest';
import { buildChiefThread } from '../src/model/chief-thread';

describe('chief thread', () => {
  it('interleaves messages, replies and the chief’s own interventions, skipping silent reviews', async () => {
    let failOnce = true;
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      chief: {
        async review(input) {
          if (input.trigger.kind === 'node.failed') {
            return { rationale: 'Draft crashed once; retrying', commands: [{ kind: 'retry_node', scopeKey: '$root', nodeId: 'draft' }] };
          }
          if (input.trigger.kind === 'user.message') {
            return {
              rationale: 'asked',
              reply: 'All done.',
              commands: [{ kind: 'swap_agent', nodeId: 'draft', agentRef: 'nobody' }],
            };
          }
          return { rationale: 'nothing to do', commands: [] };
        },
      },
      executor: {
        async executeAgent() {
          if (failOnce) {
            failOnce = false;
            throw new Error('boom');
          }
          return { status: 'COMPLETED' };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const definition = createWorkflowBuilder('t').addAgent({ id: 'draft', name: 'Draft', role: 'author', goal: 'x' }).setChief({ maxLevel: 'advise' }).buildDefinition();
    // `advise` cannot retry: the intervention shows up with its rejected command.
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    const { messageId } = await runtime.postChiefMessage({ runId: done.runId, text: 'how did it go?', authorId: 'me' });

    const name = (id: string) => (id === 'draft' ? 'Draft' : id);
    const pending = buildChiefThread((await runtime.store.getRun(done.runId))!, name);
    expect(pending.waitingForChief).toBe(true);

    const answered = await runtime.answerChiefMessage({ runId: done.runId, messageId });
    const thread = buildChiefThread(answered, name);
    expect(thread.waitingForChief).toBe(false);
    expect(thread.items.map((i) => i.kind)).toEqual(['chief', 'user', 'chief']);
    expect(thread.items[0]).toMatchObject({
      trigger: 'node.failed',
      nodeName: 'Draft',
      text: 'Draft crashed once; retrying',
      applied: [],
      rejected: [expect.stringContaining('Retried Draft — not allowed')],
    });
    expect(thread.items[1]).toMatchObject({ text: 'how did it go?', answered: true });
    expect(thread.items[2]).toMatchObject({ trigger: 'user.message', text: 'All done.' });
    expect(thread.chiefEntryCount).toBe(2);
  });
});
