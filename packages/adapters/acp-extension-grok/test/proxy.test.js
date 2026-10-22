import assert from 'node:assert/strict';
import test from 'node:test';

import { isLodySubagentEvent, isLodySubagentOutput } from 'acp-extension-core';

import runtimeManifest from '../runtime-manifest.json' with { type: 'json' };
import {
  GrokAcpCompatibilityProxy,
  normalizeBillingRateLimits,
  normalizePromptUsage,
  permissionNotification,
} from '../src/proxy.js';

const clientIdentifier = 'lody:session-1';
const sessionResponse = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    sessionId: 'grok-session',
    models: {
      currentModelId: 'grok-build',
      availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }],
    },
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'grok-build',
        options: [{ value: 'grok-build', name: 'Grok Build' }],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
    modes: { currentModeId: 'default' },
    _meta: {
      'x.ai/sessionConfig': {
        options: [
          {
            id: 'grok-build',
            category: 'model',
            label: 'Grok Build',
            selected: true,
          },
          { id: 'low', category: 'mode', label: 'Low', selected: false },
          { id: 'high', category: 'mode', label: 'High', selected: true },
        ],
      },
    },
  },
};

const legacySessionResponse = structuredClone(sessionResponse);
delete legacySessionResponse.result.configOptions;

const modelSnapshot = {
  jsonrpc: '2.0',
  method: '_x.ai/models/update',
  params: {
    currentModelId: 'grok-4.6',
    availableModels: [
      {
        modelId: 'grok-4.6',
        name: 'Grok 4.6',
        description: "SpaceXAI's latest frontier model",
        _meta: {
          reasoningEffort: 'high',
          reasoningEfforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }],
        },
      },
      {
        modelId: 'grok-4.5',
        name: 'Grok 4.5',
        _meta: {
          reasoningEffort: 'high',
          reasoningEfforts: [{ id: 'high' }, { id: 'medium' }, { id: 'low' }],
        },
      },
      { modelId: 'kimi-k3', name: 'Kimi K3' },
    ],
  },
};

function initializeProxy(proxy, version = '1.0.46') {
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: 1 },
  });
  proxy.handleRuntime({ jsonrpc: '2.0', id: 'init', result: { _meta: { agentVersion: version } } });
  return proxy;
}

function readyProxy(runtimeResponse = sessionResponse) {
  const proxy = initializeProxy(new GrokAcpCompatibilityProxy());
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const startup = proxy.handleRuntime(runtimeResponse);
  return { proxy, startup, response: startup.toClient[0] };
}

test('scheduled task lifecycle preserves identity, replay metadata and recurring fires', () => {
  const { proxy } = readyProxy();
  const event = (kind, fields = {}, replay = false) => ({
    jsonrpc: '2.0',
    method: replay ? '_x.ai/session_notification' : `_x.ai/scheduled_task_${kind}`,
    params: {
      sessionId: 'grok-session',
      _meta: { isReplay: replay, providerMarker: 'retained' },
      update: {
        sessionUpdate: `scheduled_task_${kind}`,
        task_id: 'job-1',
        ...(kind === 'deleted' ? {} : { prompt: 'Check CI', human_schedule: 'every 5 minutes', next_fire_at: null }),
        ...fields,
      },
    },
  });
  const tasks = [];
  for (const message of [
    event('created', {}, true),
    event('fired', { next_fire_at: '2026-09-29T10:05:00Z', subagent_id: 'child-1' }),
    event('fired', { subagent_id: 'child-2' }),
    event('created', { prompt: 'Check updated CI' }),
    event('deleted', { reason: 'expired' }),
  ]) {
    const result = proxy.handleRuntime(message);
    assert.deepEqual(result.toRuntime, []);
    assert.equal(result.toClient.length, 1);
    const normalized = result.toClient[0];
    assert.equal(normalized.method, 'session/update');
    assert.deepEqual(normalized.params._meta, message.params._meta);
    assert.equal(normalized.params.sessionId, 'grok-session');
    const update = normalized.params.update;
    assert.equal(isLodySubagentOutput(update), true);
    assert.equal(update.sessionUpdate, 'tool_call_update');
    assert.equal(update.toolCallId, 'grok-scheduled:job-1');
    assert.equal(update._meta.lody.task.kind, 'scheduled');
    assert.equal(update._meta.lody.task.taskId, update.toolCallId);
    tasks.push(update._meta.lody.task);
  }
  assert.deepEqual(tasks.map((task) => task.status), ['pending', 'in_progress', 'in_progress', 'pending', 'completed']);
  assert.equal(tasks[3].description, 'Check updated CI (every 5 minutes)');
  assert.equal(tasks[4].summary, 'Schedule removed (expired)');
  assert.deepEqual(proxy.handleRuntime(event('deleted', { reason: 'shutdown' })).toClient, []);
  for (const reason of ['completed', 'deleted', undefined]) {
    const normalized = proxy.handleRuntime(event('deleted', { reason }, true)).toClient[0];
    assert.equal(normalized.params.update._meta.lody.task.status, 'completed');
  }
  for (const invalid of [
    { ...event('created'), params: { ...event('created').params, sessionId: 'foreign-session' } },
    event('created', { task_id: '' }),
    event('created', { task_id: 123 }),
    event('created', { prompt: null }),
    event('fired', { human_schedule: null }),
    { ...event('created'), method: '_unrelated/notification' },
    { ...event('created'), method: '_x.ai/scheduled_task_deleted' },
  ]) {
    assert.deepEqual(proxy.handleRuntime(invalid).toClient, [invalid]);
  }
});

test('restoring schedule replay is translated before the session response, without admitting other sessions', () => {
  for (const method of ['session/load', 'session/resume']) {
    const proxy = new GrokAcpCompatibilityProxy();
    proxy.handleClient({ id: 'restore', method, params: { sessionId: 'restoring', cwd: '/tmp/project', mcpServers: [] } });
    const replay = {
      method: '_x.ai/session_notification',
      params: {
        sessionId: 'restoring', _meta: { isReplay: true },
        update: { sessionUpdate: 'scheduled_task_created', task_id: 'job', prompt: 'Check CI', human_schedule: 'every 5 minutes' },
      },
    };
    const translated = proxy.handleRuntime(replay).toClient[0];
    assert.equal(translated.params.update._meta.lody.task.status, 'pending');
    assert.equal(translated.params._meta.isReplay, true);
    const foreign = { ...replay, params: { ...replay.params, sessionId: 'foreign' } };
    assert.deepEqual(proxy.handleRuntime(foreign).toClient, [foreign]);
    proxy.handleRuntime({ id: 'restore', error: { code: -32603, message: 'Restore failed' } });
    assert.deepEqual(proxy.handleRuntime(replay).toClient, [replay]);
  }
});

test('maps only canonical Grok scheduler identities without rewriting interval inputs or failures', () => {
  const { proxy } = readyProxy();
  for (const [name, canonical] of [
    ['scheduler_create', 'CronCreate'], ['scheduler_delete', 'CronDelete'], ['scheduler_list', 'CronList'],
  ]) {
    for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
      const message = {
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: 'grok-session',
          update: {
            sessionUpdate, toolCallId: 'tool-1', title: 'Display title', status: 'failed',
            rawInput: { interval: '90m', prompt: 'Check CI' }, rawOutput: { error: 'Rejected' },
            _meta: { 'x.ai/tool': { version: 1, namespace: 'grok_build', name }, lody: { turnId: 'turn-1' } },
          },
        },
      };
      const expected = structuredClone(message);
      expected.params.update._meta.lody.toolName = canonical;
      assert.deepEqual(proxy.handleRuntime(message).toClient, [expected]);
      for (const native of [undefined, { version: 2, namespace: 'grok_build', name }, { version: 1, namespace: 'mcp', name }]) {
        const unknown = structuredClone(message);
        unknown.params.update._meta['x.ai/tool'] = native;
        unknown.params.update.title = name;
        assert.deepEqual(proxy.handleRuntime(unknown).toClient, [unknown]);
      }
    }
  }
});

test('normalizes nested child streams, cumulative tool arguments, progress and fresh attempts only after negotiation', () => {
  const { proxy } = readyProxy();
  const vendor = (sessionId, update) => ({
    jsonrpc: '2.0',
    method: '_x.ai/session_notification',
    params: { sessionId, update },
  });
  const spawn = vendor('grok-session', {
    sessionUpdate: 'subagent_spawned',
    subagent_id: 'child',
    child_session_id: 'child',
    parent_session_id: 'grok-session',
    subagent_type: 'explore',
    description: 'Inspect',
    attempt_id: 'one',
  });
  assert.deepEqual(proxy.handleRuntime(spawn).toClient, [spawn]);
  proxy.handleClient({
    id: 90,
    method: 'initialize',
    params: { clientCapabilities: { _meta: { lody: { subagentEvents: { version: 1 } } } } },
  });
  const events = [];
  const send = (message) => {
    const output = proxy.handleRuntime(message).toClient;
    events.push(
      ...output
        .filter((item) => item.method === '_lody/subagents/event')
        .map((item) => item.params),
    );
    return output;
  };
  send(spawn);
  const first = events[0].runId;
  send(
    vendor('child', {
      sessionUpdate: 'subagent_spawned',
      subagent_id: 'nested',
      child_session_id: 'nested',
      parent_session_id: 'child',
      description: 'Nested',
    }),
  );
  assert.equal(events.at(-1).snapshot.parentRunId, first);
  send({
    method: 'session/update',
    params: {
      sessionId: 'child',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } },
    },
  });
  send(
    vendor('child', {
      sessionUpdate: 'tool_call_delta_chunk',
      tool_call_id: 'tool',
      tool_index: 0,
      name: 'read',
      arguments_delta: '{"path":',
    }),
  );
  send(
    vendor('child', {
      sessionUpdate: 'tool_call_delta_chunk',
      tool_call_id: 'tool',
      tool_index: 0,
      arguments_delta: '"a"}',
    }),
  );
  assert.equal(events.at(-1).update.rawInput, '{"path":"a"}');
  const [permission] = send({
    id: 12,
    method: 'session/request_permission',
    params: { sessionId: 'child', toolCall: { toolCallId: 'tool' }, options: [] },
  });
  assert.equal(permission.params.sessionId, 'grok-session');
  assert.equal(permission.params._meta.lody.subagentRunId, first);
  send(
    vendor('grok-session', {
      sessionUpdate: 'subagent_progress',
      child_session_id: 'child',
      attempt_id: 'one',
      tokens_used: 42,
      tool_call_count: 2,
      tools_used: ['read'],
    }),
  );
  assert.deepEqual(events.at(-1).progress, {
    toolCallCount: 2,
    contextTokens: 42,
    toolsUsed: ['read'],
  });
  send(
    vendor('grok-session', {
      sessionUpdate: 'subagent_finished',
      child_session_id: 'child',
      attempt_id: 'one',
      status: 'completed',
      output: 'Done',
      tool_calls: 5,
      turns: 3,
    }),
  );
  assert.equal(events.at(-1).snapshot.state, 'completed');
  assert.deepEqual(events.at(-2).progress, { toolCallCount: 5, turnCount: 3 });
  assert.deepEqual(
    send({
      method: 'session/update',
      params: {
        sessionId: 'child',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
      },
    }),
    [],
  );
  send({
    ...spawn,
    params: { ...spawn.params, update: { ...spawn.params.update, attempt_id: 'two' } },
  });
  assert.notEqual(events.at(-1).runId, first);
  assert.deepEqual(
    send(
      vendor('grok-session', {
        sessionUpdate: 'subagent_finished',
        child_session_id: 'child',
        attempt_id: 'one',
        status: 'failed',
      }),
    ),
    [],
  );
  assert.ok(events.every(isLodySubagentEvent));
  for (const status of ['failed', 'cancelled', 'unrecognized']) {
    send({
      ...spawn,
      params: { ...spawn.params, update: { ...spawn.params.update, attempt_id: status } },
    });
    send(vendor('grok-session', {
      sessionUpdate: 'subagent_finished',
      child_session_id: 'child',
      attempt_id: status,
      status,
    }));
    const snapshot = events.at(-1).snapshot;
    assert.equal(snapshot.state, status === 'unrecognized' ? 'unknown' : status);
    assert.equal(snapshot.outputIncomplete, status === 'unrecognized' ? true : undefined);
    assert.ok(isLodySubagentEvent(events.at(-1)));
  }
});

