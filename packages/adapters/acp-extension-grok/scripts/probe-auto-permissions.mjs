// Opt-in integration probe: official Grok + the production adapter, isolated
// config/history, synthetic model responses on loopback, no account credentials.
// Native hooks are observation instruments in this probe only, not adapter logic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import manifest from '../runtime-manifest.json' with { type: 'json' };

if (!process.env.GROK_PATH) throw new Error('Set GROK_PATH to the official binary');
const grokPath = resolve(process.env.GROK_PATH);
const adapter = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.js');
const binaryHash = createHash('sha256')
  .update(await readFile(grokPath))
  .digest('hex');
const root = await mkdtemp(join(tmpdir(), 'grok-auto-probe-'));
let round;
let sequence = 0;
const server = createServer(async (request, response) => {
  try {
    let input = '';
    for await (const chunk of request) input += chunk;
    const body = input ? JSON.parse(input) : {};
    if (process.env.PROBE_DEBUG)
      console.error('HTTP', request.url, JSON.stringify(body).slice(-1500));
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'probe-model', object: 'model' }] }));
      return;
    }
    const isClassifier = JSON.stringify(body.response_format ?? {}).includes('shouldBlock');
    const isAgent = body.tools?.some((tool) => tool.function?.name === 'run_terminal_command');
    let message = { role: 'assistant', content: 'Synthetic probe complete.' };
    let finishReason = 'stop';
    if (isClassifier) {
      assert.ok(round, 'unexpected classifier request outside a probe round');
      round.classifications += 1;
      if (round.verdict === 'unavailable') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message: 'Synthetic classifier unavailable',
              type: 'invalid_request_error',
            },
          })
        );
        return;
      }
      message.content = JSON.stringify({
        thinking: 'Synthetic fixture',
        shouldBlock: round.verdict === 'block',
        reason: 'Probe verdict',
      });
    } else if (isAgent && round && !round.issued) {
      round.issued = true;
      // A harmless but non-allowlisted command: its observable marker must only
      // appear when the native classifier or YOLO actually permits execution.
      const command = `printf executed > ${round.marker}`;
      message = {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `probe-${sequence}`,
            type: 'function',
            function: {
              name: 'run_terminal_command',
              arguments: JSON.stringify({
                command,
                description: 'Write an isolated probe marker',
                block_until_ms: 10000,
              }),
            },
          },
        ],
      };
      finishReason = 'tool_calls';
    }
    const envelope = { id: 'synthetic', created: 1, model: 'probe-model' };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`
      );
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ...envelope,
          object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason: finishReason }],
        })
      );
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

async function fixture(enabled) {
  const home = join(root, enabled ? 'enabled' : 'disabled');
  const cwd = join(home, 'workspace');
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(home, 'config.toml'),
    `[models]\ndefault="probe-model"\n[model.probe-model]\nmodel="probe-model"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\napi_key="synthetic-probe-key"\ncontext_window=128000\n[auto_mode]\nenabled=${enabled}\n`
  );
  const child = spawn(process.execPath, [adapter], {
    cwd,
    // Deliberately do not inherit API keys, login state, proxies or user's Grok
    // configuration. Every sampling request targets the synthetic local model.
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GROK_HOME: home,
      GROK_PATH: grokPath,
      GROK_SANDBOX_MODE: 'off',
      RUST_LOG: 'xai_grok_workspace::permission=debug,xai_grok_shell::session=info',
      GROK_DISABLE_AUTOUPDATER: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-12000);
    if (process.env.PROBE_DEBUG) console.error('NATIVE', String(chunk));
  });
  const pending = new Map();
  let nextId = 0;
  const exited = new Promise((resolve) => child.once('close', resolve));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const input = createInterface({ input: child.stdout });
  input.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      process.env.PROBE_DEBUG &&
      (message.method?.includes('hooks') ||
        message.params?.update?.sessionUpdate?.includes('tool_call'))
    )
      console.error('WIRE', JSON.stringify(message));
    if (
      message.method === '_x.ai/hooks/event' &&
      message.params.hookEventName === 'user_prompt_submit' &&
      round
    ) {
      round.observedMode = message.params.permissionMode;
    }
    if (message.method && message.id !== undefined) {
      if (message.method === 'session/request_permission') {
        if (round) round.permissions += 1;
        const reject = message.params.options.find((option) => option.kind === 'reject_once');
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            outcome: reject
              ? { outcome: 'selected', optionId: reject.optionId }
              : { outcome: 'cancelled' },
          },
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Unsupported probe client request' },
        });
      }
    } else if (!message.method) pending.get(message.id)?.(message);
  });
  child.on('error', (error) => {
    for (const settle of pending.values()) settle({ error: { message: error.message } });
  });
  child.on('close', () => {
    for (const settle of pending.values())
      settle({ error: { message: `Adapter exited: ${stderr}` } });
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out: ${stderr}`));
      }, 30000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        pending.delete(id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  const clientIdentifier = `lody:auto-probe-${enabled}`;
  function meta(mode) {
    return {
      clientIdentifier,
      lody: {
        sessionConfig: {
          version: 1,
          configOptionValues: { permission_mode: mode },
        },
      },
      'x.ai/hooks': {
        UserPromptSubmit: [{ hookCallbackIds: ['probe-observe'] }],
      },
    };
  }
  async function close() {
    input.close();
    child.stdin.end();
    child.kill();
    await exited;
  }
  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      _meta: { clientIdentifier },
    });
    assert.equal(init._meta.agentVersion, manifest.officialRuntime.version);
  } catch (error) {
    await close();
    throw error;
  }
  async function prompt(
    sessionId,
    label,
    { observedMode, execute, classify, interactive, verdict = 'allow' }
  ) {
    round = {
      marker: `probe-${++sequence}.txt`,
      issued: false,
      classifications: 0,
      permissions: 0,
      verdict,
    };
    const result = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Run the synthetic probe command.' }],
    });
    assert.equal(result.stopReason, interactive ? 'cancelled' : 'end_turn', label);
    assert.equal(round.observedMode, observedMode, `${label}: actual native permission mode`);
    assert.equal(round.classifications > 0, classify, `${label}: actual classifier invocation`);
    assert.equal(round.permissions > 0, interactive, `${label}: client permission flow`);
    const contents = await readFile(join(cwd, round.marker), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert.equal(contents === 'executed', execute, `${label}: actual tool execution`);
    console.log(
      `PASS ${label}: native=${round.observedMode}, classifier=${round.classifications}, client approvals=${round.permissions}, executed=${execute}`
    );
    round = undefined;
  }
  return {
    request,
    meta,
    cwd,
    prompt,
    close,
  };
}

