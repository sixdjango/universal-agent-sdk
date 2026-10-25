import { ConversationService, startAgentSession, type ManagedAgentSession, type StartAgentSessionOptions } from '@universal-agent/client';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  createWorkflowRuntime,
  InMemoryArtifactStore,
  type WorkflowRunState,
} from '@universal-agent/workflow-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UniversalAgentExecutor } from '../src/executors/universal-agent-executor';
import { listWorkflowConversations } from '../src/host/conversations';

vi.mock('@universal-agent/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@universal-agent/client')>(),
  startAgentSession: vi.fn(),
}));

type PromptResponse = Awaited<ReturnType<ManagedAgentSession['prompt']>>;

const completedEnvelope = {
  outputs: { message: 'Done' },
  artifacts: { candidate: { content: 'Candidate artifact' } },
  assessment: { verdict: 'PASS', summary: 'Checks passed' },
};
const waitEnvelope = { waitRequest: { prompt: 'Approve the candidate?' } };

/** Exercise the real Executor and graph runtime, mocking only the ACP session boundary. */
async function setup(text: string, maxTechnicalRetries = 0, onRequestPermission?: StartAgentSessionOptions['onRequestPermission']) {
  const session = {
    sessionId: 'session-1',
    acpSessionId: 'acp-1',
    prompt: vi.fn<ManagedAgentSession['prompt']>().mockResolvedValue({ stopReason: 'end_turn' }),
    getLatestAssistantItems: vi.fn<ManagedAgentSession['getLatestAssistantItems']>()
      .mockReturnValue([{ type: 'text', text }]),
    getHistory: vi.fn<ManagedAgentSession['getHistory']>().mockReturnValue([]),
    shutdown: vi.fn<ManagedAgentSession['shutdown']>().mockResolvedValue(undefined),
  };
  vi.mocked(startAgentSession).mockResolvedValue(session as unknown as ManagedAgentSession);

  const artifacts = new InMemoryArtifactStore();
  const publishArtifact = vi.spyOn(artifacts, 'put');
  const executor = new UniversalAgentExecutor({
    workdir: process.cwd(),
    artifactTools: false,
    captureChanges: false,
    onRequestPermission,
  });
  const executeAgent = vi.spyOn(executor, 'executeAgent');
  const runtime = createWorkflowRuntime({ executor, artifacts });
  const definition = createWorkflowBuilder('executor-terminal-state')
    .addAgent({
      id: 'worker', name: 'Worker', role: 'worker', goal: 'Produce a candidate',
      maxTechnicalRetries,
      outputs: [{ name: 'candidate', type: 'artifact', required: true }],
    })
    .addAgent({
      id: 'consumer', name: 'Consumer', role: 'worker', goal: 'Use the candidate',
      inputs: [{ name: 'candidate', type: 'artifact', required: true }],
    })
    .connectData({
      fromNodeId: 'worker', fromPort: 'candidate', toNodeId: 'consumer', toPort: 'candidate',
      withControl: true,
    })
    .buildDefinition();
  const { runId } = await runtime.start({ definition });

  function expectNoPublication(state: WorkflowRunState) {
    expect(state.status).not.toBe('SUCCEEDED');
    expect(state.scopes.$root!.nodes.worker!.status).not.toBe('SUCCEEDED');
    expect(Object.values(state.assessments)).toHaveLength(0);
    expect(Object.values(state.waitRequests)).toHaveLength(0);
    expect(publishArtifact).not.toHaveBeenCalled();
    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(executeAgent.mock.calls[0]![0].node.id).toBe('worker');
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  }

  const conversations = new ConversationService({ store: executor.conversationStore });
  const recordings = (nodeId = 'worker') => listWorkflowConversations(executor.conversationStore, { runId, nodeId });
  const workerTurn = async () => (await conversations.store.listTurns((await recordings())[0].id)).items[0];
  return { session, runtime, runId, publishArtifact, expectNoPublication, conversations, recordings, workerTurn };
}