const promptUsage = {
  inputTokens: 1_000,
  outputTokens: 250,
  cachedReadTokens: 300,
  cacheCreationTokens: 100,
  reasoningTokens: 50,
  costUsdTicks: 250_000_000,
  modelUsage: {
    'grok-build': {
      inputTokens: 1_000,
      outputTokens: 250,
      cachedReadTokens: 300,
      cacheCreationTokens: 100,
      reasoningTokens: 50,
      costUsdTicks: 250_000_000,
    },
  },
  numTurns: 1,
  usageIsIncomplete: false,
};

test('adapts the official runtime wire contract', () => {
  assert.deepEqual(
    {
      sessionUpdateNotification: runtimeManifest.privateWireContract.sessionUpdateNotification,
      modelsUpdateNotification: runtimeManifest.privateWireContract.modelsUpdateNotification,
      turnCompletedUpdate: runtimeManifest.privateWireContract.turnCompletedUpdate,
      sessionInfoRequest: runtimeManifest.privateWireContract.sessionInfoRequest,
      billingRequest: runtimeManifest.privateWireContract.billingRequest,
      userMessageEchoCapability: runtimeManifest.privateWireContract.userMessageEchoCapability,
    },
    {
      sessionUpdateNotification: 'x.ai/session/update',
      modelsUpdateNotification: 'x.ai/models/update',
      turnCompletedUpdate: 'turn_completed',
      sessionInfoRequest: 'x.ai/session/info',
      billingRequest: 'x.ai/billing',
      userMessageEchoCapability: 'x.ai/userMessageEcho',
    }
  );
  const { response } = readyProxy();
  assert.deepEqual(
    response.result.configOptions.map((option) => option.id),
    ['plan_mode', 'permission_mode', 'model', 'reasoning_effort']
  );
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort').currentValue,
    'high'
  );
  assert.deepEqual(
    response.result.configOptions
      .find((option) => option.id === 'permission_mode')
      .options.map((option) => option.value),
    ['ask', 'auto', 'always-approve']
  );
  assert.deepEqual(
    response.result.configOptions.find((option) => option.id === 'plan_mode')?.type,
    'boolean'
  );
});

test('requests native turn boundaries without dropping client capabilities', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const initialize = proxy.handleClient({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        plan: {},
        _meta: { existingCapability: true, 'x.ai/userMessageEcho': true },
      },
    },
  }).toRuntime[0];

  assert.equal(initialize.params.protocolVersion, 1);
  assert.deepEqual(initialize.params.clientCapabilities.plan, {});
  assert.deepEqual(initialize.params.clientCapabilities._meta, {
    existingCapability: true,
    'x.ai/userMessageEcho': true,
  });
});

test('settles an initial one-model response with the late complete model snapshot', () => {
  const proxy = new GrokAcpCompatibilityProxy({
    deferSessionResponseUntilModelSnapshot: true,
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });

  const provisional = proxy.handleRuntime({
    ...sessionResponse,
    result: {
      ...sessionResponse.result,
      models: {
        currentModelId: 'grok-4.5',
        availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5' }],
      },
    },
  });
  assert.deepEqual(provisional.toClient, []);
  assert.deepEqual(provisional.deferredSessionResponseIds, [1]);

  const settled = proxy.handleRuntime(modelSnapshot);
  assert.equal(settled.toClient.length, 1);
  assert.deepEqual(settled.settledSessionResponseIds, [1]);
  assert.equal(settled.toClient[0].id, 1);
  assert.deepEqual(
    settled.toClient[0].result.models.availableModels.map((model) => model.modelId),
    ['grok-4.6', 'grok-4.5', 'kimi-k3']
  );
  assert.deepEqual(
    settled.toClient[0].result.configOptions
      .find((option) => option.id === 'model')
      .options.map((option) => option.value),
    ['grok-4.6', 'grok-4.5', 'kimi-k3']
  );
  assert.deepEqual(
    settled.toClient[0].result.configOptions
      .find((option) => option.id === 'reasoning_effort')
      .options.map((option) => option.value),
    ['xhigh', 'high', 'medium', 'low']
  );
});

test('publishes per-model reasoning-effort ladders on the session response meta', () => {
  const proxy = new GrokAcpCompatibilityProxy({
    deferSessionResponseUntilModelSnapshot: true,
  });
  assert.deepEqual(proxy.handleRuntime(modelSnapshot), { toRuntime: [], toClient: [] });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const settled = proxy.handleRuntime(sessionResponse).toClient[0];
  assert.deepEqual(settled.result._meta.lody.modelReasoningEfforts, {
    'grok-4.6': ['xhigh', 'high', 'medium', 'low'],
    'grok-4.5': ['high', 'medium', 'low'],
  });
});

test('uses a complete model snapshot that arrives before session/new returns', () => {
  const proxy = new GrokAcpCompatibilityProxy({
    deferSessionResponseUntilModelSnapshot: true,
  });
  assert.deepEqual(proxy.handleRuntime(modelSnapshot), { toRuntime: [], toClient: [] });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });

  const startup = proxy.handleRuntime(sessionResponse);
  assert.equal(startup.deferredSessionResponseIds, undefined);
  assert.deepEqual(
    startup.toClient[0].result.models.availableModels.map((model) => model.modelId),
    ['grok-4.6', 'grok-4.5', 'kimi-k3']
  );
});

test('does not invent an empty models object when a session response omits models', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp/project', mcpServers: [] },
  });

  const startup = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 1,
    result: { sessionId: 'modeless-session' },
  });
  assert.equal(startup.toClient[0].result.models, undefined);
});

test('suppresses duplicate complete model snapshots', () => {
  const { proxy } = readyProxy();

  const first = proxy.handleRuntime(modelSnapshot);
  assert.equal(first.toClient.length, 1);
  assert.deepEqual(proxy.handleRuntime(modelSnapshot), { toRuntime: [], toClient: [] });
});

test('flushes on the bounded fallback and translates a still-later snapshot to standard ACP', () => {
  const proxy = new GrokAcpCompatibilityProxy({
    deferSessionResponseUntilModelSnapshot: true,
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  proxy.handleRuntime(sessionResponse);

  const fallback = proxy.flushPendingSessionResponse(1);
  assert.deepEqual(
    fallback.toClient[0].result.models.availableModels.map((model) => model.modelId),
    ['grok-build']
  );

  const updated = proxy.handleRuntime(modelSnapshot);
  assert.equal(updated.toClient.length, 1);
  assert.equal(updated.toClient[0].jsonrpc, '2.0');
  assert.equal(updated.toClient[0].method, 'session/update');
  assert.equal(updated.toClient[0].params.sessionId, 'grok-session');
  assert.equal(updated.toClient[0].params.update.sessionUpdate, 'config_option_update');
  assert.deepEqual(
    updated.toClient[0].params.update.configOptions
      .find((option) => option.id === 'model')
      .options.map((option) => option.value),
    ['grok-4.6', 'grok-4.5', 'kimi-k3']
  );
});

test('maps every permission mode to the official notification contract', () => {
  assert.deepEqual(permissionNotification(clientIdentifier, 'ask').params, {
    clientIdentifier,
    permission_mode: 'ask',
    yolo_mode: false,
    auto_mode: false,
  });
  assert.deepEqual(permissionNotification(clientIdentifier, 'auto').params, {
    clientIdentifier,
    permission_mode: 'auto',
    yolo_mode: false,
    auto_mode: true,
  });
  assert.deepEqual(permissionNotification(clientIdentifier, 'always-approve').params, {
    clientIdentifier,
    permission_mode: 'always-approve',
    yolo_mode: true,
    auto_mode: false,
  });
});

test('applies initial always-approve before forwarding session/new', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: {
        clientIdentifier,
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    },
  });

  assert.equal(output.toRuntime.length, 1);
  assert.deepEqual(output.toRuntime[0].params._meta, {
    clientIdentifier,
    yoloMode: true,
    autoMode: false,
  });
  const response = proxy.handleRuntime(sessionResponse).toClient[0];
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('applies initial always-approve to restored sessions', () => {
  for (const method of ['session/load', 'session/resume']) {
    const proxy = new GrokAcpCompatibilityProxy();
    const output = proxy.handleClient({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        sessionId: 'grok-session',
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: {
          clientIdentifier,
          lody: {
            sessionConfig: {
              version: 1,
              configOptionValues: { permission_mode: 'always-approve' },
            },
          },
        },
      },
    });
    assert.equal(output.toRuntime.length, 1);
    assert.equal(output.toRuntime[0].params._meta.yoloMode, true);
    assert.equal(output.toRuntime[0].params._meta.autoMode, false);
    assert.equal(output.toRuntime[0].params._meta.lody, undefined);
  }
});

