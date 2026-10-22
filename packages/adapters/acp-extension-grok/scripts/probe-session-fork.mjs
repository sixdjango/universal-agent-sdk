// Opt-in native compatibility probe. Uses only synthetic local history, an
// isolated GROK_HOME, and no authentication or model prompts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (!process.env.GROK_PATH) throw new Error('Set GROK_PATH to the official binary to probe');
const home = await mkdtemp(join(tmpdir(), 'grok-fork-probe-'));
const cwd = join(home, 'source');
const childCwd = join(home, 'child');
const source = join(home, 'sessions', encodeURIComponent(cwd), 'synthetic-source');
await mkdir(source, { recursive: true });
await mkdir(cwd);
await mkdir(childCwd);
const chat = [];
const updates = [];
for (let index = 0; index < 3; index++) {
  chat.push(
    { type: 'user', content: [{ type: 'text', text: `P${index}` }], prompt_index: index },
    { type: 'assistant', content: `A${index}` }
  );
  for (const [kind, text] of [
    ['user_message_chunk', `P${index}`],
    ['agent_message_chunk', `A${index}`],
  ]) {
    updates.push({
      method: 'session/update',
      params: {
        sessionId: 'synthetic-source',
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          ...(kind === 'user_message_chunk' ? { _meta: { promptIndex: index } } : {}),
        },
      },
    });
  }
}
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const sourceChat = lines(chat);
const sourceUpdates = lines(updates);
await writeFile(
  join(source, 'summary.json'),
  JSON.stringify({
    info: { id: 'synthetic-source', cwd },
    session_summary: 'Synthetic fork probe',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    num_messages: 6,
    num_chat_messages: 6,
    current_model_id: 'grok-build',
    chat_format_version: 1,
  })
);
await writeFile(join(source, 'chat_history.jsonl'), sourceChat);
await writeFile(join(source, 'updates.jsonl'), sourceUpdates);
const child = spawn(process.env.GROK_PATH, ['agent', 'stdio'], {
  env: { ...process.env, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: '1' },
  stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map();
let nextId = 0;
const input = createInterface({ input: child.stdout });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method) return;
  pending.get(message.id)?.(message);
});
const exited = new Promise((resolve) => child.once('close', resolve));
child.on('error', (error) => {
  for (const settle of pending.values()) settle({ error });
});
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      pending.delete(id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const listing = await request('session/list', {});
  assert.equal(listing.sessions.find((row) => row.sessionId === 'synthetic-source')?.cwd, cwd);
  for (const target of [undefined, 0, 1]) {
    const result = await request('_x.ai/session/fork', {
      sourceSessionId: 'synthetic-source',
      sourceCwd: cwd,
      newCwd: childCwd,
      ...(target === undefined ? {} : { targetPromptIndex: target }),
    });
    assert.notEqual(result.newSessionId, 'synthetic-source');
    const dir = join(home, 'sessions', encodeURIComponent(childCwd), result.newSessionId);
    const readRows = async (file) =>
      (await readFile(join(dir, file), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const expected = target === undefined ? 6 : (target + 1) * 2;
    assert.deepEqual(await readRows('chat_history.jsonl'), chat.slice(0, expected));
    const replay = await readRows('updates.jsonl');
    assert.equal(replay.length, expected);
    assert.deepEqual(
      replay.map((row) => row.params.update.content.text),
      updates.slice(0, expected).map((row) => row.params.update.content.text)
    );
    assert.ok(replay.every((row) => row.params.sessionId === result.newSessionId));
  }
  assert.equal(await readFile(join(source, 'chat_history.jsonl'), 'utf8'), sourceChat);
  assert.equal(await readFile(join(source, 'updates.jsonl'), 'utf8'), sourceUpdates);
  console.log(
    `Grok ${init._meta?.agentVersion}: source discovery, full fork, inclusive turns 0/1, cross-cwd copy and source preservation passed`
  );
} finally {
  input.close();
  child.kill();
  await exited;
  await rm(home, { recursive: true, force: true });
}
