import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ClientSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { apply } from '../dist/adapter.js';
import { ToolCallBridge } from '../dist/tool-calls.js';

const runtime = process.env.DSH_TEST_RUNTIME_ROOT;
assert.ok(runtime);
const requireRuntime = createRequire(join(runtime, '.core-test.cjs'));
const load = (name) => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
const signal = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

await test('projects tool results built by the pinned native message constructor', async () => {
  assert.equal(requireRuntime('@deepseek-ai/dsh-llm/package.json').version, '0.2.1-rc.2');
  const { createToolResultMessage } = await load('dsh-llm');
  const updates = [];
  const bridge = new ToolCallBridge({
    cwd: '/synthetic',
    lookup: () => undefined,
    content: async (block) => block,
    emit: async (update) => {
      updates.push(update);
    },
    warn: () => {},
  });
  for (const [id, content, isError] of [
    ['success', [{ type: 'text', text: 'done' }], false],
    ['failure', [{ type: 'text', text: 'denied' }], true],
    ['empty', [], false],
  ]) {
    await bridge.event('tool/call', { callId: id, name: 'read', arguments: '{}' });
    const message = createToolResultMessage({ callId: id, content, isError });
    await bridge.event('tool/result', { message });
    assert.deepEqual(updates.at(-1), {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: isError ? 'failed' : 'completed',
      content: content.map((block) => ({ type: 'content', content: block })),
      rawOutput: { message },
    });
  }
  await bridge.event('turn/end', {});
  assert.equal(updates.length, 6, 'recorded results must not be interrupted as unknown');
});