test('seeds all permission flags on new/load/resume without pre-session notifications', () => {
  for (const method of ['session/new', 'session/load', 'session/resume']) {
    for (const mode of ['ask', 'auto', 'always-approve']) {
      const proxy = initializeProxy(new GrokAcpCompatibilityProxy());
      const output = proxy.handleClient({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          sessionId: 'grok-session',
          cwd: '/tmp/project',
          mcpServers: [],
          _meta: {
            clientIdentifier,
            yoloMode: true,
            autoMode: true,
            retained: 'native',
            lody: {
              other: 'kept',
              sessionConfig: { version: 1, configOptionValues: { permission_mode: mode } },
            },
          },
        },
      });
      assert.equal(output.toRuntime.length, 1);
      const forwarded = output.toRuntime[0];
      assert.equal(forwarded.method, method);
      assert.equal(forwarded.params._meta.yoloMode, mode === 'always-approve');
      assert.equal(forwarded.params._meta.autoMode, mode === 'auto');
      assert.equal(forwarded.params._meta.retained, 'native');
      assert.deepEqual(forwarded.params._meta.lody, { other: 'kept' });
      const response = proxy.handleRuntime(sessionResponse).toClient[0];
      assert.equal(
        response.result.configOptions.find((o) => o.id === 'permission_mode').currentValue,
        mode
      );
      const permission = permissionRequest();
      const decision = proxy.handleRuntime(permission);
      if (mode === 'always-approve') assertAutomatic(decision, 'single-use');
      else assert.deepEqual(decision.toClient, [permission]);
    }
  }
});

test('optimistically syncs permission modes over the private extension notification', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  assert.equal(output.toRuntime.length, 1);
  assert.equal(output.toRuntime[0].method, '_x.ai/yolo_mode_changed');
  assert.equal(output.toRuntime[0].params.clientIdentifier, clientIdentifier);
  assert.equal(
    output.toClient[0].result.configOptions.find((option) => option.id === 'permission_mode')
      .currentValue,
    'always-approve'
  );
});

test('rejects unknown permission selections without changing the active permission mode', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'always-approve');
  const output = setPermission(proxy, 'unknown');
  assert.equal(output.toRuntime.length, 0);
  assert.ok(output.toClient[0].error);
  assert.equal(proxy.handleRuntime(permissionRequest()).toClient.length, 0);
});

function setPermission(proxy, value) {
  return proxy.handleClient({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'permission_mode', value },
  });
}

test('Auto is version-gated and never silently restored as another permission policy', () => {
  for (const version of [undefined, '1.0.13', '1.0.40', '1.0.45', '1.0.46-beta', 'invalid']) {
    const { proxy } = readyProxy();
    initializeProxy(proxy, version === undefined ? null : version);
    const option = proxy
      .configOptions(proxy.sessions.get('grok-session'))
      .find((o) => o.id === 'permission_mode');
    assert.deepEqual(
      option.options.map((o) => o.value),
      ['ask', 'always-approve']
    );
    setPermission(proxy, 'always-approve');
    const rejected = setPermission(proxy, 'auto');
    assert.equal(rejected.toRuntime.length, 0);
    assert.match(rejected.toClient[0].error.message, /1\.0\.46/);
    assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
    for (const method of ['session/new', 'session/load', 'session/resume', 'session/fork']) {
      const output = proxy.handleClient({
        id: 3,
        method,
        params: {
          sessionId: 'grok-session',
          cwd: '/tmp/project',
          mcpServers: [],
          _meta: {
            clientIdentifier,
            lody: {
              sessionConfig: { version: 1, configOptionValues: { permission_mode: 'auto' } },
            },
          },
        },
      });
      assert.equal(output.toRuntime.length, 0, 'must reject before native creation or fork copy');
      assert.match(output.toClient[0].error.message, /1\.0\.46/);
    }
  }
  for (const version of ['1.0.46', '1.0.47', '1.1.0', '2.0.0']) {
    const { proxy } = readyProxy();
    initializeProxy(proxy, version);
    assert.equal(setPermission(proxy, 'auto').toRuntime[0].params.auto_mode, true);
  }
});

test('switching YOLO to Auto stops adapter approvals and preserves native decisions and client replies', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'always-approve');
  assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
  const selected = setPermission(proxy, 'auto');
  assert.deepEqual(selected.toRuntime, [permissionNotification(clientIdentifier, 'auto')]);
  const option = selected.toClient[0].result.configOptions.find((o) => o.id === 'permission_mode');
  assert.equal(option.currentValue, 'auto');
  assert.match(option.description, /not a runtime confirmation/);
  // Every request remaining after Grok's classifier stays interactive, even
  // if it offers allow_once/allow_always or collides with a pending client id.
  proxy.handleClient({
    id: 77,
    method: 'session/prompt',
    params: { sessionId: 'grok-session', prompt: [] },
  });
  for (const kind of ['edit', 'execute', 'switch_mode']) {
    const permission = permissionRequest();
    permission.params.toolCall.kind = kind;
    assert.deepEqual(proxy.handleRuntime(permission), { toRuntime: [], toClient: [permission] });
    assert.equal(proxy.pending.get(77).kind, 'prompt');
  }
  const reply = {
    jsonrpc: '2.0',
    id: 77,
    result: { outcome: { outcome: 'selected', optionId: 'reject' } },
  };
  assert.deepEqual(proxy.handleClient(reply), { toRuntime: [reply], toClient: [] });
  const denied = {
    method: 'session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'blocked',
        status: 'failed',
        rawOutput: 'Auto mode blocked this action',
      },
    },
  };
  assert.deepEqual(proxy.handleRuntime(denied).toClient, [denied]);
  setPermission(proxy, 'ask');
  assert.deepEqual(proxy.handleRuntime(permissionRequest()).toClient, [permissionRequest()]);
  setPermission(proxy, 'always-approve');
  assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
});

test('Auto selections remain client-scoped and reseed replacement sessions including explicit false', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'auto');
  for (const [owner, expected] of [
    [clientIdentifier, 'auto'],
    ['lody:other', 'ask'],
  ]) {
    const output = proxy.handleClient({
      id: 10,
      method: 'session/new',
      params: {
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: { clientIdentifier: owner, yoloMode: true, autoMode: true },
      },
    });
    assert.equal(output.toRuntime[0].params._meta.yoloMode, false);
    assert.equal(output.toRuntime[0].params._meta.autoMode, expected === 'auto');
    const response = proxy.handleRuntime({
      ...sessionResponse,
      id: 10,
      result: { ...sessionResponse.result, sessionId: owner },
    });
    assert.equal(
      response.toClient[0].result.configOptions.find((o) => o.id === 'permission_mode')
        .currentValue,
      expected
    );
  }
});

test('Auto requires a client owner before creating or copying a session', () => {
  const proxy = initializeProxy(new GrokAcpCompatibilityProxy());
  for (const method of ['session/new', 'session/load', 'session/resume', 'session/fork']) {
    const output = proxy.handleClient({
      id: 1,
      method,
      params: {
        sessionId: 'source',
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: {
          lody: { sessionConfig: { version: 1, configOptionValues: { permission_mode: 'auto' } } },
        },
      },
    });
    assert.equal(output.toRuntime.length, 0);
    assert.match(output.toClient[0].error.message, /clientIdentifier/);
  }
});

test('Auto survives Plan and model changes while questions and plan approval remain explicit', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'auto');
  for (const [configId, value] of [
    ['plan_mode', true],
    ['model', 'grok-build'],
  ]) {
    const request = proxy.handleClient({
      id: 20,
      method: 'session/set_config_option',
      params: {
        sessionId: 'grok-session',
        configId,
        value,
      },
    });
    const response = proxy.handleRuntime({ id: request.toRuntime[0].id, result: {} });
    assert.equal(
      response.toClient[0].result.configOptions.find((o) => o.id === 'permission_mode')
        .currentValue,
      'auto'
    );
  }
  const question = {
    id: 20,
    method: 'elicitation/create',
    params: { sessionId: 'grok-session', message: 'Synthetic question' },
  };
  assert.deepEqual(proxy.handleRuntime(question).toClient, [question]);
  const review = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 21,
    method: '_x.ai/exit_plan_mode',
    params: {
      sessionId: 'grok-session',
      toolCallId: 'plan-auto',
      planContent: 'Synthetic plan',
    },
  });
  assert.equal(review.toRuntime.length, 0);
  assert.equal(review.toClient.at(-1).method, 'session/request_permission');
  assert.equal(review.toClient.at(-1).params.toolCall.kind, 'switch_mode');
});

function permissionRequest(
  options = [
    { optionId: 'persistent', name: 'Yes for future calls', kind: 'allow_always' },
    { optionId: 'single-use', name: 'Yes', kind: 'allow_once' },
    { optionId: 'reject', name: 'No', kind: 'reject_once' },
  ]
) {
  return {
    jsonrpc: '2.0',
    id: 77,
    method: 'session/request_permission',
    params: {
      sessionId: 'grok-session',
      toolCall: { toolCallId: 'synthetic-tool', title: 'Write file', kind: 'edit' },
      options,
    },
  };
}

function assertAutomatic(output, optionId, id = 77) {
  assert.deepEqual(output, {
    toRuntime: [
      {
        jsonrpc: '2.0',
        id,
        result: { outcome: { outcome: 'selected', optionId } },
      },
    ],
    toClient: [],
  });
}

test('YOLO approves once without forwarding a permission request to the client', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'always-approve');
  assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
  assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
  setPermission(proxy, 'ask');
  const request = permissionRequest();
  assert.deepEqual(proxy.handleRuntime(request), { toRuntime: [], toClient: [request] });
});

test('YOLO selects AllowAlways when it is the only allow kind', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'always-approve');
  const request = permissionRequest([
    { optionId: 'reject', name: 'No', kind: 'reject_once' },
    { optionId: 'persistent', name: 'Yes', kind: 'allow_always' },
  ]);
  assertAutomatic(proxy.handleRuntime(request), 'persistent');
});