describe('UniversalAgentExecutor terminal state', () => {
  beforeEach(() => {
    vi.mocked(startAgentSession).mockReset();
  });

  it.each([
    { name: 'plain text', text: 'Completed candidate', content: 'Completed candidate' },
    { name: 'structured output', text: JSON.stringify(completedEnvelope), content: 'Candidate artifact' },
  ])('preserves successful $name and downstream graph execution after end_turn', async ({ text, content }) => {
    const { runtime, runId, session, publishArtifact } = await setup(text);
    const done = await runtime.runUntilSettled(runId);

    expect(done.status, done.scopes.$root!.nodes.worker!.error).toBe('SUCCEEDED');
    expect(done.scopes.$root!.nodes.worker!.status).toBe('SUCCEEDED');
    expect(done.scopes.$root!.nodes.consumer!.status).toBe('SUCCEEDED');
    expect(publishArtifact.mock.calls[0]![0].content).toBe(content);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.shutdown).toHaveBeenCalledTimes(2);
    if (text === JSON.stringify(completedEnvelope)) {
      expect(Object.values(done.assessments).some((assessment) => assessment.verdict === 'PASS')).toBe(true);
    }
  });

  it('preserves a completed turn requesting human input', async () => {
    const { runtime, runId, session, publishArtifact } = await setup(JSON.stringify(waitEnvelope));
    const done = await runtime.runUntilSettled(runId);

    expect(done.status, done.scopes.$root!.nodes.worker!.error).toBe('WAITING');
    expect(Object.values(done.waitRequests)).toEqual([
      expect.objectContaining({ prompt: 'Approve the candidate?', status: 'PENDING' }),
    ]);
    expect(publishArtifact).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'token limit', response: { stopReason: 'max_tokens' }, text: JSON.stringify(completedEnvelope), error: 'max_tokens' },
    { name: 'truncated JSON', response: { stopReason: 'max_tokens' }, text: '{"outputs":{"message":"partial', error: 'max_tokens' },
    { name: 'turn limit', response: { stopReason: 'max_turn_requests' }, text: JSON.stringify(completedEnvelope), error: 'max_turn_requests' },
    { name: 'refusal', response: { stopReason: 'refusal' }, text: 'I cannot complete this task', error: 'refusal' },
    { name: 'missing response', response: undefined, text: JSON.stringify(completedEnvelope), error: 'without a prompt response' },
    { name: 'missing stop reason', response: {}, text: JSON.stringify(completedEnvelope), error: 'stopReason' },
    { name: 'unknown stop reason', response: { stopReason: 'future_reason' }, text: JSON.stringify(completedEnvelope), error: 'future_reason' },
    { name: 'interrupted wait request', response: { stopReason: 'max_tokens' }, text: JSON.stringify(waitEnvelope), error: 'max_tokens' },
  ])('rejects $name without publishing partial output or advancing the graph', async ({ response, text, error }) => {
    const { runtime, runId, session, expectNoPublication, workerTurn } = await setup(text);
    // Include malformed/future responses to ensure only an explicit end_turn can succeed.
    session.prompt.mockResolvedValue(response as PromptResponse);
    const done = await runtime.runUntilSettled(runId);

    expect(done.status).toBe('FAILED');
    expect(done.scopes.$root!.nodes.worker!.error).toContain(error);
    expect(Object.values(done.attempts)).toEqual([
      expect.objectContaining({ status: 'FAILED', producedArtifactIds: [] }),
    ]);
    expectNoPublication(done);
    expect(await workerTurn()).toMatchObject({ status: error === 'max_tokens' || error === 'max_turn_requests' ? 'truncated' : error === 'refusal' ? 'refused' : 'failed' });
  });

  it.each([
    { name: 'completed-looking output', text: JSON.stringify(completedEnvelope) },
    { name: 'wait request', text: JSON.stringify(waitEnvelope) },
  ])('propagates cancelled with $name as an abort without retrying', async ({ text }) => {
    const { runtime, runId, session, expectNoPublication, workerTurn } = await setup(text, 2);
    session.prompt.mockResolvedValue({ stopReason: 'cancelled' });

    await expect(runtime.runUntilSettled(runId)).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expectNoPublication((await runtime.store.getRun(runId))!);
    expect((await workerTurn()).status).toBe('cancelled');
  });

  it('forwards cancellation to the active prompt and rejects an end_turn racing with abort', async () => {
    const { runtime, runId, session, expectNoPublication } = await setup(JSON.stringify(completedEnvelope), 2);
    const controller = new AbortController();
    session.prompt.mockImplementation(async (_blocks, options) => {
      expect(options?.signal?.aborted).toBe(false);
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      return { stopReason: 'end_turn' };
    });

    await expect(runtime.runUntilSettled(runId, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expectNoPublication((await runtime.store.getRun(runId))!);
  });

  it('fails when the connection closes after partial output and still shuts down the session', async () => {
    const { runtime, runId, session, expectNoPublication, workerTurn } = await setup(JSON.stringify(completedEnvelope));
    session.prompt.mockRejectedValue(new Error('ACP connection closed before the turn completed'));
    const done = await runtime.runUntilSettled(runId);

    expect(done.status).toBe('FAILED');
    expect(done.scopes.$root!.nodes.worker!.error).toBe('ACP connection closed before the turn completed');
    expectNoPublication(done);
    expect(await workerTurn()).toMatchObject({ status: 'failed', error: 'ACP connection closed before the turn completed' });
  });

  it('does not publish a completed result if cancellation arrives during session shutdown', async () => {
    const { runtime, runId, session, expectNoPublication, workerTurn } = await setup(JSON.stringify(completedEnvelope), 2);
    const controller = new AbortController();
    session.shutdown.mockImplementationOnce(async () => { controller.abort(); });

    await expect(runtime.runUntilSettled(runId, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expectNoPublication((await runtime.store.getRun(runId))!);
    expect((await workerTurn()).status).toBe('cancelled');
  });

  it('records native messages, thoughts, tools and permission decisions while preserving graph output', async () => {
    const { runtime, runId, session, conversations, recordings, workerTurn } = await setup('Done');
    session.prompt.mockImplementation(async () => {
      const options = vi.mocked(startAgentSession).mock.calls.at(-1)![0];
      options.onUpdateMessage!({ sessionId: 'acp-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } } });
      options.onUpdateMessage!({ sessionId: 'acp-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Edit', kind: 'edit', status: 'pending', rawInput: ['file', 1, true] } });
      const answer = await options.onRequestPermission('rpc', {
        sessionId: 'acp-1', toolCall: { toolCallId: 'tool', kind: 'edit' },
        options: [{ kind: 'reject_once', optionId: 'no', name: 'Reject' }, { kind: 'allow_once', optionId: 'yes', name: 'Allow' }],
      });
      expect(answer.outcome).toEqual({ outcome: 'selected', optionId: 'no' });
      options.onUpdateMessage!({ sessionId: 'acp-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'failed', rawOutput: { denied: true } } });
      options.onUpdateMessage!({ sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'YQ==', mimeType: 'image/png', _meta: { 'host.extra': 1 } } } });
      return { stopReason: 'end_turn' };
    });
    const done = await runtime.runUntilSettled(runId);
    expect(done.status).toBe('SUCCEEDED');
    const [record] = await recordings();
    const turn = await workerTurn();
    expect(record).toMatchObject({ mode: 'recording', status: 'closed', nativeSessionId: 'acp-1', source: { namespace: 'workflow', identifiers: { runId, nodeId: 'worker', scopeKey: '$root', retryIndex: '0' } } });
    expect(turn.permissions).toEqual([expect.objectContaining({ requestId: 'rpc', status: 'answered', response: { outcome: { outcome: 'selected', optionId: 'no' } } })]);
    const messages = await conversations.getMessages(record.id, turn.id);
    expect(messages).toContainEqual(expect.objectContaining({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('Produce a candidate') }] }));
    expect(messages).toContainEqual(expect.objectContaining({ channel: 'thought', content: [{ type: 'text', text: 'Thinking' }] }));
    expect(messages).toContainEqual(expect.objectContaining({ kind: 'tool_call', toolCall: expect.objectContaining({ toolCallId: 'tool', rawInput: ['file', 1, true], rawOutput: { denied: true }, status: 'failed' }) }));
    expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png', _meta: { 'host.extra': 1 } }] }));
    expect(Object.values(done.attempts).find(a => a.nodeId === 'worker')?.receipt).toMatchObject({ conversationId: record.id, conversationTurnId: turn.id });
    await expect(conversations.send(record.id, { content: [{ type: 'text', text: 'take over' }] })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps each technical retry separately, including partial tool output and failure before success', async () => {
    const { runtime, runId, session, conversations, recordings } = await setup('Done', 2);
    let count = 0;
    session.prompt.mockImplementation(async () => {
      count++;
      const options = vi.mocked(startAgentSession).mock.calls.at(-1)![0];
      options.onUpdateMessage!({ sessionId: 'acp-1', update: { sessionUpdate: 'tool_call', toolCallId: 'same-tool', title: 'Read', status: 'completed', rawOutput: count } });
      if (count === 1) throw new Error('connection lost');
      return { stopReason: count === 2 ? 'max_tokens' : 'end_turn' };
    });
    expect((await runtime.runUntilSettled(runId)).status).toBe('SUCCEEDED');
    const records = (await recordings()).sort((a, b) => Number(a.source!.identifiers.retryIndex) - Number(b.source!.identifiers.retryIndex));
    expect(records).toHaveLength(3);
    expect(new Set(records.map(r => r.id)).size).toBe(3);
    expect(new Set(records.map(r => r.source!.identifiers.attemptId)).size).toBe(1);
    expect(new Set(records.map(r => r.source!.identifiers.invocationId)).size).toBe(1);
    expect(records.map(r => r.source!.identifiers.retryIndex)).toEqual(['0', '1', '2']);
    const turns = await Promise.all(records.map(async r => (await conversations.store.listTurns(r.id)).items[0]));
    expect(turns.map(t => t.status)).toEqual(['failed', 'truncated', 'completed']);
    for (let i = 0; i < records.length; i++) expect(await conversations.getMessages(records[i].id, turns[i].id))
      .toContainEqual(expect.objectContaining({ kind: 'tool_call', toolCall: expect.objectContaining({ rawOutput: i + 1 }) }));
    expect(await listWorkflowConversations(conversations.store, { runId, nodeId: 'worker', retryIndex: 1 })).toEqual([records[1]]);
    expect(await listWorkflowConversations(conversations.store, { runId: 'other' })).toEqual([]);
    expect(session.prompt).toHaveBeenCalledTimes(4); // Three worker calls, then the original downstream node.
  });

  it('records startup failures even when no native session or successful receipt exists', async () => {
    const { runtime, runId, session, workerTurn, recordings } = await setup('unused');
    vi.mocked(startAgentSession).mockRejectedValue(new Error('could not launch'));
    expect((await runtime.runUntilSettled(runId)).status).toBe('FAILED');
    expect(await workerTurn()).toMatchObject({ status: 'failed', error: 'could not launch' });
    expect((await recordings())[0].nativeSessionId).toBeUndefined();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('records post-prompt cleanup failure despite end_turn', async () => {
    const { runtime, runId, session, workerTurn } = await setup('Done');
    session.shutdown.mockRejectedValue(new Error('shutdown failed'));
    expect((await runtime.runUntilSettled(runId)).status).toBe('FAILED');
    expect(await workerTurn()).toMatchObject({ status: 'failed', stopReason: 'end_turn', error: 'shutdown failed' });
  });

  it('preserves the read-only file guard and records its failure even after end_turn', async () => {
    const { runtime, runId, session, workerTurn } = await setup('Done');
    session.prompt.mockImplementationOnce(async () => {
      await vi.mocked(startAgentSession).mock.calls.at(-1)![0].onWriteTextFile!({ path: '/changed', newText: 'modified' } as never);
      return { stopReason: 'end_turn' };
    });
    expect((await runtime.runUntilSettled(runId)).status).toBe('FAILED');
    expect(await workerTurn()).toMatchObject({ status: 'failed', stopReason: 'end_turn', error: expect.stringContaining('Read-only AgentNode') });
  });

  it('records a human answer in a fresh invocation while retaining native session resume', async () => {
    const { runtime, runId, session, conversations, recordings } = await setup(JSON.stringify(waitEnvelope));
    const waiting = await runtime.runUntilSettled(runId);
    const [previous] = await recordings();
    session.getLatestAssistantItems.mockReturnValue([{ type: 'text', text: 'Approved and done' }]);
    const done = await runtime.respond({ runId, requestId: Object.values(waiting.waitRequests)[0].requestId, answer: 'Approved', responderId: 'human' });
    expect(done.status).toBe('SUCCEEDED');
    expect(vi.mocked(startAgentSession).mock.calls[1][0].resumeSessionId).toBe('acp-1');
    const records = await recordings();
    expect(records).toHaveLength(2);
    const resumed = records.find(r => r.id !== previous.id)!;
    const [turn] = (await conversations.store.listTurns(resumed.id)).items;
    expect(turn.content).toEqual([{ type: 'text', text: expect.stringContaining('Resolved Human Decision (from human)\nApproved') }]);
    expect((await conversations.store.readEvents(resumed.id)).items).toContainEqual(expect.objectContaining({ data: { type: 'conversation.attached', detail: { sessionId: 'session-1', nativeSessionId: 'acp-1', resumedFrom: 'acp-1' } } }));
    expect((await conversations.store.listTurns(previous.id)).items[0].content).not.toEqual(turn.content);
  });

  it('keeps concurrent node items isolated by scope without serializing their Agent calls', async () => {
    let active = 0;
    let peak = 0;
    let counter = 0;
    vi.mocked(startAgentSession).mockImplementation(async options => {
      const nativeId = `native-${++counter}`;
      return {
        sessionId: nativeId, acpSessionId: nativeId, shutdown: async () => {}, getHistory: () => [],
        getLatestAssistantItems: () => [{ type: 'text', text: nativeId }],
        prompt: async () => {
          peak = Math.max(peak, ++active);
          await new Promise(resolve => setTimeout(resolve, 20));
          options.onUpdateMessage!({ sessionId: nativeId, update: { sessionUpdate: 'tool_call', toolCallId: 'same-tool', title: 'Read', status: 'completed', rawOutput: nativeId } });
          active--;
          return { stopReason: 'end_turn' };
        },
      } as unknown as ManagedAgentSession;
    });
    const executor = new UniversalAgentExecutor({ workdir: process.cwd(), artifactTools: false, captureChanges: false });
    const runtime = createWorkflowRuntime({ executor });
    const definition = createWorkflowBuilder('parallel-recordings')
      .addWorkflowInput({ name: 'items', type: 'array', required: true })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', goal: 'Process item',
        parallel: { itemsPort: 'item', maxConcurrency: 3, failurePolicy: 'settle_all' }, inputs: [{ name: 'item', type: 'json', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'worker', toPort: 'item' }).buildDefinition();
    const { runId } = await runtime.start({ definition, inputs: { items: ['a', 'b', 'c'] } });
    expect((await runtime.runUntilSettled(runId)).status).toBe('SUCCEEDED');
    expect(peak).toBeGreaterThan(1);
    const records = await listWorkflowConversations(executor.conversationStore, { runId, nodeId: 'worker' });
    expect(records).toHaveLength(3);
    expect(new Set(records.map(r => r.source!.identifiers.scopeKey)).size).toBe(3);
    const service = new ConversationService({ store: executor.conversationStore });
    for (const record of records) {
      expect(await listWorkflowConversations(executor.conversationStore, { runId, scopeKey: record.source!.identifiers.scopeKey })).toEqual([record]);
      const [turn] = (await service.store.listTurns(record.id)).items;
      const tools = (await service.getMessages(record.id, turn.id)).filter(m => m.kind === 'tool_call');
      expect(tools).toEqual([expect.objectContaining({ toolCall: expect.objectContaining({ rawOutput: record.nativeSessionId }) })]);
    }
  });

  it('records per-node parallel retries, permissions and Chief repairs under distinct item scopes', async () => {
    let counter = 0;
    vi.mocked(startAgentSession).mockImplementation(async options => {
      const call = ++counter;
      const nativeId = `native-${call}`;
      return {
        sessionId: nativeId, acpSessionId: nativeId, shutdown: async () => {}, getHistory: () => [],
        getLatestAssistantItems: () => [{ type: 'text', text: JSON.stringify({ outputs: { value: nativeId } }) }],
        prompt: async () => {
          options.onUpdateMessage!({ sessionId: nativeId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: nativeId } } });
          options.onUpdateMessage!({ sessionId: nativeId, update: { sessionUpdate: 'tool_call', toolCallId: 'same-tool', title: 'Edit', kind: 'edit', status: 'pending' } });
          const response = await options.onRequestPermission('same-request', { sessionId: nativeId, toolCall: { toolCallId: 'same-tool', kind: 'edit' },
            options: [{ kind: 'reject_once', optionId: 'no', name: 'Reject' }, { kind: 'allow_once', optionId: 'yes', name: 'Allow' }] });
          expect(response.outcome).toEqual({ outcome: 'selected', optionId: 'no' });
          options.onUpdateMessage!({ sessionId: nativeId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'same-tool', status: 'failed', rawOutput: { call, denied: true } } });
          if (call === 1) throw new Error('connection lost');
          return { stopReason: 'end_turn' };
        },
      } as unknown as ManagedAgentSession;
    });
    const executor = new UniversalAgentExecutor({ workdir: process.cwd(), artifactTools: false, captureChanges: false });
    const runtime = createWorkflowRuntime({ executor, chief: { async review() { return { rationale: 'Repair only item 1', commands: [
      { kind: 'inject_guidance', scopeKey: '$root/worker[0]', nodeId: 'worker', text: 'Review the denied tool and repair the answer' },
      { kind: 'rerun_from_node', scopeKey: '$root/worker[0]', nodeId: 'worker' },
    ] }; } } });
    const definition = createWorkflowBuilder('node-parallel-recordings').setChief({ triggers: [] })
      .addWorkflowInput({ name: 'items', type: 'array', required: true })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', goal: 'Process', maxTechnicalRetries: 1,
        parallel: { itemsPort: 'item', maxConcurrency: 2, failurePolicy: 'settle_all' },
        inputs: [{ name: 'item', type: 'json', required: true }], outputs: [{ name: 'value', type: 'string', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'worker', toPort: 'item' }).buildDefinition();
    const { runId } = await runtime.start({ definition, inputs: { items: ['A', 'B'] } });
    const done = await runtime.runUntilSettled(runId);
    expect(done.status).toBe('SUCCEEDED');
    const before = await listWorkflowConversations(executor.conversationStore, { runId, nodeId: 'worker' });
    expect(before).toHaveLength(3);
    expect(before.filter(r => r.source!.identifiers.scopeKey === '$root/worker[0]').map(r => r.source!.identifiers.retryIndex).sort()).toEqual(['0', '1']);
    const { messageId } = await runtime.postChiefMessage({ runId, text: 'Repair first item', authorId: 'owner' });
    await runtime.answerChiefMessage({ runId, messageId });
    expect((await runtime.resume(runId)).status).toBe('SUCCEEDED');
    const records = await listWorkflowConversations(executor.conversationStore, { runId, nodeId: 'worker' });
    expect(records).toHaveLength(4);
    expect(records.filter(r => r.source!.identifiers.scopeKey === '$root/worker[1]')).toHaveLength(1);
    const service = new ConversationService({ store: executor.conversationStore });
    for (const record of records) {
      const turn = (await service.store.listTurns(record.id)).items[0]!;
      expect(turn.permissions).toEqual([expect.objectContaining({ requestId: 'same-request', status: 'answered', response: { outcome: { outcome: 'selected', optionId: 'no' } } })]);
      const messages = await service.getMessages(record.id, turn.id);
      expect(messages).toContainEqual(expect.objectContaining({ kind: 'tool_call', toolCall: expect.objectContaining({ rawOutput: { call: Number(record.nativeSessionId!.split('-')[1]), denied: true } }) }));
    }
    expect((await service.store.listTurns(before.find(r => r.source!.identifiers.scopeKey === '$root/worker[0]' && r.source!.identifiers.retryIndex === '0')!.id)).items[0]!.status).toBe('failed');
  });

  it('fail_fast cancels another item waiting for permission and records cancellation without retry', async () => {
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let counter = 0;
    vi.mocked(startAgentSession).mockImplementation(async options => {
      const call = ++counter;
      return {
        sessionId: `session-${call}`, acpSessionId: `native-${call}`, shutdown: async () => {}, getHistory: () => [],
        getLatestAssistantItems: () => [{ type: 'text', text: 'must not publish' }],
        prompt: async () => {
          if (call === 1) { await waiting; throw new Error('fatal first item'); }
          await options.onRequestPermission('pending', { sessionId: `native-${call}`, toolCall: { toolCallId: 'tool' }, options: [] });
          return { stopReason: 'end_turn' };
        },
      } as unknown as ManagedAgentSession;
    });
    const executor = new UniversalAgentExecutor({ workdir: process.cwd(), artifactTools: false, captureChanges: false,
      onRequestPermission: () => { entered(); return new Promise(() => {}); } });
    const runtime = createWorkflowRuntime({ executor });
    const definition = createWorkflowBuilder('cancel-item').addWorkflowInput({ name: 'items', type: 'array', required: true })
      .addAgent({ id: 'worker', name: 'Worker', role: 'worker', goal: 'Process', parallel: { itemsPort: 'item', maxConcurrency: 2, failurePolicy: 'fail_fast' }, inputs: [{ name: 'item', type: 'json', required: true }] })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'worker', toPort: 'item' }).buildDefinition();
    const { runId } = await runtime.start({ definition, inputs: { items: ['A', 'B', 'C'] } });
    const done = await runtime.runUntilSettled(runId);
    expect(done.status).toBe('FAILED'); expect(counter).toBe(2);
    const [record] = await listWorkflowConversations(executor.conversationStore, { runId, scopeKey: '$root/worker[1]' });
    expect((await executor.conversationStore.listTurns(record.id)).items[0]).toMatchObject({ status: 'cancelled', permissions: [expect.objectContaining({ status: 'cancelled' })] });
    expect(done.scopes['$root/worker[1]']!.nodes.worker!.status).toBe('FAILED');
    expect(done.scopes['$root/worker[2]']!.nodes.worker!.status).toBe('SKIPPED');
  });

  it('lets Flow cancel a waiting permission without retrying or letting chat controls take over', async () => {
    const { runtime, runId, session, conversations, workerTurn, recordings } = await setup('Done', 2, () => new Promise(() => {}));
    const controller = new AbortController();
    session.prompt.mockImplementation(async () => {
      const options = vi.mocked(startAgentSession).mock.calls.at(-1)![0];
      await options.onRequestPermission('rpc', { sessionId: 'acp-1', toolCall: { toolCallId: 'tool' }, options: [] });
      return { stopReason: 'end_turn' };
    });
    const running = runtime.runUntilSettled(runId, { signal: controller.signal });
    const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => expect((await workerTurn()).status).toBe('waiting_permission'));
    const [record] = await recordings();
    for (const action of ['connect', 'resume', 'recover', 'close', 'disconnect'] as const) await expect(conversations[action](record.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(conversations.cancel(record.id, (await workerTurn()).id)).rejects.toMatchObject({ code: 'conflict' });
    controller.abort();
    await rejected;
    expect(await workerTurn()).toMatchObject({ status: 'cancelled', permissions: [expect.objectContaining({ status: 'cancelled', response: { outcome: { outcome: 'cancelled' } } })] });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });
});