await test(
  'Core controls retain native prompt ownership and read-only history',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-core-'));
    const origin = join(root, 'origin');
    await mkdir(origin);
    const { Context } = await load('cordis');
    const { LlmAdapter } = await load('dsh-llm');
    const ctx = new Context();
    const disposers = [];
    let behavior = async () => {};
    const requests = [];
    class Model extends LlmAdapter {
      async resolveModel(provider, model) {
        return { provider, id: model, name: model, contextWindow: 4096 };
      }
      async *stream(options) {
        requests.push(options);
        await behavior(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'synthetic answer' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic answer' } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    try {
      for (const name of [
        'dsh-llm',
        'dsh-session',
        'dsh-session-projection',
        'dsh-system-prompt',
        'dsh-tools',
        'dsh-agent',
      ])
        await ctx.plugin((await load(name)).default).await();
      const persistence = await load('dsh-session-persistence-jsonl');
      await ctx
        .plugin(persistence.default ?? persistence, {
          root: join(root, 'sessions'),
          compression: 'none',
        })
        .await();
      await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] }).await();
      await ctx.plugin((await load('dsh-goal')).default, { defaultMaxGoalRounds: 2 }).await();
      await ctx.plugin(await load('dsh-goal-round-driver')).await();
      await ctx.plugin((await load('dsh-session-query')).default, { openAt: 'never' }).await();
      await ctx.plugin((await load('dsh-jobs-local')).default).await();
      ctx.jobs.attachController('synthetic');
      ctx.llm.registerAdapter(['synthetic'], new Model());
      const incoming = new TransformStream();
      const outgoing = new TransformStream();
      const updates = [];
      const notifications = [];
      apply(
        {
          agents: ctx.agents,
          agentPresets: {
            defaultId: 'synthetic',
            list: async () => [{ id: 'synthetic' }],
            mount: async () => ({ id: 'synthetic' }),
          },
          permissionPresets: {
            names: ['workspace-write'],
            current: () => 'workspace-write',
            optionOf: (value) => ({ value, name: value }),
          },
          get: (name) => ctx.get(name),
          on: (...args) => ctx.on(...args),
          effect: (register) => disposers.push(register()),
          logger: { warn: console.error },
        },
        {
          provider: 'synthetic',
          model: 'fixture',
          projectMetadataRoot: join(root, 'projects'),
          stream: { readable: incoming.readable, writable: outgoing.writable },
        }
      );
      const client = new ClientSideConnection(
        () => ({
          sessionUpdate: async (value) => {
            updates.push(value);
          },
          extNotification: async (method, value) => {
            notifications.push({ method, value });
          },
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        }),
        { readable: outgoing.readable, writable: incoming.writable }
      );
      const initialized = await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      assert.equal(initialized.agentCapabilities._meta.lody.goal.version, 1);
      const id = (
        await client.newSession({
          cwd: root,
          mcpServers: [],
          _meta: { lody: { worktreeProject: { version: 1, originProjectPath: origin } } },
        })
      ).sessionId;
      const agent = ctx.agents.get(id);
      assert.equal(agent.session.header.cwd, root);
      assert.equal(
        JSON.parse(await readFile(join(root, 'projects', `${id}.json`), 'utf8')).originProjectPath,
        origin
      );
      const entered = signal();
      const release = signal();
      behavior = async () => {
        entered.resolve();
        await release.promise;
      };
      const prompt = client.prompt({ sessionId: id, prompt: [{ type: 'text', text: 'first' }] });
      await entered.promise;
      const injected = signal();
      const off = ctx.on('agent/inbox/inserted', ({ message }) => {
        if (message.content[0]?.text === 'steer') injected.resolve();
      });
      const steer = client.extMethod('_lody/session/steer', {
        sessionId: id,
        steerId: 's1',
        prompt: [{ type: 'text', text: 'steer' }],
      });
      await injected.promise;
      off();
      release.resolve();
      assert.deepEqual(await steer, { outcome: 'injected' });
      assert.equal((await prompt).stopReason, 'end_turn');
      assert.ok(
        notifications.some(
          (x) => x.method === '_lody/session/steer_applied' && x.value.steerId === 's1'
        )
      );
      assert.deepEqual(
        await client.extMethod('_lody/session/steer', {
          sessionId: id,
          steerId: 'idle',
          prompt: [{ type: 'text', text: 'must not run' }],
        }),
        { outcome: 'failed' }
      );
      const jobDone = signal();
      const job = ctx.jobs.start({
        kind: 'bash',
        label: 'synthetic job',
        owner: id,
        run(handle) {
          handle.append('retained output');
          return {
            cancel() {
              jobDone.resolve({ status: 'killed' });
            },
            done: jobDone.promise,
          };
        },
      });
      const foreignDone = signal();
      ctx.jobs.start({
        kind: 'bash',
        label: 'unowned job',
        run() {
          return {
            cancel() {
              foreignDone.resolve({ status: 'killed' });
            },
            done: foreignDone.promise,
          };
        },
      });
      jobDone.resolve({ status: 'completed' });
      await ctx.jobs.wait(job, 1000, id);
      await client.extMethod('_lody/subagents/list', { sessionId: id });
      assert.ok(updates.some((x) => x.update._meta?.lody?.task?.status === 'completed'));
      assert.ok(!updates.some((x) => x.update._meta?.lody?.task?.description === 'unowned job'));
      assert.equal(
        ctx.jobs
          .read(job, id)
          .chunks.map((x) => x.text)
          .join(''),
        'retained output',
        'UI projection must not consume model output'
      );
      foreignDone.resolve({ status: 'completed' });
      const before = requests.length;
      behavior = async () => {};
      await client.prompt({
        sessionId: id,
        prompt: [],
        _meta: {
          lody: { goalControl: { version: 1, action: 'set', objective: 'synthetic objective' } },
        },
      });
      assert.equal(ctx.goals.get(agent).blockedReason.code, 'round-limit');
      assert.equal(requests.length - before, 2, 'both automatic rounds stay owned');
      assert.ok(updates.some((x) => x.update._meta?.lody?.goal?.status === 'limited'));
      await assert.rejects(
        client.extMethod('_lody/session/goal', { sessionId: id, action: 'resume' })
      );
      await client.extMethod('_lody/session/goal', { sessionId: id, action: 'clear' });
      assert.equal(ctx.goals.get(agent), undefined);
      const secondEntered = signal();
      const cancelled = signal();
      behavior = async (options) => {
        secondEntered.resolve();
        if (!options.signal.aborted)
          await new Promise((resolve) =>
            options.signal.addEventListener('abort', resolve, { once: true })
          );
        cancelled.resolve();
      };
      const goalPrompt = client.prompt({
        sessionId: id,
        prompt: [],
        _meta: { lody: { goalControl: { version: 1, action: 'set', objective: 'pause test' } } },
      });
      await secondEntered.promise;
      const paused = await client.extMethod('_lody/session/goal', {
        sessionId: id,
        action: 'pause',
      });
      assert.equal(paused.goal.status, 'paused');
      await cancelled.promise;
      await goalPrompt;
      behavior = async () => {};
      const resumedAt = requests.length;
      await client.prompt({
        sessionId: id,
        prompt: [{ type: 'text', text: 'fallback should stay hidden' }],
        _meta: { lody: { goalControl: { version: 1, action: 'resume' } } },
      });
      assert.equal(requests.length - resumedAt, 1);
      assert.equal(ctx.goals.get(agent).blockedReason.code, 'round-limit');
      await client.extMethod('_lody/session/goal', { sessionId: id, action: 'clear' });
      const cancelEntered = signal();
      behavior = async (options) => {
        cancelEntered.resolve();
        if (!options.signal.aborted)
          await new Promise((resolve) =>
            options.signal.addEventListener('abort', resolve, { once: true })
          );
      };
      const cancelPrompt = client.prompt({
        sessionId: id,
        prompt: [{ type: 'text', text: 'cancel turn' }],
      });
      await cancelEntered.promise;
      const cancelQueued = signal();
      const cancelOff = ctx.on('agent/inbox/inserted', ({ message }) => {
        if (message.content[0]?.text === 'cancelled steer') cancelQueued.resolve();
      });
      const cancelledSteer = client.extMethod('_lody/session/steer', {
        sessionId: id,
        steerId: 'cancelled',
        prompt: [{ type: 'text', text: 'cancelled steer' }],
      });
      await cancelQueued.promise;
      cancelOff();
      await client.cancel({ sessionId: id });
      assert.equal((await cancelPrompt).stopReason, 'cancelled');
      assert.deepEqual(await cancelledSteer, { outcome: 'failed' });
      assert.equal(agent.inbox.hasPending, false);
      assert.ok(!notifications.some((x) => x.value.steerId === 'cancelled'));
      await client.closeSession({ sessionId: id });
      const stored = await ctx.sessionQuery.observeSession(id);
      const nativeBefore = JSON.stringify(stored.events);
      stored[Symbol.dispose]();
      updates.length = 0;
      await client.extMethod('_lody/session/history/read', { sessionId: id });
      assert.equal(ctx.agents.get(id), undefined);
      assert.ok(
        updates.some(
          (x) =>
            x.update.sessionUpdate === 'user_message_chunk' && x.update.content.text === 'first'
        )
      );
      const observed = await ctx.sessionQuery.observeSession(id);
      assert.equal(JSON.stringify(observed.events), nativeBefore);
      observed[Symbol.dispose]();
      assert.ok(
        (await client.listSessions({ cwd: origin })).sessions.some(
          (x) => x.sessionId === id && x.cwd === root
        )
      );
      await assert.rejects(
        client.extMethod('_lody/subagents/output', { sessionId: id, taskId: 'foreign' })
      );
    } finally {
      for (const dispose of disposers) await dispose();
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
);