test('startup YOLO enables the fallback without a live config setter', () => {
  for (const method of ['session/new', 'session/load', 'session/resume']) {
    const proxy = new GrokAcpCompatibilityProxy();
    proxy.handleClient({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: {
          clientIdentifier,
          lody: {
            sessionConfig: {
              version: 1,
              configOptionValues: { permission_mode: 'always-approve' },
            },
          },
        },
      },
    });
    proxy.handleRuntime(sessionResponse);
    assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
  }
});

test('YOLO leaves questions, unknown sessions, and requests without usable allow kinds interactive', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'always-approve');
  const question = permissionRequest();
  question.params._meta = { lody: { elicitation: { version: 1, questions: [] } } };
  const modeSwitch = permissionRequest();
  modeSwitch.params.toolCall.kind = 'switch_mode';
  const unknownSession = permissionRequest();
  unknownSession.params.sessionId = 'other-session';
  const notification = permissionRequest();
  delete notification.id;
  for (const request of [
    question,
    modeSwitch,
    unknownSession,
    notification,
    permissionRequest([{ optionId: 'disallow', name: 'Allow', kind: 'reject_once' }]),
    permissionRequest([{ name: 'Yes', kind: 'allow_once' }]),
    permissionRequest([]),
    permissionRequest(null),
  ]) {
    assert.deepEqual(proxy.handleRuntime(request), { toRuntime: [], toClient: [request] });
  }
});

test('YOLO does not approve requests for another known client in Ask mode', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'always-approve');
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 9,
    method: 'session/new',
    params: { cwd: '/tmp/other', mcpServers: [], _meta: { clientIdentifier: 'lody:other' } },
  });
  proxy.handleRuntime({
    ...sessionResponse,
    id: 9,
    result: { ...sessionResponse.result, sessionId: 'other' },
  });
  const request = permissionRequest();
  request.params.sessionId = 'other';
  assert.deepEqual(proxy.handleRuntime(request), { toRuntime: [], toClient: [request] });
  assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
});

test('reverse permission IDs do not consume a pending client request with the same ID', () => {
  const { proxy } = readyProxy();
  setPermission(proxy, 'always-approve');
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 77,
    method: 'session/prompt',
    params: { sessionId: 'grok-session', prompt: [] },
  });
  assertAutomatic(proxy.handleRuntime(permissionRequest()), 'single-use');
  const response = { jsonrpc: '2.0', id: 77, result: { stopReason: 'end_turn' } };
  assert.ok(proxy.handleRuntime(response).toClient.some((message) => message.id === 77));
});

test('passes Grok native ACP permission requests and responses through unchanged', () => {
  const { proxy } = readyProxy();
  const request = {
    jsonrpc: '2.0',
    id: 77,
    method: 'session/request_permission',
    params: {
      sessionId: 'grok-session',
      toolCall: { toolCallId: 'write-1', title: 'Write file', kind: 'edit' },
      options: [
        { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
      ],
    },
  };
  assert.deepEqual(proxy.handleRuntime(request), { toRuntime: [], toClient: [request] });

  const response = {
    jsonrpc: '2.0',
    id: 77,
    result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
  };
  assert.deepEqual(proxy.handleClient(response), { toRuntime: [response], toClient: [] });
});

test('safely degrades a legacy Ask interaction selection to Plan across response ordering', () => {
  const { proxy } = readyProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 31,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'interaction_mode', value: 'ask' },
  }).toRuntime[0];
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 31,
    method: 'session/set_mode',
    params: { sessionId: 'grok-session', modeId: 'plan' },
  });
  proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'grok-session',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    },
  });
  const modeResponse = proxy.handleRuntime({ jsonrpc: '2.0', id: 31, result: {} }).toClient[0];
  assert.equal(
    modeResponse.result.configOptions.find((option) => option.id === 'plan_mode').currentValue,
    true
  );
  const response = proxy.handleClient({
    jsonrpc: '2.0',
    id: 32,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'low' },
  });
  const configResponse = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 32,
    result: {},
  }).toClient[0];
  assert.equal(
    configResponse.result.configOptions.find((option) => option.id === 'plan_mode').currentValue,
    true
  );
  assert.equal(response.toRuntime[0].method, 'session/set_config_option');
});

test('forwards reasoning effort through the native 1.0.34 config option', () => {
  const { proxy } = readyProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 4,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'reasoning_effort',
      value: 'low',
    },
  }).toRuntime[0];
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 4,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'reasoning_effort',
      value: 'low',
    },
  });
  const response = proxy.handleRuntime({ jsonrpc: '2.0', id: 4, result: {} }).toClient[0];
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort').currentValue,
    'low'
  );
});

test('preserves a real reasoning value that is not a selectable option', () => {
  const responseWithMax = structuredClone(sessionResponse);
  responseWithMax.result.models.availableModels[0]._meta = {
    reasoningEffort: 'high',
    reasoningEfforts: [{ id: 'low' }, { id: 'high' }],
  };
  responseWithMax.result.configOptions.find(
    (option) => option.id === 'reasoning_effort'
  ).currentValue = 'max';
  const { proxy, response } = readyProxy(responseWithMax);
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort').currentValue,
    'max'
  );

  const refreshed = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/models/update',
    params: {
      currentModelId: 'grok-build',
      availableModels: structuredClone(responseWithMax.result.models.availableModels),
    },
  }).toClient[0];
  assert.equal(
    refreshed.params.update.configOptions.find((option) => option.id === 'reasoning_effort')
      .currentValue,
    'max'
  );

  const runtimeOptions = structuredClone(sessionResponse.result.configOptions);
  runtimeOptions.find((option) => option.id === 'reasoning_effort').currentValue = 'none';
  const update = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'grok-session',
      update: { sessionUpdate: 'config_option_update', configOptions: runtimeOptions },
    },
  }).toClient[0];
  assert.equal(
    update.params.update.configOptions.find((option) => option.id === 'reasoning_effort')
      .currentValue,
    'none'
  );

  const rejected = proxy.handleClient({
    jsonrpc: '2.0',
    id: 40,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'none' },
  });
  assert.deepEqual(rejected.toRuntime, []);
  assert.match(rejected.toClient[0].error.message, /Unsupported Grok reasoning effort/);
});

test('preserves native config errors without applying optimistic state', () => {
  const { proxy } = readyProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 38,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'model', value: 'unknown-model' },
  }).toRuntime[0];
  assert.equal(request.method, 'session/set_config_option');

  const error = {
    jsonrpc: '2.0',
    id: 38,
    error: { code: -32602, message: 'unknown model' },
  };
  assert.deepEqual(proxy.handleRuntime(error).toClient, [error]);

  const reasoning = proxy.handleClient({
    jsonrpc: '2.0',
    id: 39,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'high' },
  });
  assert.equal(reasoning.toClient.length, 0);
  assert.equal(reasoning.toRuntime[0].method, 'session/set_config_option');
});

test('merges native config updates with Lody controls and passes future options through', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 33,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 34,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'plan_mode', value: true },
  });
  proxy.handleRuntime({ jsonrpc: '2.0', id: 34, result: {} });

  const memoryOption = {
    id: 'memory',
    name: 'Memory',
    description: 'Retain context across prompts',
    category: 'other',
    type: 'boolean',
    currentValue: true,
  };
  const nativeOptions = [...sessionResponse.result.configOptions, memoryOption];
  const update = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'grok-session',
      update: { sessionUpdate: 'config_option_update', configOptions: nativeOptions },
    },
  });
  assert.equal(update.toClient.length, 1);
  const merged = update.toClient[0].params.update.configOptions;
  assert.deepEqual(
    merged.map((option) => option.id),
    ['plan_mode', 'permission_mode', 'model', 'reasoning_effort', 'memory']
  );
  assert.equal(merged.find((option) => option.id === 'plan_mode').currentValue, true);
  assert.equal(
    merged.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
  assert.deepEqual(
    merged.find((option) => option.id === 'memory'),
    memoryOption
  );

  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 35,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'memory', value: false },
  }).toRuntime[0];
  assert.deepEqual(request.params, {
    sessionId: 'grok-session',
    configId: 'memory',
    value: false,
  });
  const nativeReplyOptions = nativeOptions.map((option) =>
    option.id === 'memory' ? { ...option, currentValue: false } : option
  );
  const response = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 35,
    result: { applied: true, configOptions: nativeReplyOptions },
  }).toClient[0];
  assert.equal(response.result.applied, true);
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'memory').currentValue,
    false
  );
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('preserves rich reasoning selectors and maps aliases only for the legacy fallback', () => {
  const richModel = {
    modelId: 'grok-rich',
    name: 'Grok Rich',
    _meta: {
      reasoningEffort: 'xhigh',
      reasoningEfforts: [
        {
          id: 'deep',
          value: 'xhigh',
          label: 'Deep',
          description: 'Maximum reasoning',
          default: true,
        },
        { id: 'fast', value: 'low', label: 'Fast' },
      ],
    },
  };
  const nativeResponse = structuredClone(sessionResponse);
  nativeResponse.result.models = {
    currentModelId: 'grok-rich',
    availableModels: [richModel],
  };
  nativeResponse.result.configOptions = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'grok-rich',
      options: [{ value: 'grok-rich', name: 'Grok Rich' }],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'deep',
      options: [
        { value: 'deep', name: 'Deep', description: 'Maximum reasoning' },
        { value: 'fast', name: 'Fast' },
      ],
    },
  ];
  const nativeProxy = new GrokAcpCompatibilityProxy();
  nativeProxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp/project', mcpServers: [], _meta: { clientIdentifier } },
  });
  const nativeStartup = nativeProxy.handleRuntime(nativeResponse).toClient[0];
  const richOption = nativeStartup.result.configOptions.find(
    (option) => option.id === 'reasoning_effort'
  );
  assert.equal(richOption.currentValue, 'deep');
  assert.deepEqual(richOption.options[0], {
    value: 'deep',
    name: 'Deep',
    description: 'Maximum reasoning',
  });
  const nativeRequest = nativeProxy.handleClient({
    jsonrpc: '2.0',
    id: 36,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'deep' },
  }).toRuntime[0];
  assert.equal(nativeRequest.method, 'session/set_config_option');
  assert.equal(nativeRequest.params.value, 'deep');

  const legacyResponse = structuredClone(nativeResponse);
  delete legacyResponse.result.configOptions;
  legacyResponse.result._meta['x.ai/sessionConfig'].options = [
    { id: 'grok-rich', category: 'model', label: 'Grok Rich', selected: true },
    { id: 'deep', category: 'mode', label: 'Deep', selected: true },
    { id: 'fast', category: 'mode', label: 'Fast', selected: false },
  ];
  const legacyProxy = new GrokAcpCompatibilityProxy();
  legacyProxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp/project', mcpServers: [], _meta: { clientIdentifier } },
  });
  legacyProxy.handleRuntime(legacyResponse);
  const legacyRequest = legacyProxy.handleClient({
    jsonrpc: '2.0',
    id: 37,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'deep' },
  }).toRuntime[0];
  assert.equal(legacyRequest.method, 'session/set_model');
  assert.equal(legacyRequest.params.modelId, 'grok-rich');
  assert.deepEqual(legacyRequest.params._meta, { reasoningEffort: 'xhigh' });
});

