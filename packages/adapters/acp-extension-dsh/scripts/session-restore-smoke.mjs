import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ClientSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { apply } from '../dist/adapter.js';

// Real pinned registry, loop, and JSONL/zstd storage; only the model and preset UI are synthetic.
const runtime = process.env.DSH_TEST_RUNTIME_ROOT;
assert.ok(runtime, 'Set DSH_TEST_RUNTIME_ROOT to the pinned Harness node_modules');
const requireRuntime = createRequire(join(runtime, '.restore-test.cjs'));
const load = (name) => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
assert.equal(
  requireRuntime('@deepseek-ai/dsh-agent-loop/package.json').version,
  process.env.DSH_TEST_EXPECTED_RUNTIME_VERSION ?? '0.2.1-rc.2'
);

if (process.argv[2] === '--phase') {
  const [root, compression, phase] = process.argv.slice(3);
  const { Context } = await load('cordis');
  const { LlmAdapter } = await load('dsh-llm');
  const requests = [];
  class SyntheticModel extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream(options) {
      requests.push(options);
      const text = `answer-${phase}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const ctx = new Context();
  const disposers = [];
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
        compression,
      })
      .await();
    await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] }).await();
    ctx.llm.registerAdapter(['synthetic'], new SyntheticModel());
    const incoming = new TransformStream();
    const outgoing = new TransformStream();
    const updates = [];
    const usage = [];
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
        logger: { warn: (message) => process.stderr.write(`${message}\n`) },
      },
      {
        provider: 'synthetic',
        model: 'fixture',
        stream: { readable: incoming.readable, writable: outgoing.writable },
      }
    );
    const client = new ClientSideConnection(
      () => ({
        extNotification: async (method, params) => {
          if (method === '_lody/session/usage_update') usage.push(params);
        },
        sessionUpdate: async (update) => {
          updates.push(update);
        },
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }),
      { readable: outgoing.readable, writable: incoming.writable }
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    assert.equal(initialized.agentCapabilities.loadSession, true);
    assert.deepEqual(initialized.agentCapabilities.sessionCapabilities.resume, {});
    let id;
    if (phase === 'new') {
      id = (await client.newSession({ cwd: root, mcpServers: [] })).sessionId;
      await writeFile(join(root, 'identity.json'), JSON.stringify(id));
    } else {
      id = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
      const params = { sessionId: id, cwd: root, mcpServers: [] };
      await assert.rejects(client.resumeSession({ ...params, cwd: join(root, 'wrong') }), /cwd/);
      assert.equal(ctx.agents.get(id), undefined);

      if (phase === 'load') {
        await client.loadSession(params);
        const text = updates.map(({ update }) => update.content?.text).filter(Boolean);
        assert.deepEqual(text, ['question-new', 'answer-new']);
        assert.equal(
          ctx.agents
            .get(id)
            .session.snapshotEvents()
            .filter((event) => event.type === 'turn/start' || event.type === 'turn/end')
            .at(-1).type,
          'turn/end'
        );
      } else {
        await client.resumeSession(params);
        assert.deepEqual(updates, []);
      }
      assert.equal(ctx.agents.get(id).session.id, id);
    }
    assert.equal(requests.length, 0, 'restoration must never prompt the model');
    await client.prompt({ sessionId: id, prompt: [{ type: 'text', text: `question-${phase}` }] });
    const texts = requests[0].messages.flatMap((message) =>
      message.content.filter((block) => block.type === 'text').map((block) => block.text)
    );
    assert.ok(texts.includes('question-new'));
    if (phase === 'resume') assert.ok(texts.includes('question-load'));
    assert.ok(texts.includes(`question-${phase}`));
    assert.equal(
      usage.at(-1).modelUsage.fixture.inputTokens,
      phase === 'new' ? 10 : phase === 'load' ? 20 : 30
    );
    assert.equal(usage.at(-1).delta.modelUsage.fixture.inputTokens, 10);
    await client.closeSession({ sessionId: id });
    assert.equal(ctx.agents.get(id), undefined);
    if (phase === 'new') {
      // A crash-style open tail: the native resume must repair it before ACP replay.
      const writer = await ctx.sessionPersistence.open(id, 'write');
      try {
        const { events } = await writer.read();
        await writer.append([
          {
            type: 'turn/start',
            seq: events.length,
            time: 1,
            data: { turn: events.filter((event) => event.type === 'turn/start').length + 1 },
          },
        ]);
      } finally {
        await writer.close();
      }
    }
  } finally {
    for (const dispose of disposers) await dispose();
    await ctx.fiber.dispose();
  }
} else {
  const origins = [
    undefined,
    ...(process.env.DSH_TEST_PREVIOUS_RUNTIME_ROOT
      ? [process.env.DSH_TEST_PREVIOUS_RUNTIME_ROOT]
      : []),
  ];
  for (const previous of origins)
    for (const compression of ['none', 'zstd']) {
      await test(`native ${compression}${previous ? ' upgrade from 0.1.5-rc.2' : ''} cold load and resume preserve identity and model context`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'dsh-acp-restore-'));
        try {
          let originalFiles = [];
          for (const phase of ['new', 'load', 'resume']) {
            await promisify(execFile)(
              process.execPath,
              [fileURLToPath(import.meta.url), '--phase', root, compression, phase],
              {
                env: {
                  PATH: process.env.PATH,
                  DSH_TEST_RUNTIME_ROOT: previous && phase === 'new' ? previous : runtime,
                  DSH_TEST_EXPECTED_RUNTIME_VERSION:
                    previous && phase === 'new' ? '0.1.5-rc.2' : '0.2.1-rc.2',
                },
                timeout: 60_000,
              }
            );
            if (previous && phase === 'new') {
              const files = await readdir(join(root, 'sessions'), { recursive: true });
              originalFiles = await Promise.all(
                files
                  .filter((file) => /session.*\.jsonl(?:\.zstd)?$/.test(file))
                  .map(async (file) => [file, await readFile(join(root, 'sessions', file))])
              );
              assert.ok(originalFiles.length > 0);
            } else if (previous) {
              for (const [file, bytes] of originalFiles)
                assert.deepEqual(
                  await readFile(join(root, 'sessions', file)),
                  bytes,
                  'migration must retain historical artifacts unchanged'
                );
            }
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
}
