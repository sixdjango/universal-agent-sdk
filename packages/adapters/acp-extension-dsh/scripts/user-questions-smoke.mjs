import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ClientSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { apply } from '../dist/adapter.js';

// No network, model calls, credentials, or user session data. Reuse the exact
// preinstalled runtime closure used by settings-profile-smoke.mjs.
const runtime = process.env.DSH_TEST_RUNTIME_ROOT;
assert.ok(runtime, 'Set DSH_TEST_RUNTIME_ROOT to the pinned Harness node_modules');
const requireRuntime = createRequire(join(runtime, '.user-questions-test.cjs'));
const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { createScope } = await load('@deepseek-ai/dsh-scope');
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session');
const { UserQuestionService } = await load('@deepseek-ai/dsh-user-questions');
const askTool = await load('@deepseek-ai/dsh-tool-ask-user');
assert.equal(requireRuntime('@deepseek-ai/dsh-user-questions/package.json').version, '0.2.1-rc.2');

await test('native Harness tool → scoped waterfall → ACP → native answers and ownership failures', async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore).await();
  const checkpoints = new Map();
  ctx.on('session/flush', (session) =>
    checkpoints.set(session.id, structuredClone(session.snapshotEvents()))
  );
  const agents = new Map();
  const roots = new Set();
  const scopes = [];
  let dispose;
  ctx.provide('llm', {
    listModels: async () => [{ id: 'synthetic', provider: 'deepseek', name: 'Synthetic' }],
    resolveModelInfo: async (provider, id) => ({
      id,
      provider,
      name: 'Synthetic',
    }),
  });
  ctx.provide('permissionPresets', {
    names: ['safe'],
    defaultPreset: 'safe',
    current: () => 'safe',
    optionOf: (value) => ({ value, name: value }),
    set: () => {},
  });
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    list: async () => [{ id: 'standard' }],
    mount: async () => ({ id: 'standard' }),
    select: async () => 'standard',
  });
  ctx.provide('agents', {
    get: (id) => agents.get(id),
    roots: () => [...roots],
    create: async (options) => {
      const agent = {
        id: options.sessionId,
        session: ctx.sessions.create(SessionId(options.sessionId), { meta: options.meta }),
        followup() {},
        cancel() {},
        whenIdle: async () => {},
      };
      const scope = createScope(ctx, agent);
      scopes.push(scope);
      agent.ctx = scope.ctx;
      await options.setup(scope.ctx);
      agents.set(agent.id, agent);
      roots.add(agent);
      return {
        agent,
        dispose: async () => {
          agents.delete(agent.id);
          roots.delete(agent);
          await scope.dispose();
        },
      };
    },
  });
  await ctx.plugin(UserQuestionService).await();
  let tool;
  ctx.provide('tools', {
    register: (value) => {
      tool = value;
    },
  });
  askTool.apply(ctx);
  assert.ok(tool);
  let endAgent;
  let endClient;
  const upstream = new TransformStream({
    start: (c) => {
      endAgent = () => c.terminate();
    },
  });
  const downstream = new TransformStream({
    start: (c) => {
      endClient = () => c.terminate();
    },
  });
  // Retain adapter teardown without replacing Cordis's own effect ownership.
  apply(
    {
      agents: ctx.agents,
      permissionPresets: ctx.permissionPresets,
      agentPresets: ctx.agentPresets,
      logger: ctx.logger,
      get: ctx.get.bind(ctx),
      on: ctx.on.bind(ctx),
      effect: (register) => {
        dispose = register();
      },
    },
    {
      model: 'synthetic',
      stream: { readable: upstream.readable, writable: downstream.writable },
    }
  );
  const requests = [];
  let onRequest = () => {};
  let response = {
    action: 'accept',
    content: { question_0: ['A', 'B'], custom_0: 'C' },
  };
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      unstable_createElicitation: async (request) => {
        requests.push(request);
        onRequest();
        return response;
      },
    }),
    { readable: downstream.readable, writable: upstream.writable }
  );
  try {
    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        elicitation: { form: {} },
        _meta: { lody: { elicitation: { version: 1, answerNotes: true } } },
      },
    });
    const first = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    const second = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    const agent = agents.get(first.sessionId);
    const questions = [
      {
        id: 'choice',
        question: 'Choose?',
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect: true,
      },
    ];
    const result = await tool.execute(
      { questions: [{ ...questions[0], multi_select: true }] },
      { agent, signal: new AbortController().signal }
    );
    assert.deepEqual(result, {
      answers: [{ id: 'choice', selected: ['A', 'B'], custom: 'C' }],
    });
    assert.equal(requests[0].sessionId, first.sessionId);
    await ctx.userQuestions.ask({
      agent: agents.get(second.sessionId),
      questions,
    });
    assert.equal(requests[1].sessionId, second.sessionId);
    roots.delete(agent);
    await assert.rejects(ctx.userQuestions.ask({ agent, questions }), {
      code: 'DELEGATED_CALLER',
    });
    roots.add(agent);
    await assert.rejects(ctx.userQuestions.ask({ agent: { ...agent }, questions }), {
      code: 'CALLER_NOT_LIVE',
    });
    await assert.rejects(ctx.userQuestions.ask({ questions }), {
      code: 'NO_PROVIDER',
    });
    assert.equal(requests.length, 2);
    response = { action: 'cancel' };
    await assert.rejects(ctx.userQuestions.ask({ agent, questions }), {
      code: 'ASK_ABORTED',
    });
    response = { action: 'decline' };
    await assert.rejects(ctx.userQuestions.ask({ agent, questions }), {
      code: 'ASK_DECLINED',
    });
    for (const cancellation of ['signal', 'session', 'close']) {
      const pendingSession = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
      const pendingAgent = agents.get(pendingSession.sessionId);
      const signal = new AbortController();
      let lateReply;
      response = new Promise((resolve) => {
        lateReply = resolve;
      });
      const received = new Promise((resolve) => {
        onRequest = resolve;
      });
      const pending = ctx.userQuestions.ask({
        agent: pendingAgent,
        questions,
        signal: signal.signal,
      });
      const rejected = assert.rejects(pending, { code: 'ASK_ABORTED' });
      await received;
      onRequest = () => {};
      // A different session is not held behind this unanswered request.
      response = { action: 'accept', content: { question_0: ['B'] } };
      assert.deepEqual(await ctx.userQuestions.ask({ agent, questions }), {
        answers: [{ id: 'choice', selected: ['B'] }],
      });
      if (cancellation === 'signal') signal.abort();
      else if (cancellation === 'session')
        await client.cancel({ sessionId: pendingSession.sessionId });
      else await client.closeSession({ sessionId: pendingSession.sessionId });
      await rejected;
      lateReply({ action: 'accept', content: { question_0: ['A'] } });
    }
    // Existing approval waterfall must still return native permission outcomes.
    assert.equal(
      await ctx.waterfall(
        'approval/request',
        { agent, callId: 'permission' },
        async () => 'unhandled'
      ),
      'allowed-once'
    );
    assert.ok(checkpoints.get(first.sessionId).some((event) => event.type === 'model/selection'));
    await client.closeSession({ sessionId: first.sessionId });
    await assert.rejects(ctx.userQuestions.ask({ agent, questions }), {
      code: 'CALLER_NOT_LIVE',
    });
  } finally {
    await dispose();
    endAgent();
    endClient();
    await client.closed;
    for (const scope of scopes) await scope.dispose();
    await ctx.fiber.dispose();
  }
});