test('requires the Lody clientIdentifier before changing permissions', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp', mcpServers: [] },
  });
  proxy.handleRuntime(sessionResponse);
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 5,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'ask',
    },
  });
  assert.equal(output.toRuntime.length, 0);
  assert.match(output.toClient[0].error.message, /clientIdentifier/);
});

test('restores optimistic permission state across session reload in the same wrapper', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 6,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 7,
    method: 'session/load',
    params: {
      sessionId: 'grok-session',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const loaded = proxy.handleRuntime({
    ...sessionResponse,
    id: 7,
    result: { ...sessionResponse.result, sessionId: undefined },
  }).toClient[0];
  assert.equal(
    loaded.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('preserves client-scoped permission state for a fresh replacement session', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 8,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 9,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const replacement = proxy.handleRuntime({
    ...sessionResponse,
    id: 9,
    result: { ...sessionResponse.result, sessionId: 'grok-session-2' },
  }).toClient[0];
  assert.equal(
    replacement.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('rebuilds, validates, and forwards reasoning effort against the selected model', () => {
  const { proxy } = readyProxy();
  proxy.handleRuntime(modelSnapshot);
  const modelRequest = proxy.handleClient({
    jsonrpc: '2.0',
    id: 41,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'model', value: 'grok-4.5' },
  }).toRuntime[0];
  assert.equal(modelRequest.method, 'session/set_config_option');
  assert.equal(modelRequest.params.configId, 'model');
  assert.equal(modelRequest.params.value, 'grok-4.5');
  const response = proxy.handleRuntime({ jsonrpc: '2.0', id: modelRequest.id, result: {} })
    .toClient[0];
  const effort = response.result.configOptions.find((option) => option.id === 'reasoning_effort');
  assert.deepEqual(
    effort.options.map((option) => option.value),
    ['high', 'medium', 'low']
  );
  assert.equal(effort.currentValue, 'high');

  const rejected = proxy.handleClient({
    jsonrpc: '2.0',
    id: 42,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'xhigh' },
  });
  assert.deepEqual(rejected.toRuntime, []);
  assert.match(rejected.toClient[0].error.message, /Unsupported Grok reasoning effort/);

  const accepted = proxy.handleClient({
    jsonrpc: '2.0',
    id: 43,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'medium' },
  }).toRuntime[0];
  assert.deepEqual(accepted, {
    jsonrpc: '2.0',
    id: 43,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'reasoning_effort',
      value: 'medium',
    },
  });
});

test('waits for the complete native config update after a private model_changed precursor', () => {
  const { proxy } = readyProxy();
  const precursor = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'model_changed',
        model_id: 'grok-build',
        reasoning_effort: 'low',
      },
    },
  });
  assert.equal(precursor.toRuntime[0].method, '_x.ai/session/info');
  assert.deepEqual(precursor.toClient, []);

  const runtimeOptions = structuredClone(sessionResponse.result.configOptions);
  runtimeOptions.find((option) => option.id === 'reasoning_effort').currentValue = 'low';
  const standard = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'grok-session',
      update: { sessionUpdate: 'config_option_update', configOptions: runtimeOptions },
    },
  });
  assert.equal(standard.toClient.length, 1);
  assert.equal(standard.toClient[0].params.update.sessionUpdate, 'config_option_update');
  assert.equal(
    standard.toClient[0].params.update.configOptions.find(
      (option) => option.id === 'reasoning_effort'
    ).currentValue,
    'low'
  );
});

test('translates the official snake_case model_changed notification for legacy sessions', () => {
  const { proxy } = readyProxy(legacySessionResponse);
  const modelChanged = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'model_changed',
        model_id: 'grok-4',
        reasoning_effort: 'low',
      },
    },
  });
  assert.equal(modelChanged.toRuntime[0].method, '_x.ai/session/info');
  const update = modelChanged.toClient[0];
  assert.equal(update.method, 'session/update');
  assert.equal(update.params.update.sessionUpdate, 'config_option_update');
  assert.equal(
    update.params.update.configOptions.find((option) => option.id === 'reasoning_effort'),
    undefined
  );
  const rejected = proxy.handleClient({
    jsonrpc: '2.0',
    id: 8,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'high' },
  });
  assert.deepEqual(rejected.toRuntime, []);
  assert.match(rejected.toClient[0].error.message, /Unsupported Grok reasoning effort/);
});

test('rebuilds the reasoning-effort ladder when the runtime changes the model', () => {
  const { proxy } = readyProxy(legacySessionResponse);
  proxy.handleRuntime(modelSnapshot);
  const changed = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'model_changed',
        model_id: 'grok-4.5',
        reasoning_effort: 'medium',
      },
    },
  });
  assert.equal(changed.toClient[0].method, 'session/update');
  assert.equal(changed.toClient[0].params.update.sessionUpdate, 'config_option_update');
  assert.equal(
    changed.toClient[0].params.update.configOptions.find(
      (option) => option.id === 'reasoning_effort'
    ).currentValue,
    'medium'
  );

  const rejected = proxy.handleClient({
    jsonrpc: '2.0',
    id: 51,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'xhigh' },
  });
  assert.deepEqual(rejected.toRuntime, []);
  assert.match(rejected.toClient[0].error.message, /Unsupported Grok reasoning effort/);
});

test('withdraws the reasoning-effort control when switching to a model without ladders', () => {
  const { proxy } = readyProxy();
  proxy.handleRuntime(modelSnapshot);
  const modelRequestId = proxy.handleClient({
    jsonrpc: '2.0',
    id: 61,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'model', value: 'kimi-k3' },
  }).toRuntime[0].id;
  const response = proxy.handleRuntime({ jsonrpc: '2.0', id: modelRequestId, result: {} })
    .toClient[0];
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort'),
    undefined
  );
  const rejected = proxy.handleClient({
    jsonrpc: '2.0',
    id: 62,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'medium' },
  });
  assert.deepEqual(rejected.toRuntime, []);
  assert.match(rejected.toClient[0].error.message, /Unsupported Grok reasoning effort/);
});

test('keeps the measured effort across a same-model snapshot refresh', () => {
  const { proxy } = readyProxy();
  proxy.handleRuntime(modelSnapshot);
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 71,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'low' },
  });
  proxy.handleRuntime({ jsonrpc: '2.0', id: 71, result: {} });
  const refreshed = proxy.handleRuntime({
    ...modelSnapshot,
    params: {
      ...modelSnapshot.params,
      availableModels: modelSnapshot.params.availableModels.map((model, index) =>
        index === 0 ? { ...model, name: `${model.name} refreshed` } : model
      ),
    },
  }).toClient[0];
  assert.equal(
    refreshed.params.update.configOptions.find((option) => option.id === 'reasoning_effort')
      .currentValue,
    'low'
  );
});

test('settles a model switch on the target model published default', () => {
  const { proxy } = readyProxy();
  proxy.handleRuntime(modelSnapshot);
  const firstSwitch = proxy.handleClient({
    jsonrpc: '2.0',
    id: 81,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'model', value: 'grok-4.5' },
  }).toRuntime[0];
  proxy.handleRuntime({ jsonrpc: '2.0', id: firstSwitch.id, result: {} });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 82,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'low' },
  });
  proxy.handleRuntime({ jsonrpc: '2.0', id: 82, result: {} });
  const secondSwitch = proxy.handleClient({
    jsonrpc: '2.0',
    id: 83,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'model', value: 'grok-4.6' },
  }).toRuntime[0];
  const response = proxy.handleRuntime({ jsonrpc: '2.0', id: secondSwitch.id, result: {} })
    .toClient[0];
  const effort = response.result.configOptions.find((option) => option.id === 'reasoning_effort');
  // A bare model switch follows the runtime's own semantics: the target
  // model's published default wins — not the previous model's effort, and
  // not the first ladder entry.
  assert.equal(effort.currentValue, 'high');
});

test('keeps the reported ladder through a same-model snapshot without metadata', () => {
  const { proxy } = readyProxy();
  const refreshed = proxy.handleRuntime({
    ...modelSnapshot,
    params: {
      currentModelId: 'grok-build',
      availableModels: [
        { modelId: 'grok-build', name: 'Grok Build' },
        { modelId: 'kimi-k3', name: 'Kimi K3' },
      ],
    },
  }).toClient[0];
  const effort = refreshed.params.update.configOptions.find(
    (option) => option.id === 'reasoning_effort'
  );
  // The session reported this model's own ladder at startup; a roster
  // refresh that keeps the same current model must not withdraw it.
  assert.deepEqual(
    effort.options.map((option) => option.value),
    ['low', 'high']
  );
});

test('normalizes official inclusive token counters into Lody disjoint usage buckets', () => {
  assert.deepEqual(normalizePromptUsage(promptUsage), {
    usage: {
      inputTokens: 600,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      reasoningOutputTokens: 50,
      costUSD: 0.025,
    },
    modelUsage: {
      'grok-build': {
        inputTokens: 600,
        outputTokens: 200,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
        reasoningOutputTokens: 50,
        costUSD: 0.025,
      },
    },
  });
});

test('drops untrustworthy costs while preserving incomplete token usage', () => {
  const normalized = normalizePromptUsage({
    ...promptUsage,
    usageIsIncomplete: true,
    modelUsage: {
      'grok-build': { ...promptUsage.modelUsage['grok-build'], costIsPartial: true },
    },
  });
  assert.equal(normalized.usage.costUSD, undefined);
  assert.equal(normalized.modelUsage['grok-build'].costUSD, undefined);
  assert.equal(normalized.usage.inputTokens, 600);
});

