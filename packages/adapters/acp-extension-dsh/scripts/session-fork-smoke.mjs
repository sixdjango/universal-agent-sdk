import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { forkSnapshot, forkTarget } from '../dist/session-fork.js';

// Synthetic native events only: no model, network, credentials, or user session data.
const runtime = process.env.DSH_TEST_RUNTIME_ROOT;
assert.ok(runtime, 'Set DSH_TEST_RUNTIME_ROOT to the pinned Harness node_modules');
const requireRuntime = createRequire(join(runtime, '.session-fork-test.cjs'));
const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore, Session, SessionId } = await load('@deepseek-ai/dsh-session');
const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
assert.equal(requireRuntime('@deepseek-ai/dsh-session/package.json').version, '0.2.1-rc.2');

await test('adapter prefixes reconstruct native history before/after compaction and survive serialization', async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(SessionStore);
  await fiber.await();
  try {
    const source = ctx.sessions.create(SessionId('synthetic-parent'), { meta: { cwd: '/source' } });
    const appendTurn = (session, turn, text, replace) => {
      session.append('turn/start', { turn });
      const message = session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
        {
          surfaceOp: replace ?? 'append',
          ...(replace ? { sourceEventSeqs: [replace.startSeq] } : {}),
        }
      );
      session.append('turn/end', { turn, reason: { kind: 'completed' } });
      return message.seq;
    };
    const original = appendTurn(source, 1, 'first');
    appendTurn(source, 2, 'second');
    appendTurn(source, 3, 'summary', { op: 'replace', startSeq: original, endSeq: original });
    const before = JSON.stringify(source.snapshotEvents());
    const observation = {
      header: source.header,
      events: JSON.parse(before),
      [Symbol.dispose]() {},
    };
    const children = [];
    for (const [target, expected] of [
      [undefined, ['summary', 'second']],
      ['dsh-turn:1', ['first']],
      ['dsh-turn:2', ['first', 'second']],
      ['dsh-turn:3', ['summary', 'second']],
    ]) {
      const snapshot = forkSnapshot(
        observation,
        forkTarget({ lody: { forkAtTurn: { version: 1, ...(target ? { turnId: target } : {}) } } })
      );
      // The actual seeded constructor used by AgentRegistry.create validates the prefix.
      const child = ctx.sessions.create(SessionId(`child-${children.length}`), {
        seed: snapshot.seed,
        inheritedEventCount: snapshot.seed.length,
        meta: {
          cwd: '/target',
          parentSession: snapshot.sourceId,
          isSeeded: true,
        },
      });
      children.push(child);
      assert.deepEqual(
        child.deriveMessages().map((message) => message.content[0].text),
        expected
      );
      assert.equal(child.header.cwd, '/target');
      assert.equal(child.header.parentSession, source.id);
      const restored = Session.fromRestore(
        child.id,
        JSON.parse(JSON.stringify(child.snapshotEvents())),
        child.header,
        child.inheritedEventCount,
        'detached'
      );
      assert.deepEqual(restored.deriveMessages(), child.deriveMessages());
    }
    appendTurn(children[1], 2, 'independent child');
    assert.equal(JSON.stringify(source.snapshotEvents()), before);
    source.append('turn/start', { turn: 4 });
    const active = { ...observation, events: source.snapshotEvents() };
    assert.throws(() => forkSnapshot(active), /unfinished turn/);
    assert.throws(() => forkSnapshot(active, 'dsh-turn:4'), /has not ended/);
    const earlier = forkSnapshot(active, 'dsh-turn:1');
    const child = ctx.sessions.create(SessionId('active-parent-child'), {
      seed: earlier.seed,
      inheritedEventCount: earlier.seed.length,
      meta: {
        parentSession: source.id,
        isSeeded: true,
      },
    });
    assert.equal(child.deriveMessages()[0].content[0].text, 'first');
    assert.equal(source.snapshotEvents().at(-1).type, 'turn/start');
  } finally {
    await fiber.dispose();
  }
});