try {
  let sourceSessionId;
  const f = await fixture(true);
  try {
    const session = await f.request('session/new', {
      cwd: f.cwd,
      mcpServers: [],
      _meta: f.meta('auto'),
    });
    const sid = session.sessionId;
    sourceSessionId = sid;
    const auto = {
      observedMode: 'auto',
      execute: true,
      classify: true,
      interactive: false,
    };
    const ask = {
      observedMode: 'default',
      execute: false,
      classify: false,
      interactive: true,
    };
    await f.prompt(sid, 'new Auto', auto);
    const select = (value) =>
      f.request('session/set_config_option', {
        sessionId: sid,
        configId: 'permission_mode',
        value,
      });
    await select('ask');
    await f.prompt(sid, 'Auto → Ask', ask);
    await select('auto');
    await f.prompt(sid, 'Ask → Auto', auto);
    await select('always-approve');
    await f.prompt(sid, 'Auto → YOLO', {
      ...auto,
      observedMode: 'bypassPermissions',
      classify: false,
    });
    await select('auto');
    await f.prompt(sid, 'YOLO → Auto, classifier blocks', {
      ...auto,
      execute: false,
      verdict: 'block',
    });
    await f.prompt(sid, 'Auto classifier unavailable', {
      ...auto,
      execute: false,
      interactive: true,
      verdict: 'unavailable',
    });
    for (const method of ['session/load', 'session/resume']) {
      await f.request(method, {
        sessionId: sid,
        cwd: f.cwd,
        mcpServers: [],
        _meta: f.meta('auto'),
      });
      await f.prompt(sid, `${method} Auto`, auto);
    }
    const fork = await f.request('session/fork', {
      sessionId: sid,
      cwd: f.cwd,
      mcpServers: [],
      _meta: f.meta('auto'),
    });
    assert.notEqual(fork.sessionId, sid);
    await f.prompt(fork.sessionId, 'fork Auto', auto);
    await f.prompt(sid, 'source remains usable after fork', auto);
  } finally {
    await f.close();
  }
  for (const method of ['session/load', 'session/resume']) {
    const cold = await fixture(true);
    try {
      await cold.request(method, {
        sessionId: sourceSessionId,
        cwd: cold.cwd,
        mcpServers: [],
        _meta: cold.meta('auto'),
      });
      await cold.prompt(sourceSessionId, `cold ${method} Auto`, {
        observedMode: 'auto',
        execute: true,
        classify: true,
        interactive: false,
      });
    } finally {
      await cold.close();
    }
  }
  const disabled = await fixture(false);
  try {
    const session = await disabled.request('session/new', {
      cwd: disabled.cwd,
      mcpServers: [],
      _meta: disabled.meta('auto'),
    });
    // The selection explicitly describes a request, not an acknowledgement.
    assert.match(
      session.configOptions.find((option) => option.id === 'permission_mode').description,
      /not a runtime confirmation/
    );
    await disabled.prompt(session.sessionId, 'disabled Auto gate', {
      observedMode: 'default',
      execute: false,
      classify: false,
      interactive: true,
    });
    for (const value of ['ask', 'auto']) {
      await disabled.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'permission_mode',
        value,
      });
    }
    await disabled.prompt(session.sessionId, 'disabled gate live Auto', {
      observedMode: 'default',
      execute: false,
      classify: false,
      interactive: true,
    });
  } finally {
    await disabled.close();
  }
  console.log(`Grok ${manifest.officialRuntime.version}; SHA-256 ${binaryHash}`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (process.env.PROBE_DEBUG) console.error('PROBE_ROOT', root);
  else await rm(root, { recursive: true, force: true });
}