test('emits Lody token usage and requests authoritative context on turn completion', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-1',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
    },
  });

  assert.equal(output.toClient[0].method, '_x.ai/session/update');
  assert.equal(output.toClient[1].method, '_lody/session/usage_update');
  const reported = output.toClient[1].params;
  assert.equal(reported.sessionId, 'grok-session');
  assert.deepEqual(reported.usage, normalizePromptUsage(promptUsage).usage);
  assert.equal(reported.modelUsage['grok-build'].inputTokens, 600);
  assert.deepEqual(reported.delta.modelUsage, reported.modelUsage);
  assert.equal(output.toRuntime.length, 2);
  assert.equal(output.toRuntime[0].method, '_x.ai/session/info');
  assert.deepEqual(output.toRuntime[0].params, { sessionId: 'grok-session' });
  assert.equal(output.toRuntime[1].method, '_x.ai/billing');
  assert.deepEqual(output.toRuntime[1].params, {});
});

test('converts session info context into standard ACP usage_update for the existing UI', () => {
  const { proxy, startup } = readyProxy();
  assert.equal(startup.toRuntime.length, 2);
  assert.equal(startup.toRuntime[0].method, '_x.ai/session/info');

  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: startup.toRuntime[0].id,
    result: {
      result: {
        sessionId: 'grok-session',
        context: { used: 81_920, total: 256_000, freeTokens: 174_080, usagePct: 32 },
      },
    },
  });

  assert.equal(output.toRuntime.length, 0);
  assert.deepEqual(output.toClient, [
    {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'grok-session',
        update: { sessionUpdate: 'usage_update', size: 256_000, used: 81_920 },
      },
    },
  ]);
});

test('accumulates distinct prompts and repairs incomplete-first usage without replaying deltas', () => {
  const { proxy } = readyProxy();
  const complete = (id, usage, replay = false) =>
    proxy
      .handleRuntime({
        jsonrpc: '2.0',
        method: '_x.ai/session/update',
        params: {
          sessionId: 'grok-session',
          _meta: { isReplay: replay },
          update: { sessionUpdate: 'turn_completed', prompt_id: id, usage },
        },
      })
      .toClient.find((message) => message.method === '_lody/session/usage_update')?.params;
  const incomplete = complete('one', { ...promptUsage, usageIsIncomplete: true });
  assert.equal(incomplete.modelUsage['grok-build'].costUSD, undefined);
  const repaired = complete('one', promptUsage);
  assert.equal(repaired.modelUsage['grok-build'].inputTokens, 600);
  assert.equal(repaired.modelUsage['grok-build'].costUSD, 0.025);
  assert.equal(repaired.delta.usage.inputTokens, 0);
  assert.equal(complete('one', promptUsage), undefined);
  assert.equal(complete('history', promptUsage, true), undefined);
  const second = complete('two', promptUsage);
  assert.equal(second.modelUsage['grok-build'].inputTokens, 1200);
  assert.equal(second.modelUsage['grok-build'].costUSD, 0.05);
  assert.equal(second.delta.usage.inputTokens, 600);
  assert.equal(second.usage.inputTokens, 600);
});

test('converts official Grok billing into Lody session rate limits', () => {
  const { proxy, startup } = readyProxy();
  const billingRequest = startup.toRuntime.find((message) => message.method === '_x.ai/billing');
  assert.ok(billingRequest);

  const billing = {
    config: {
      creditUsagePercent: 42.5,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-06-01T00:00:00Z',
        end: '2026-06-08T00:00:00Z',
      },
      onDemandCap: { val: 5_000 },
      onDemandUsed: { val: 300 },
      prepaidBalance: { val: 1_250 },
    },
    on_demand_enabled: true,
    subscription_tier: 'SuperGrok Heavy',
  };
  const expectedRateLimits = [
    {
      planName: 'SuperGrok Heavy',
      limitName: 'Grok Build',
      limitId: 'grok',
      scope: { providerId: 'grok' },
      windows: [
        {
          usedPercent: 42.5,
          windowDurationSeconds: 7 * 24 * 60 * 60,
          resetsAtEpochSeconds: Date.parse('2026-06-08T00:00:00Z') / 1000,
        },
      ],
    },
  ];
  const normalized = normalizeBillingRateLimits(billing);
  assert.deepEqual(normalized.rateLimits, expectedRateLimits);
  assert.equal(typeof normalized.fetchedAtEpochSeconds, 'number');

  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: billingRequest.id,
    result: billing,
  });
  assert.deepEqual(output.toRuntime, []);
  assert.equal(output.toClient[0].method, '_lody/rate_limits/update');
  assert.deepEqual(output.toClient[0].params.rateLimits, expectedRateLimits);
});

test('answers the independent Core rate-limit query without a session', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 91,
    method: '_lody/rate_limits/get',
    params: {},
  });
  assert.equal(request.toRuntime.length, 1);
  assert.equal(request.toRuntime[0].method, '_x.ai/billing');
  assert.deepEqual(request.toRuntime[0].params, {});

  const response = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: request.toRuntime[0].id,
    result: {
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          end: '2026-06-08T00:00:00Z',
        },
      },
      subscription_tier: 'SuperGrok Heavy',
    },
  });
  assert.deepEqual(response.toRuntime, []);
  assert.equal(response.toClient[0].id, 91);
  assert.equal(response.toClient[0].result.rateLimits[0].windows[0].usedPercent, 42.5);
  assert.equal(typeof response.toClient[0].result.fetchedAtEpochSeconds, 'number');
});

test('falls back to legacy Grok billing totals and clears stale limits on billing errors', () => {
  assert.equal(
    normalizeBillingRateLimits({
      config: { monthlyLimit: { val: 2_000 }, used: { val: 500 } },
    }).rateLimits[0].windows[0].usedPercent,
    25
  );

  const { proxy, startup } = readyProxy();
  const billingRequest = startup.toRuntime.find((message) => message.method === '_x.ai/billing');
  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: billingRequest.id,
    error: { code: -32603, message: 'Billing unavailable' },
  });
  assert.deepEqual(output.toRuntime, []);
  assert.equal(output.toClient[0].method, '_lody/rate_limits/update');
  assert.deepEqual(output.toClient[0].params.rateLimits, []);
});

test('matches the official Grok TUI zero-percent fallback for fresh unified billing', () => {
  const snapshot = normalizeBillingRateLimits({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-09T09:12:56Z',
        end: '2026-08-16T09:12:56Z',
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
    },
    subscription_tier: 'X Premium+',
  });
  assert.deepEqual(snapshot.rateLimits, [
    {
      planName: 'X Premium+',
      limitName: 'Grok Build',
      limitId: 'grok',
      scope: { providerId: 'grok' },
      windows: [
        {
          usedPercent: 0,
          windowDurationSeconds: 7 * 24 * 60 * 60,
          resetsAtEpochSeconds: Date.parse('2026-08-16T09:12:56Z') / 1000,
        },
      ],
    },
  ]);
  assert.equal(typeof snapshot.fetchedAtEpochSeconds, 'number');
});

test('keeps genuinely incomplete billing visible without inventing utilization', () => {
  const limits = normalizeBillingRateLimits({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-09T09:12:56Z',
        end: '2026-08-16T09:12:56Z',
      },
      isUnifiedBillingUser: true,
    },
    subscription_tier: 'X Premium+',
  });
  assert.deepEqual(limits.rateLimits, []);
});

test('does not pair historical utilization with the current billing period', () => {
  const limits = normalizeBillingRateLimits({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-16T00:00:00Z',
        end: '2026-08-23T00:00:00Z',
      },
      history: [
        {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-09T00:00:00Z',
          end: '2026-08-16T00:00:00Z',
          creditUsagePercent: 87,
        },
      ],
    },
    subscription_tier: 'SuperGrok',
  });
  assert.deepEqual(limits.rateLimits, []);
});

test('derives utilization from official billing history totals', () => {
  const limits = normalizeBillingRateLimits({
    config: {
      history: [
        {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-09T00:00:00Z',
          end: '2026-08-16T00:00:00Z',
          monthlyLimit: { val: 1_000 },
          totalUsed: { val: 250 },
        },
      ],
    },
    subscription_tier: 'SuperGrok',
  });
  assert.equal(limits.rateLimits[0].windows[0].usedPercent, 25);
  assert.equal(limits.rateLimits[0].windows[0].windowDurationSeconds, 7 * 24 * 60 * 60);
});

test('uses prompt response usage as a fallback and deduplicates turn_completed', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 20,
    method: 'session/prompt',
    params: { sessionId: 'grok-session', prompt: [] },
  });
  const promptResponse = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 20,
    result: {
      stopReason: 'end_turn',
      _meta: { sessionId: 'grok-session', promptId: 'prompt-2', usage: promptUsage },
    },
  });
  assert.equal(promptResponse.toClient[1].method, '_lody/session/usage_update');
  assert.equal(promptResponse.toRuntime[0].method, '_x.ai/session/info');
  assert.equal(promptResponse.toRuntime[1].method, '_x.ai/billing');

  const durableCompletion = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-2',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
    },
  });
  assert.equal(durableCompletion.toClient.length, 1);
  assert.equal(durableCompletion.toRuntime.length, 0);
});

test('does not record or re-query historical usage from replayed completions', () => {
  const { proxy } = readyProxy();
  const replay = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'old-prompt',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
      _meta: { isReplay: true },
    },
  });
  assert.equal(replay.toClient.length, 1);
  assert.equal(replay.toRuntime.length, 0);
});

test('Plan boolean switches preserve Always Approve and reject strings', () => {
  const { proxy } = readyProxy();
  const select = (id, configId, value) =>
    proxy.handleClient({
      jsonrpc: '2.0',
      id,
      method: 'session/set_config_option',
      params: { sessionId: 'grok-session', configId, value },
    });
  select(101, 'permission_mode', 'always-approve');
  for (const [id, value] of [
    [102, true],
    [103, false],
  ]) {
    const request = select(id, 'plan_mode', value).toRuntime[0];
    assert.equal(request.method, 'session/set_mode');
    assert.equal(request.params.modeId, value ? 'plan' : 'default');
    const reply = proxy.handleRuntime({ jsonrpc: '2.0', id, result: {} }).toClient[0];
    const options = reply.result.configOptions;
    assert.equal(options.find((option) => option.id === 'plan_mode').currentValue, value);
    assert.equal(
      options.find((option) => option.id === 'permission_mode').currentValue,
      'always-approve'
    );
  }
  assert.ok(select(104, 'plan_mode', 'true').toClient[0].error);
});

function planReviewProxy(capabilities = { plan: {}, elicitation: { form: {} } }) {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 'init-plan',
    method: 'initialize',
    params: { clientCapabilities: capabilities },
  });
  return proxy;
}
function planRequest(id = 17, wrapped = false, planContent = '# Plan\nTest the behavior') {
  const params = { sessionId: 'grok-session', toolCallId: `plan-${id}`, planContent };
  return {
    jsonrpc: '2.0',
    id,
    method: '_x.ai/exit_plan_mode',
    params: wrapped ? { method: 'x.ai/exit_plan_mode', params } : params,
  };
}
function planAnswer(proxy, optionId, id = 17) {
  return proxy.handleClient({
    jsonrpc: '2.0',
    id,
    result: { outcome: { outcome: 'selected', optionId } },
  });
}

test('publishes a standard plan and explicit decision without changing Always Approve', () => {
  const proxy = planReviewProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 'permission',
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'permission_mode', value: 'always-approve' },
  });
  const output = proxy.handleRuntime(planRequest());
  assert.equal(output.toRuntime.length, 0);
  assert.deepEqual(output.toClient[0].params.update, {
    sessionUpdate: 'plan_update',
    plan: { type: 'markdown', planId: 'plan-17', content: '# Plan\nTest the behavior' },
  });
  const request = output.toClient.at(-1);
  assert.equal(request.method, 'session/request_permission');
  assert.equal(request.params.toolCall.kind, 'switch_mode');
  assert.equal(request.params.toolCall.rawInput.plan, '# Plan\nTest the behavior');
  assert.deepEqual(request.params.toolCall.content, []);
  assert.deepEqual(
    request.params.options.map((o) => o.optionId),
    ['approve', 'revise', 'abandon']
  );
  assert.deepEqual(planAnswer(proxy, 'approve').toRuntime, [
    { jsonrpc: '2.0', id: 17, result: { outcome: 'approved' } },
  ]);
  assert.equal(
    proxy.configOptions(proxy.sessions.get('grok-session')).find((o) => o.id === 'permission_mode')
      .currentValue,
    'always-approve'
  );
  assert.equal(proxy.planReviews.pending.size, 0);
});

test('uses Core form metadata for revision feedback and restores the native response envelope', () => {
  const proxy = planReviewProxy();
  proxy.handleRuntime(planRequest(17, true));
  const revise = planAnswer(proxy, 'revise');
  assert.deepEqual(revise.toRuntime, []);
  const form = revise.toClient[0];
  assert.equal(form.method, 'elicitation/create');
  assert.equal(form.params.toolCallId, 'plan-17:feedback');
  assert.deepEqual(form.params._meta, { lody: { elicitation: { version: 1 } } });
  assert.equal(form.params.requestedSchema.properties.feedback.type, 'string');
  const reply = proxy.handleClient({
    jsonrpc: '2.0',
    id: form.id,
    result: { action: 'accept', content: { feedback: 'Cover recovery too' } },
  });
  assert.deepEqual(reply.toRuntime[0], {
    jsonrpc: '2.0',
    id: 17,
    result: { result: { outcome: 'cancelled', feedback: 'Cover recovery too' } },
  });
  assert.equal(reply.toClient.length, 2);
  assert.equal(proxy.planReviews.pending.size, 0);
});

test('supports clients without plan updates or form elicitation', () => {
  const proxy = planReviewProxy({});
  const output = proxy.handleRuntime(planRequest());
  assert.equal(output.toClient[0].params.update.sessionUpdate, 'tool_call');
  assert.equal(
    output.toClient.at(-1).params.toolCall.content[0].content.text,
    '# Plan\nTest the behavior'
  );
  assert.deepEqual(planAnswer(proxy, 'revise').toRuntime[0].result, { outcome: 'cancelled' });
});

test('empty plans still have an approval surface', () => {
  const proxy = planReviewProxy({});
  const output = proxy.handleRuntime(planRequest(17, false, null));
  assert.equal(
    output.toClient.at(-1).params.toolCall.content[0].content.text,
    'No plan written yet.'
  );
  assert.deepEqual(planAnswer(proxy, 'abandon').toRuntime[0].result, { outcome: 'abandoned' });
});

test('errors, dismissals, and unknown decisions never approve a plan', () => {
  for (const response of [
    { error: { code: -1, message: 'Disconnected' } },
    { result: {} },
    { result: { outcome: { outcome: 'cancelled' } } },
    { result: { outcome: { outcome: 'selected', optionId: 'unknown' } } },
  ]) {
    const proxy = planReviewProxy();
    proxy.handleRuntime(planRequest());
    assert.deepEqual(
      proxy.handleClient({ jsonrpc: '2.0', id: 17, ...response }).toRuntime[0].result,
      { outcome: 'cancelled' }
    );
  }
});

test('declining revision feedback keeps planning without fabricating feedback', () => {
  const proxy = planReviewProxy();
  proxy.handleRuntime(planRequest());
  planAnswer(proxy, 'revise');
  assert.deepEqual(
    proxy.handleClient({ jsonrpc: '2.0', id: 17, result: { action: 'decline' } }).toRuntime[0]
      .result,
    { outcome: 'cancelled' }
  );
});

test('session cancellation resolves pending plan decisions and keeps other sessions intact', () => {
  const proxy = planReviewProxy();
  proxy.sessions.set('other', { ...proxy.sessions.get('grok-session'), sessionId: 'other' });
  proxy.handleRuntime(planRequest());
  planAnswer(proxy, 'revise');
  const other = planRequest(18);
  other.params.sessionId = 'other';
  proxy.handleRuntime(other);
  const cancel = {
    jsonrpc: '2.0',
    method: 'session/cancel',
    params: { sessionId: 'grok-session' },
  };
  const result = proxy.handleClient(cancel);
  assert.deepEqual(result.toRuntime, [
    { jsonrpc: '2.0', id: 17, result: { outcome: 'cancelled' } },
    cancel,
  ]);
  assert.deepEqual(planAnswer(proxy, 'approve', 18).toRuntime[0].result, { outcome: 'approved' });
  assert.equal(proxy.planReviews.pending.size, 0);
});

test('reverse plan request ids do not consume client requests or native responses with the same id', () => {
  const proxy = planReviewProxy();
  proxy.handleRuntime(planRequest(1));
  const prompt = {
    jsonrpc: '2.0',
    id: 1,
    method: 'session/prompt',
    params: { sessionId: 'grok-session', prompt: [] },
  };
  assert.equal(proxy.handleClient(prompt).toRuntime[0].method, 'session/prompt');
  proxy.handleRuntime({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  assert.deepEqual(planAnswer(proxy, 'approve', 1).toRuntime[0].result, { outcome: 'approved' });
});

test('rejects malformed or detached plan requests without opening a UI', () => {
  for (const patch of [{ sessionId: 'unknown' }, { toolCallId: '' }, { planContent: {} }]) {
    const proxy = planReviewProxy();
    const request = planRequest();
    Object.assign(request.params, patch);
    const result = proxy.handleRuntime(request);
    assert.equal(result.toRuntime[0].error.code, -32602);
    assert.deepEqual(result.toClient, []);
  }
});

test('native enter/exit mode updates refresh the Core toggle without changing permission', () => {
  const proxy = planReviewProxy();
  for (const [currentModeId, enabled] of [
    ['plan', true],
    ['default', false],
  ]) {
    const message = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'grok-session',
        update: { sessionUpdate: 'current_mode_update', currentModeId },
      },
    };
    const output = proxy.handleRuntime(message);
    assert.deepEqual(output.toClient[0], message);
    assert.equal(output.toClient[1].params.update.sessionUpdate, 'config_option_update');
    assert.equal(
      output.toClient[1].params.update.configOptions.find((o) => o.id === 'plan_mode').currentValue,
      enabled
    );
  }
});


test('advertises automatic title ownership in initialize', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({ jsonrpc: '2.0', id: 'title-init', method: 'initialize', params: { protocolVersion: 1 } });
  const output = proxy.handleRuntime({ jsonrpc: '2.0', id: 'title-init', result: { protocolVersion: 1, agentCapabilities: {} } });
  assert.deepEqual(output.toClient[0].result.agentCapabilities._meta.lody.sessionTitle, { version: 1 });
});

test('tags runtime title updates while preserving their session, text and metadata', () => {
  const { proxy } = readyProxy();
  const message = {
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 'grok-session', _meta: { isReplay: true }, update: {
      sessionUpdate: 'session_info_update', title: 'Investigate login', updatedAt: '2026-09-24T00:00:00Z',
      _meta: { upstream: { value: 1 }, lody: { messagePhase: 'final_answer' } },
    } },
  };
  const output = proxy.handleRuntime(message);
  assert.deepEqual(output.toRuntime, []);
  assert.deepEqual(output.toClient, [{ ...message, params: { ...message.params, update: {
    ...message.params.update, _meta: {
      ...message.params.update._meta, lody: { messagePhase: 'final_answer', titleSource: 'explicit' },
    },
  } } }]);
  assert.equal(message.params.update._meta.lody.titleSource, undefined);
});

for (const titleSource of ['generated', 'explicit', 'fallback', 'unset', 'unknown', null]) {
  test(`does not replace an upstream title source: ${titleSource}`, () => {
    const { proxy } = readyProxy();
    const message = { jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'grok-session', update: { sessionUpdate: 'session_info_update', title: 'Title', _meta: { lody: { titleSource } } },
    } };
    assert.deepEqual(proxy.handleRuntime(message).toClient, [message]);
  });
}

test('leaves non-title session info and empty titles untouched', () => {
  const { proxy } = readyProxy();
  for (const title of [undefined, null, '', '   ']) {
    const message = { jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'grok-session', update: { sessionUpdate: 'session_info_update', title, _meta: { lody: { goal: null } } },
    } };
    assert.deepEqual(proxy.handleRuntime(message).toClient, [message]);
  }
});
function forkRequest(turnId, id = 'fork') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/fork',
    params: {
      sessionId: 'parent',
      cwd: '/child',
      mcpServers: [{ name: 'test', command: 'synthetic', args: [] }],
      _meta: {
        clientIdentifier,
        lody: {
          sessionConfig: { version: 1, configOptionValues: { permission_mode: 'always-approve' } },
          ...(turnId === undefined ? {} : { forkAtTurn: { version: 1, turnId } }),
        },
      },
    },
  };
}

function reply(proxy, request, result) {
  return proxy.handleRuntime({ jsonrpc: '2.0', id: request.id, result });
}

function nativeTurn(sessionId, index, { replay = false, kind = 'user_message_chunk' } = {}) {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      _meta: { isReplay: replay, promptId: `prompt-${index}` },
      update: {
        sessionUpdate: kind,
        content: { type: 'text', text: 'synthetic' },
        _meta: { promptIndex: index, vendorField: 'kept' },
      },
    },
  };
}

test('fork capabilities preserve native capabilities and publish Core v1', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({ id: 'init', method: 'initialize', params: {} });
  const result = reply(
    proxy,
    { id: 'init' },
    {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, list: {} },
        _meta: { vendor: true },
      },
    }
  ).toClient[0].result;
  assert.deepEqual(result.agentCapabilities.sessionCapabilities, {
    resume: {},
    list: {},
    fork: {},
  });
  assert.deepEqual(result.agentCapabilities._meta.lody.forkAtTurn, { version: 1 });
  assert.deepEqual(result.agentCapabilities._meta.lody.tasks, { version: 1, scheduled: true });
  assert.equal(result.agentCapabilities._meta.vendor, true);
});

test('full fork discovers source cwd across pages, attaches child without replay, and seeds permissions', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const request = forkRequest();
  let output = proxy.handleClient(request);
  assert.equal(output.toRuntime[0].method, 'session/list');
  assert.deepEqual(output.toRuntime[0].params, {});
  output = reply(proxy, output.toRuntime[0], { sessions: [], nextCursor: 'page-2' });
  assert.deepEqual(output.toRuntime[0].params, { cursor: 'page-2' });
  output = reply(proxy, output.toRuntime[0], {
    sessions: [{ sessionId: 'parent', cwd: '/source' }],
  });
  assert.deepEqual(output.toRuntime[0].params, {
    sourceSessionId: 'parent',
    sourceCwd: '/source',
    newCwd: '/child',
  });
  assert.equal(output.toRuntime[0].method, '_x.ai/session/fork');
  assert.deepEqual(output.toClient, []);
  output = reply(proxy, output.toRuntime[0], { newSessionId: 'child' });
  const resume = output.toRuntime[0];
  assert.equal(resume.method, 'session/resume');
  assert.equal(resume.params.sessionId, 'child');
  assert.equal(resume.params.cwd, '/child');
  assert.deepEqual(resume.params.mcpServers, request.params.mcpServers);
  assert.equal(resume.params._meta.yoloMode, true);
  assert.equal(resume.params._meta.autoMode, false);
  const loaded = structuredClone(sessionResponse.result);
  delete loaded.sessionId;
  output = reply(proxy, resume, loaded);
  assert.equal(output.toClient[0].id, 'fork');
  assert.equal(output.toClient[0].result.sessionId, 'child');
  assert.equal(
    output.toClient[0].result.configOptions.find((o) => o.id === 'permission_mode').currentValue,
    'always-approve'
  );
  assert.equal(proxy.sessions.has('parent'), false);
  const permission = permissionRequest();
  permission.params.sessionId = 'child';
  assertAutomatic(proxy.handleRuntime(permission), 'single-use');
});

test('live and replay turn boundaries use restart-stable Core ids without duplicating live user text', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const boundary = proxy.handleRuntime(nativeTurn('parent', 0)).toClient[0];
  assert.equal(boundary.params.update.sessionUpdate, 'session_info_update');
  assert.equal(boundary.params.update.content, undefined);
  assert.equal(boundary.params.update._meta.lody.turnId, 'grok-prompt:0');
  const assistant = proxy.handleRuntime(nativeTurn('parent', 0, { kind: 'agent_message_chunk' }))
    .toClient[0];
  assert.equal(assistant.params.update._meta.lody.turnId, 'grok-prompt:0');
  assert.equal(assistant.params.update._meta.vendorField, 'kept');
  const replay = proxy.handleRuntime(nativeTurn('parent', 2, { replay: true })).toClient[0];
  assert.equal(replay.params.update.sessionUpdate, 'user_message_chunk');
  assert.equal(replay.params.update._meta.lody.turnId, 'grok-prompt:2');
  assert.equal(
    proxy.handleRuntime(nativeTurn('other', 9, { kind: 'agent_message_chunk' })).toClient[0].params
      .update._meta.lody,
    undefined
  );
  const restarted = new GrokAcpCompatibilityProxy();
  let output = restarted.handleClient(forkRequest(assistant.params.update._meta.lody.turnId));
  output = reply(restarted, output.toRuntime[0], {
    sessions: [{ sessionId: 'parent', cwd: '/source' }],
  });
  assert.equal(output.toRuntime[0].params.targetPromptIndex, 0);
});

test('fork failures retain the original request id and never fall back to a fresh session', () => {
  for (const stage of ['list', 'copy', 'resume']) {
    const proxy = new GrokAcpCompatibilityProxy();
    let output = proxy.handleClient(forkRequest('grok-prompt:1'));
    if (stage !== 'list')
      output = reply(proxy, output.toRuntime[0], {
        sessions: [{ sessionId: 'parent', cwd: '/source' }],
      });
    if (stage === 'resume') output = reply(proxy, output.toRuntime[0], { newSessionId: 'child' });
    const error = { code: -32001, message: `synthetic ${stage} failure` };
    output = proxy.handleRuntime({ jsonrpc: '2.0', id: output.toRuntime[0].id, error });
    assert.deepEqual(output, {
      toRuntime: [],
      toClient: [
        {
          jsonrpc: '2.0',
          id: 'fork',
          error: stage === 'resume' ? { ...error, data: { forkedSessionId: 'child' } } : error,
        },
      ],
    });
    assert.equal(proxy.sessions.size, 0);
  }
});

test('rejects invalid target metadata before any native copy and missing sources after discovery', () => {
  for (const turnId of [
    '',
    'unknown',
    'grok-prompt:-1',
    'grok-prompt:01',
    'grok-prompt:1.5',
    'grok-prompt:1e2',
    'grok-prompt: 0',
    'grok-prompt:-0',
    'other-token:0',
    'grok-prompt:9007199254740992',
    null,
  ]) {
    const proxy = new GrokAcpCompatibilityProxy();
    const output = proxy.handleClient(forkRequest(turnId));
    assert.deepEqual(output.toRuntime, []);
    assert.equal(output.toClient[0].error.code, -32602);
  }
  const proxy = new GrokAcpCompatibilityProxy();
  const request = forkRequest('grok-prompt:0');
  request.params._meta.lody.forkAtTurn.version = 2;
  assert.equal(proxy.handleClient(request).toClient[0].error.code, -32602);
  let output = proxy.handleClient(forkRequest());
  output = reply(proxy, output.toRuntime[0], { sessions: [], nextCursor: 'repeat' });
  output = reply(proxy, output.toRuntime[0], { sessions: [], nextCursor: 'repeat' });
  assert.equal(output.toRuntime.length, 0);
  assert.match(output.toClient[0].error.message, /not found/);
});

test('malformed native results and reused parent identities fail closed', () => {
  for (const copyResult of [
    {},
    { newSessionId: '' },
    { newSessionId: 'parent' },
    { result: { newSessionId: 'child' } },
  ]) {
    const proxy = new GrokAcpCompatibilityProxy();
    let output = proxy.handleClient(forkRequest());
    output = reply(proxy, output.toRuntime[0], {
      sessions: [{ sessionId: 'parent', cwd: '/source' }],
    });
    output = reply(proxy, output.toRuntime[0], copyResult);
    assert.equal(output.toRuntime.length, 0);
    assert.equal(output.toClient[0].error.code, -32603);
  }
});

test('fork response waits for the model snapshot with the child identity intact', () => {
  const proxy = new GrokAcpCompatibilityProxy({ deferSessionResponseUntilModelSnapshot: true });
  let output = proxy.handleClient(forkRequest());
  output = reply(proxy, output.toRuntime[0], {
    sessions: [{ sessionId: 'parent', cwd: '/source' }],
  });
  output = reply(proxy, output.toRuntime[0], { newSessionId: 'child' });
  output = reply(proxy, output.toRuntime[0], { models: sessionResponse.result.models });
  assert.deepEqual(output.deferredSessionResponseIds, ['fork']);
  assert.deepEqual(output.toClient, []);
  output = proxy.handleRuntime(modelSnapshot);
  const response = output.toClient.find((m) => m.id === 'fork');
  assert.equal(response.result.sessionId, 'child');
  assert.equal(response.result.models.currentModelId, 'grok-4.6');
});

test('concurrent fork requests and reverse requests keep their separate identities', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const a = proxy.handleClient(forkRequest('grok-prompt:0', 'a')).toRuntime[0];
  const b = proxy.handleClient(forkRequest('grok-prompt:2', 'b')).toRuntime[0];
  const reverse = {
    jsonrpc: '2.0',
    id: a.id,
    method: 'session/request_permission',
    params: { sessionId: 'unknown', options: [] },
  };
  assert.deepEqual(proxy.handleRuntime(reverse).toClient, [reverse]);
  for (const [request, target, id] of [
    [b, 2, 'b'],
    [a, 0, 'a'],
  ]) {
    let output = reply(proxy, request, { sessions: [{ sessionId: 'parent', cwd: '/source' }] });
    assert.equal(output.toRuntime[0].params.targetPromptIndex, target);
    output = reply(proxy, output.toRuntime[0], { newSessionId: `child-${id}` });
    output = reply(proxy, output.toRuntime[0], {});
    assert.equal(output.toClient[0].id, id);
    assert.equal(output.toClient[0].result.sessionId, `child-${id}`);
  }
});

test('a new prompt never inherits an earlier turn id before its own native boundary', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleRuntime(nativeTurn('parent', 4));
  proxy.handleClient({
    id: 'prompt',
    method: 'session/prompt',
    params: { sessionId: 'parent', prompt: [] },
  });
  let output = proxy.handleRuntime(nativeTurn('parent', 5, { kind: 'agent_thought_chunk' }));
  assert.equal(output.toClient[0].params.update._meta.lody, undefined);
  proxy.handleRuntime(nativeTurn('parent', 5));
  const phantom = nativeTurn('parent', undefined);
  assert.deepEqual(proxy.handleRuntime(phantom).toClient, []);
  output = proxy.handleRuntime(nativeTurn('parent', 5, { kind: 'tool_call' }));
  assert.equal(output.toClient[0].params.update._meta.lody.turnId, 'grok-prompt:5');
});
