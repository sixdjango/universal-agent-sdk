import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type SessionConfigOption,
  type Stream,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLodySubagentEvent, type LodySubagentEvent } from 'acp-extension-core';

import { apply } from './adapter.js';
import { DEEPSEEK_HARNESS_AGENT_PRESETS } from './capabilities.js';
import type { ForkEvent } from './session-fork.js';

type Listener = (...args: unknown[]) => unknown;

const DEFAULT_MODELS = [
  {
    modelId: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: 'Faster DeepSeek Harness coding model.',
    inputModalities: ['text'],
  },
  {
    modelId: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'More capable DeepSeek Harness coding model.',
    inputModalities: ['text'],
  },
  {
    modelId: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek-V4-Flash-Vision-Exp',
    description: 'Experimental multimodal DeepSeek model with image understanding.',
    inputModalities: ['text', 'image'],
  },
] as const;

const DEFAULT_LLM_CATALOG = {
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
  listModels: async (provider: string) =>
    DEFAULT_MODELS.map((model) => ({
      provider,
      id: model.modelId,
      name: model.name,
      description: model.description,
      inputModalities: model.inputModalities,
    })),
  resolveModelInfo: async (provider: string, modelId: string) => {
    const catalogModel = DEFAULT_MODELS.find((model) => model.modelId === modelId);
    return {
      provider,
      id: modelId,
      name: catalogModel?.name ?? modelId,
      description: catalogModel?.description,
      inputModalities: catalogModel?.inputModalities ?? ['text'],
      ...(modelId === 'no-reasoning'
        ? {}
        : {
            reasoning: {
              efforts: [
                { id: 'off', name: 'Off' },
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
                { id: 'max', name: 'Max' },
              ],
              defaultEffort: 'max',
            },
          }),
    };
  },
};

function acpModelId(provider: string, model: string): string {
  return `dsh-route:${Buffer.from(JSON.stringify([provider, model])).toString('base64url')}`;
}

const PERMISSION_OPTIONS = {
  'read-only': {
    value: 'read-only',
    name: 'Read-only',
    description: 'Read inside the workspace',
  },
  'workspace-write': {
    value: 'workspace-write',
    name: 'Workspace write',
    description: 'Read and write inside the workspace',
  },
  'danger-full-access': {
    value: 'danger-full-access',
    name: 'Full access',
    description: 'Unrestricted access',
  },
  reviewed: {
    value: 'reviewed',
    name: 'Reviewed writes',
    description: 'Use a deployment-defined review policy',
  },
  custom: {
    value: 'custom',
    name: 'Custom',
    description: 'Current sandbox and approval settings do not match a preset.',
  },
} as const;

function permissionOption(name: string) {
  const option = PERMISSION_OPTIONS[name as keyof typeof PERMISSION_OPTIONS];
  if (!option) throw new Error(`unknown permission option: ${name}`);
  return option;
}

function testHarnessService(name: string): unknown {
  return name === 'llm'
    ? DEFAULT_LLM_CATALOG
    : name === 'sessions'
      ? { flush: async () => true }
      : undefined;
}

function connectedStreams(): { agent: Stream; client: Stream } {
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agent: {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    },
    client: {
      readable: agentToClient.readable,
      writable: clientToAgent.writable,
    },
  };
}

function selectValue(options: SessionConfigOption[] | null | undefined, id: string): unknown {
  return options?.find((option) => option.id === id)?.currentValue;
}

function selectOption(options: SessionConfigOption[] | null | undefined, id: string) {
  return options?.find((option) => option.id === id);
}

describe('DeepSeek Harness ACP adapter', () => {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    // Keep every case independent from an ambient DeepSeek endpoint; cases that
    // need discovery stub their own values on top of this.
    vi.stubEnv('DEEPSEEK_BASE_URL', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
  });

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const endpoints = [
    ['https://provider.example/v1/', 'https://provider.example/v1/models', false],
    ['https://api.deepseek.com', 'https://api.deepseek.com/models', true],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/models', true],
    ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/models', true],
    ['https://api.deepseek.com/anthropic/v1/', 'https://api.deepseek.com/models', true],
    [
      'https://api.deepseek.com.evil.example/anthropic/',
      'https://api.deepseek.com.evil.example/anthropic/models',
      false,
    ],
  ] as const;

  async function forkHarness() {
    type Context = Parameters<typeof apply>[0];
    type Agent = Awaited<ReturnType<Context['agents']['create']>>['agent'];
    const streams = connectedStreams();
    const listeners = new Map<string, Listener>();
    const live = new Map<string, Agent>();
    const stored = new Map<
      string,
      { header: { id: string; agentPreset: string; cwd: string }; events: ForkEvent[] }
    >();
    const mounted = new Map<string, unknown[]>();
    const flushed = new Set<string>();
    const updates: unknown[] = [];
    let flushFailure = false;
    let setupFailure = false;
    let released = 0;
    let flushGate: Promise<void> | undefined;
    let flushStarted: (() => void) | undefined;
    let setupGate: Promise<void> | undefined;
    let setupStarted: (() => void) | undefined;
    const context: Context = {
      agents: {
        get: (id) => live.get(id),
        resume: async (options) => {
          const source = stored.get(options.resumeSessionId);
          if (!source) throw new Error('missing native session');
          if (live.has(options.resumeSessionId)) throw new Error('native session busy');
          return context.agents.create({
            sessionId: options.resumeSessionId,
            meta: source.header,
            seed: source.events,
            agentOptions: { provider: 'unused', model: 'unused' },
            setup: async (agentContext) => {
              await options.setup(agentContext, {
                id: options.resumeSessionId,
                ctx: agentContext,
                session: {
                  id: options.resumeSessionId,
                  header: source.header,
                  snapshotEvents: () => source.events,
                  append() {},
                },
                followup() {},
                cancel() {},
                whenIdle: async () => {},
              });
            },
          });
        },
        create: async (options) => {
          const plugins: unknown[] = [];
          const agentContext: Parameters<typeof options.setup>[0] = {
            get: () => undefined,
            on: () => () => {},
            loader: { import: async () => ({ apply() {} }), unwrapExports: (value) => value },
            plugin: (_plugin, config) => ({
              await: async () => {
                plugins.push(config);
                if (setupFailure) throw new Error('MCP unavailable');
              },
            }),
          };
          await options.setup(agentContext);
          const snapshot = {
            header: { id: options.sessionId, ...options.meta },
            events: structuredClone([...(options.seed ?? [])]),
          };
          stored.set(options.sessionId, snapshot);
          mounted.set(options.sessionId, plugins);
          const agent: Agent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: snapshot.header,
              snapshotEvents: () => snapshot.events,
              append(type, data) {
                snapshot.events.push({ type, data, seq: snapshot.events.length });
              },
            },
            cancel() {},
            whenIdle: async () => {},
            followup(message) {
              const turn = 9;
              listeners.get('agent/inbox/claimed')?.({ agent, message, turn });
              listeners.get('session/event')?.(agent.session, {
                type: 'assistant/message',
                data: { turn, message: { content: [{ type: 'text', text: 'continued' }] } },
              });
              listeners.get('session/event')?.(agent.session, {
                type: 'turn/end',
                data: { turn, reason: { kind: 'completed' } },
              });
            },
          };
          live.set(agent.id, agent);
          return {
            agent,
            dispose: async () => {
              live.delete(agent.id);
            },
          };
        },
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }, { id: 'minimal' }],
        mount: async (_ctx, id = 'standard') => {
          setupStarted?.();
          await setupGate;
          return { id };
        },
        select: async (_agent, id) => id,
      },
      permissionPresets: {
        names: ['workspace-write'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        optionOf: permissionOption,
        set() {},
      },
      logger: { warn() {} },
      on: (event, listener) => {
        listeners.set(event, listener as Listener);
        return () => {};
      },
      effect: (register) => {
        disposers.push(register());
      },
      get: (name) => {
        if (name === 'llm') return DEFAULT_LLM_CATALOG;
        if (name === 'sessionQuery')
          return {
            observeSession: async (id: string) => {
              const source = stored.get(id);
              if (!source) throw new Error('missing native session');
              return {
                ...structuredClone(source),
                [Symbol.dispose]() {
                  released++;
                },
              };
            },
          };
        if (name === 'sessions')
          return {
            flush: async (session: { id: string }) => {
              flushStarted?.();
              await flushGate;
              if (flushFailure) throw new Error('disk unavailable');
              flushed.add(session.id);
              return true;
            },
          };
        return undefined;
      },
    };
    apply(context, { stream: streams.agent, model: 'deepseek-v4-flash' });
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async (update) => {
          updates.push(update);
        },
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
      }),
      streams.client
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const event = (type: string, data: Record<string, unknown>): ForkEvent => ({
      type,
      seq: 0,
      data,
    });
    const events = [
      event('agent-preset/selected', { agentPreset: 'minimal' }),
      event('turn/start', { turn: 1 }),
      event('request/header', {
        header: {
          config: {
            provider: 'deepseek-official',
            model: 'deepseek-v4-pro',
            reasoningEffort: 'low',
          },
        },
      }),
      event('user/message', { content: [{ type: 'text', text: 'first' }] }),
      event('plugin/opaque', { nested: { preserve: true } }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', { turn: 2 }),
      event('request/header', {
        header: {
          config: {
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            reasoningEffort: 'max',
          },
        },
      }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ].map((value, seq) => ({ ...value, seq }));
    stored.set('cold-source', {
      header: { id: 'cold-source', agentPreset: 'standard', cwd: '/source' },
      events,
    });
    return {
      client,
      initialized,
      stored,
      live,
      mounted,
      flushed,
      updates,
      events,
      setFlushFailure() {
        flushFailure = true;
      },
      setSetupFailure(value: boolean) {
        setupFailure = value;
      },
      blockFlush(gate: Promise<void>, started: () => void) {
        flushGate = gate;
        flushStarted = started;
      },
      blockSetup(gate: Promise<void>, started: () => void) {
        setupGate = gate;
        setupStarted = started;
      },
      released: () => released,
    };
  }

  it('loads the original native identity, replays ordered history, and continues without a new session', async () => {
    const h = await forkHarness();
    expect(h.initialized.agentCapabilities.loadSession).toBe(true);
    expect(h.initialized.agentCapabilities.sessionCapabilities?.resume).toEqual({});
    const source = h.stored.get('cold-source')!;
    source.events.splice(
      5,
      0,
      {
        type: 'assistant/message',
        seq: 0,
        data: {
          turn: 1,
          message: {
            content: [
              { type: 'reasoning', text: 'thought' },
              { type: 'text', text: 'answer' },
            ],
          },
        },
      },
      {
        type: 'tool/call',
        seq: 0,
        data: { callId: 'call-1', name: 'read', arguments: '{"path":"a"}' },
      },
      {
        type: 'tool/result',
        seq: 0,
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'result' }],
          },
        },
      }
    );
    source.events.forEach((event, seq) => {
      event.seq = seq;
    });
    const before = structuredClone(source);
    const loaded = await h.client.loadSession({
      sessionId: 'cold-source',
      cwd: '/source',
      mcpServers: [{ name: 'resume-tools', command: 'synthetic', args: [], env: [] }],
    });
    expect([...h.live.keys()]).toEqual(['cold-source']);
    expect(h.stored.get('cold-source')).toEqual(before);
    expect(selectValue(loaded.configOptions, 'agent_preset')).toBe('minimal');
    expect(selectValue(loaded.configOptions, 'reasoning_effort')).toBe('max');
    expect(h.mounted.get('cold-source')).toMatchObject([
      { serverName: 'resume-tools', cwd: '/source' },
    ]);
    const transcript = h.updates as Array<{
      update: { sessionUpdate: string; content?: { text?: string } };
    }>;
    expect(
      transcript
        .filter(({ update }) => update.content?.text)
        .map(({ update }) => [update.sessionUpdate, update.content?.text])
    ).toEqual([
      ['user_message_chunk', 'first'],
      ['agent_thought_chunk', 'thought'],
      ['agent_message_chunk', 'answer'],
    ]);
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: 'call-1' }),
      })
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        update: expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'result' } }],
        }),
      })
    );
    await expect(
      h.client.setSessionConfigOption({
        sessionId: 'cold-source',
        configId: 'agent_preset',
        value: 'standard',
      })
    ).rejects.toThrow('fixed');
    await h.client.prompt({
      sessionId: 'cold-source',
      prompt: [{ type: 'text', text: 'continue' }],
    });
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionId: 'cold-source',
        update: expect.objectContaining({ content: { type: 'text', text: 'continued' } }),
      })
    );
    await h.client.closeSession({ sessionId: 'cold-source' });
    h.updates.length = 0;
    await h.client.resumeSession({ sessionId: 'cold-source', cwd: '/source', mcpServers: [] });
    expect(h.updates).toEqual([]);
    expect([...h.live.keys()]).toEqual(['cold-source']);
  });

  it('rejects invalid restore identities and releases failed setup for retry', async () => {
    const h = await forkHarness();
    const request = {
      sessionId: 'cold-source',
      cwd: '/source',
      mcpServers: [{ name: 'retry-tools', command: 'synthetic', args: [], env: [] }],
    };
    await expect(h.client.loadSession({ ...request, sessionId: 'missing' })).rejects.toThrow(
      'missing native session'
    );
    await expect(h.client.loadSession({ ...request, cwd: '/other' })).rejects.toThrow('cwd');
    await expect(
      h.client.loadSession({ ...request, additionalDirectories: ['/ignored'] })
    ).rejects.toThrow();
    h.setSetupFailure(true);
    await expect(h.client.loadSession(request)).rejects.toThrow('MCP unavailable');
    expect(h.live.size).toBe(0);
    h.setSetupFailure(false);
    await h.client.resumeSession(request);
    expect(h.mounted.get(request.sessionId)).toMatchObject([{ serverName: 'retry-tools' }]);
    await expect(h.client.loadSession(request)).rejects.toThrow('already active');
    expect([...h.live.keys()]).toEqual([request.sessionId]);
    await h.client.closeSession({ sessionId: request.sessionId });
    const source = h.stored.get(request.sessionId)!;
    Object.assign(source.header, { origin: 'subagent' });
    await expect(h.client.resumeSession(request)).rejects.toThrow('subagent');
    expect(h.live.size).toBe(0);
  });

  it('keeps restore exclusive until MCP/preset setup completes and cleans up failed history delivery', async () => {
    const h = await forkHarness();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    h.blockSetup(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      markStarted
    );
    const request = { sessionId: 'cold-source', cwd: '/source', mcpServers: [] };
    const loading = h.client.loadSession(request);
    await started;
    await expect(h.client.resumeSession(request)).rejects.toThrow('being restored');
    expect(h.live.size).toBe(0);
    release();
    await loading;
    await h.client.closeSession({ sessionId: request.sessionId });
    const source = h.stored.get(request.sessionId)!;
    source.events.push({
      type: 'assistant/message',
      seq: source.events.length,
      data: {
        turn: 2,
        message: { content: [{ type: 'image', attachment: { attachmentId: 'missing' } }] },
      },
    });
    await expect(h.client.loadSession(request)).rejects.toThrow('attachment');
    expect(h.live.size).toBe(0);
    // Resume needs no historic attachment reads; the original native log remains usable.
    await h.client.resumeSession(request);
    expect(h.live.has(request.sessionId)).toBe(true);
  });

  it('persists model selections made after the last prompt and restores them without replay', async () => {
    const h = await forkHarness();
    const request = { sessionId: 'cold-source', cwd: '/source', mcpServers: [] };
    await h.client.resumeSession(request);
    await h.client.setSessionConfigOption({
      sessionId: request.sessionId,
      configId: 'model',
      value: acpModelId('deepseek-official', 'deepseek-v4-pro'),
    });
    await h.client.setSessionConfigOption({
      sessionId: request.sessionId,
      configId: 'reasoning_effort',
      value: 'low',
    });
    expect(h.flushed.has(request.sessionId)).toBe(true);
    await h.client.closeSession({ sessionId: request.sessionId });
    const resumed = await h.client.resumeSession(request);
    expect(selectValue(resumed.configOptions, 'model')).toBe(
      acpModelId('deepseek-official', 'deepseek-v4-pro')
    );
    expect(selectValue(resumed.configOptions, 'reasoning_effort')).toBe('low');
    expect(h.updates).toEqual([]);
  });

  it('forks cold native histories at exact Core turns, preserving prefixes and target configuration', async () => {
    const h = await forkHarness();
    expect(h.initialized.agentCapabilities.sessionCapabilities?.fork).toEqual({});
    expect(h.initialized.agentCapabilities._meta?.lody).toMatchObject({
      forkAtTurn: { version: 1 },
    });
    const source = structuredClone(h.events);
    const request = {
      sessionId: 'cold-source',
      cwd: '/target',
      mcpServers: [{ name: 'target-tools', command: 'synthetic', args: [], env: [] }],
    };
    const full = await h.client.unstable_forkSession(request);
    const partial = await h.client.unstable_forkSession({
      ...request,
      _meta: { lody: { forkAtTurn: { version: 1, turnId: 'dsh-turn:1' } } },
    });
    expect(full.sessionId).not.toBe(partial.sessionId);
    expect(h.stored.get(full.sessionId)?.events).toEqual(source);
    expect(h.stored.get(partial.sessionId)?.events).toEqual(source.slice(0, 6));
    expect(h.stored.get('cold-source')?.events).toEqual(source);
    expect(h.stored.get(partial.sessionId)?.header).toMatchObject({
      cwd: '/target',
      parentSession: 'cold-source',
      isSeeded: true,
      agentPreset: 'minimal',
    });
    expect(selectValue(partial.configOptions, 'model')).toBe(
      acpModelId('deepseek-official', 'deepseek-v4-pro')
    );
    expect(selectValue(partial.configOptions, 'reasoning_effort')).toBe('low');
    expect(selectValue(full.configOptions, 'reasoning_effort')).toBe('max');
    expect(h.mounted.get(partial.sessionId)).toMatchObject([
      { cwd: '/target', command: 'synthetic' },
    ]);
    expect(h.flushed.has(partial.sessionId)).toBe(true);
    expect(h.released()).toBe(2);
    await h.client.prompt({
      sessionId: partial.sessionId,
      prompt: [{ type: 'text', text: 'continue child' }],
    });
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionId: partial.sessionId,
        update: expect.objectContaining({
          content: { type: 'text', text: 'continued' },
          _meta: { lody: { turnId: 'dsh-turn:9' } },
        }),
      })
    );
    expect(h.stored.get('cold-source')?.events).toEqual(source);
    await h.client.closeSession({ sessionId: partial.sessionId });
    expect(h.live.has(partial.sessionId)).toBe(false);
    expect(h.live.has(full.sessionId)).toBe(true);
  });

  it('rejects invalid/open fork targets and failed setup or durability without publishing a usable child', async () => {
    const h = await forkHarness();
    const request = { sessionId: 'cold-source', cwd: '/target', mcpServers: [] };
    for (const target of [
      null,
      { version: 2 },
      { version: 1, turnId: '' },
      { version: 1, turnId: 'dsh-turn:999' },
      { version: 1, turnId: 'dsh-turn:9007199254740992' },
    ]) {
      await expect(
        h.client.unstable_forkSession({ ...request, _meta: { lody: { forkAtTurn: target } } })
      ).rejects.toThrow();
    }
    await expect(
      h.client.unstable_forkSession({ ...request, additionalDirectories: ['/ignored'] })
    ).rejects.toThrow('additionalDirectories');
    await expect(
      h.client.unstable_forkSession({ ...request, sessionId: 'missing' })
    ).rejects.toThrow('source unavailable');
    expect(h.live.size).toBe(0);
    h.events.push({ seq: h.events.length, type: 'turn/start', data: { turn: 3 } });
    await expect(h.client.unstable_forkSession(request)).rejects.toThrow('unfinished turn');
    const explicit = {
      ...request,
      _meta: { lody: { forkAtTurn: { version: 1, turnId: 'dsh-turn:1' } } },
    };
    const child = await h.client.unstable_forkSession(explicit);
    expect(h.stored.get(child.sessionId)?.events).toEqual(h.events.slice(0, 6));
    h.setSetupFailure(true);
    await expect(
      h.client.unstable_forkSession({
        ...explicit,
        mcpServers: [{ name: 'tools', command: 'synthetic', args: [], env: [] }],
      })
    ).rejects.toThrow('MCP unavailable');
    expect([...h.live.keys()]).toEqual([child.sessionId]);
    h.setSetupFailure(false);
    h.setFlushFailure();
    await expect(h.client.unstable_forkSession(explicit)).rejects.toThrow('disk unavailable');
    expect([...h.live.keys()]).toEqual([child.sessionId]);
  });

  it('waits for fork durability before returning the ACP child', async () => {
    const h = await forkHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.blockFlush(gate, entered);
    let returned = false;
    const fork = h.client
      .unstable_forkSession({ sessionId: 'cold-source', cwd: '/target' })
      .then((result) => {
        returned = true;
        return result;
      });
    await started;
    expect(returned).toBe(false);
    expect(h.flushed.size).toBe(0);
    release();
    const result = await fork;
    expect(h.flushed.has(result.sessionId)).toBe(true);
  });

  it('persists ended source turns before prompt completion and reports checkpoint failures', async () => {
    const h = await forkHarness();
    const session = await h.client.newSession({ cwd: '/source', mcpServers: [] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.blockFlush(gate, entered);
    let returned = false;
    const prompt = h.client
      .prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'source turn' }] })
      .then((result) => {
        returned = true;
        return result;
      });
    await started;
    expect(returned).toBe(false);
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        sessionId: session.sessionId,
        update: expect.objectContaining({ _meta: { lody: { turnId: 'dsh-turn:9' } } }),
      })
    );
    release();
    expect((await prompt).stopReason).toBe('end_turn');
    expect(h.flushed.has(session.sessionId)).toBe(true);
    h.setFlushFailure();
    await expect(
      h.client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'next turn' }],
      })
    ).rejects.toThrow('disk unavailable');
  });

  it.each(endpoints)('applies settings and usage at %s', async (baseUrl, modelsUrl, official) => {
    vi.stubEnv('DEEPSEEK_BASE_URL', baseUrl);
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test');
    const fetchModels = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'kimi-k3', object: 'model', owned_by: 'moonshot' },
              { id: 'kimi-k2.6', object: 'model', owned_by: 'moonshot' },
              { id: 'kimi-k3', object: 'model', owned_by: 'moonshot' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchModels);
    const streams = connectedStreams();
    const scopedListeners = new Map<string, Listener>();
    const harnessListeners = new Map<string, Listener>();
    const permissionSwitches: string[] = [];
    const agentPresetSwitches: string[] = [];
    const sessionUpdates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
    let currentPermission = 'workspace-write';
    let planActive = false;
    let planPending: boolean | undefined;
    let hasPlanService = true;
    let createdHarnessSession: unknown;
    const activeProviders = new Set(['deepseek-official', 'acme-route']);
    const llm = {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'acme-route', name: 'Acme' },
      ],
      listModels: async (provider: string) => [
        {
          provider,
          id: 'kimi-k3',
          name: provider === 'acme-route' ? 'Acme K3' : 'Kimi K3',
          inputModalities: ['text'],
        },
      ],
      resolveModelInfo: async (provider: string, modelId: string) => {
        if (!activeProviders.has(provider)) throw new Error(`no adapter for ${provider}`);
        return {
          provider,
          id: modelId,
          name: provider === 'acme-route' ? `Acme ${modelId}` : modelId,
          inputModalities: ['text'],
          ...(modelId === 'no-reasoning'
            ? {}
            : {
                reasoning: {
                  efforts: [
                    { id: 'off', name: 'Off' },
                    { id: 'low', name: 'Low' },
                    { id: 'high', name: 'High' },
                    { id: 'max', name: 'Max' },
                  ],
                  defaultEffort: 'max',
                },
              }),
        };
      },
    };

    const context: Parameters<typeof apply>[0] = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            get: (name) =>
              name === 'planMode' && hasPlanService
                ? {
                    get: () => ({ active: planActive, pending: planPending }),
                    set: (_agent: unknown, active: boolean) => {
                      planActive = active;
                      return 'committed';
                    },
                  }
                : undefined,
            on<TArgs extends unknown[]>(
              event: string,
              listener: (...args: TArgs) => unknown
            ): () => void {
              scopedListeners.set(event, listener as Listener);
              return () => scopedListeners.delete(event);
            },
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          const session = {
            id: options.sessionId,
            header: { id: options.sessionId },
            events: [] as Array<{ type: string; data: { agentPreset: string } }>,
            append(type: 'agent-preset/selected', data: { agentPreset: string }) {
              this.events.push({ type, data });
            },
          };
          createdHarnessSession = session;
          const agent = {
            id: options.sessionId,
            ctx: agentContext,
            session,
            followup: vi.fn(),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          return { agent, dispose: () => Promise.resolve() };
        },
        get: () => undefined,
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access', 'reviewed'],
        defaultPreset: 'workspace-write',
        current: () => currentPermission,
        optionOf: permissionOption,
        set: (_session, mode) => {
          currentPermission = mode;
          permissionSwitches.push(mode);
        },
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [
          ...DEEPSEEK_HARNESS_AGENT_PRESETS.map((preset) => ({
            id: preset.value,
            name: `中文 ${preset.name}`,
            description: `中文 ${preset.description}`,
          })),
          { id: 'custom', name: 'Custom preset', description: 'User-provided preset' },
        ],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        select: async (_agent, id) => {
          agentPresetSwitches.push(id);
          hasPlanService = id !== 'minimal';
          return id;
        },
      },
      logger: { warn: vi.fn() },
      on<TArgs extends unknown[]>(
        event: string,
        listener: (...args: TArgs) => unknown
      ): () => void {
        harnessListeners.set(event, listener as Listener);
        return () => harnessListeners.delete(event);
      },
      get: (service) => (service === 'llm' ? llm : testHarnessService(service)),
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, {
      stream: streams.agent,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });

    let receiveUsage: (value: Record<string, unknown>) => void = () => {};
    const usageReceived = new Promise<Record<string, unknown>>((resolve) => {
      receiveUsage = resolve;
    });
    let titlesDelivered!: () => void;
    const titlesReceived = new Promise<void>((resolve) => {
      titlesDelivered = resolve;
    });
    const client = new ClientSideConnection(
      () => ({
        extNotification: async (method, params) => {
          if (method === '_lody/session/usage_update') receiveUsage(params);
        },
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async (notification) => {
          sessionUpdates.push(notification as (typeof sessionUpdates)[number]);
          if (
            notification.update.sessionUpdate === 'session_info_update' &&
            notification.update.title === 'Title from user'
          )
            titlesDelivered();
        },
      }),
      streams.client
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentInfo?.name).toBe('acp-extension-dsh');
    expect(initialized.agentCapabilities._meta).toEqual({
      lody: {
        forkAtTurn: { version: 1 },
        compaction: { version: 1 },
        usage: { version: 1 },
        sessionHistory: { version: 1 },
        steering: {
          version: 1,
          transport: 'request',
          upstreamTurn: 'same',
          configPolicy: 'active',
        },
        subagents: { version: 1, lifecycle: true, list: true, output: true, cancel: true },
        sessionTitle: { version: 1 },
        subagentEvents: { version: 1 },
      },
    });

    const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    harnessListeners.get('session/event')?.(createdHarnessSession, {
      type: 'request/context',
      seq: 10,
      time: 0,
      data: { provider: 'deepseek-official', model: 'deepseek-flash' },
    });
    harnessListeners.get('session/event')?.(createdHarnessSession, {
      type: 'assistant/message',
      seq: 11,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: { content: [] },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 30,
          reasoningTokens: 20,
        },
      },
    });
    for (const kind of ['fallback', 'provider', 'user']) {
      harnessListeners.get('session/event')?.(createdHarnessSession, {
        type: 'session/title',
        data: { title: `Title from ${kind}`, source: { kind } },
      });
    }
    harnessListeners.get('session/event')?.(
      { ...createdHarnessSession },
      {
        type: 'session/title',
        data: { title: 'Unowned session title', source: { kind: 'provider' } },
      }
    );
    await titlesReceived;
    expect(
      sessionUpdates
        .filter((entry) => entry.update.sessionUpdate === 'session_info_update')
        .map((entry) => entry.update)
    ).toEqual(
      ['fallback', 'generated', 'explicit'].map((titleSource, i) => ({
        sessionUpdate: 'session_info_update',
        title: `Title from ${['fallback', 'provider', 'user'][i]}`,
        _meta: { lody: { titleSource } },
      }))
    );
    const reportedUsage = await usageReceived;
    expect(reportedUsage).toMatchObject({
      sessionId: created.sessionId,
      modelUsage: {
        'deepseek-flash': {
          inputTokens: 100,
          outputTokens: 30,
          cacheReadInputTokens: 30,
          reasoningOutputTokens: 20,
        },
      },
      delta: { usage: { inputTokens: 100 } },
    });
    if (official) {
      expect(reportedUsage).toMatchObject({
        modelUsage: {
          'deepseek-flash': {
            costUSD: (100 * 0.15 + 30 * 0.003 + 50 * 0.6) / 1e6,
          },
        },
      });
    } else {
      expect(reportedUsage).not.toHaveProperty('modelUsage.deepseek-flash.costUSD');
    }
    expect(created.modes?.currentModeId).toBe('workspace-write');
    expect(selectValue(created.configOptions, 'agent_preset')).toBe('standard');
    expect(selectValue(created.configOptions, 'model')).toBe(
      acpModelId('deepseek-official', 'kimi-k3')
    );
    expect(selectValue(created.configOptions, 'reasoning_effort')).toBe('max');
    expect(selectOption(created.configOptions, 'agent_preset')).toMatchObject({
      options: [
        ...DEEPSEEK_HARNESS_AGENT_PRESETS.map((preset) => ({
          value: preset.value,
          name: preset.name,
          description: preset.description,
        })),
        { value: 'custom', name: 'Custom preset', description: 'User-provided preset' },
      ],
    });
    expect(selectOption(created.configOptions, 'model')).toMatchObject({
      options: [
        expect.objectContaining({ value: acpModelId('deepseek-official', 'kimi-k3') }),
        expect.objectContaining({ value: acpModelId('deepseek-official', 'kimi-k2.6') }),
        expect.objectContaining({
          value: acpModelId('acme-route', 'kimi-k3'),
          name: 'Acme kimi-k3 (acme-route)',
        }),
      ],
    });
    expect(fetchModels).toHaveBeenCalledOnce();
    expect(fetchModels).toHaveBeenCalledWith(
      new URL(modelsUrl),
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.any(Headers),
      })
    );
    const requestHeaders = fetchModels.mock.calls[0]![1]?.headers;
    expect(requestHeaders).toBeInstanceOf(Headers);
    expect((requestHeaders as Headers).get('authorization')).toBe('Bearer sk-test');

    for (const active of [true, false]) {
      const response = await client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'plan_mode',
        type: 'boolean',
        value: active,
      });
      expect(planActive).toBe(active);
      expect(response.configOptions.find((option) => option.id === 'plan_mode')).toMatchObject({
        type: 'boolean',
        currentValue: active,
      });
      expect(currentPermission).toBe('workspace-write');
    }
    await expect(
      client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'plan_mode',
        value: 'true',
      })
    ).rejects.toThrow();

    planPending = true;
    const pendingResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'reasoning_effort',
      value: 'low',
    });
    expect(selectValue(pendingResponse.configOptions, 'plan_mode')).toBe(true);
    expect(planActive).toBe(false);
    planPending = undefined;

    const customRouteResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: acpModelId('acme-route', 'kimi-k3'),
    });
    expect(selectValue(customRouteResponse.configOptions, 'model')).toBe(
      acpModelId('acme-route', 'kimi-k3')
    );
    activeProviders.delete('acme-route');
    await expect(
      client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'model',
        value: acpModelId('acme-route', 'kimi-k3'),
      })
    ).rejects.toThrow(/failed to resolve model route "acme-route" \/ "kimi-k3": no adapter/u);
    activeProviders.add('acme-route');
    const modelResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: acpModelId('deepseek-official', 'kimi-k2.6'),
    });
    expect(selectValue(modelResponse.configOptions, 'model')).toBe(
      acpModelId('deepseek-official', 'kimi-k2.6')
    );

    const effortResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'reasoning_effort',
      value: 'low',
    });
    expect(selectOption(effortResponse.configOptions, 'reasoning_effort')).toMatchObject({
      currentValue: 'low',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    });

    const modeResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'mode',
      value: 'reviewed',
    });
    expect(selectOption(modeResponse.configOptions, 'mode')).toMatchObject({
      currentValue: 'reviewed',
      options: expect.arrayContaining([
        {
          value: 'reviewed',
          name: 'Reviewed writes',
          description: 'Use a deployment-defined review policy',
        },
      ]),
    });
    expect(permissionSwitches).toEqual(['reviewed']);

    const sessionEventListener = harnessListeners.get('session/event');
    expect(sessionEventListener).toBeDefined();
    currentPermission = 'custom';
    await sessionEventListener?.(createdHarnessSession, { type: 'sandbox/mode', data: {} });
    await vi.waitFor(() => {
      expect(sessionUpdates).toEqual(
        expect.arrayContaining([
          {
            sessionId: created.sessionId,
            update: { sessionUpdate: 'current_mode_update', currentModeId: 'custom' },
          },
          {
            sessionId: created.sessionId,
            update: expect.objectContaining({
              sessionUpdate: 'config_option_update',
              configOptions: expect.arrayContaining([
                expect.objectContaining({
                  id: 'mode',
                  currentValue: 'custom',
                  options: expect.arrayContaining([
                    expect.objectContaining({ value: 'custom', name: 'Custom' }),
                  ]),
                }),
              ]),
            }),
          },
        ])
      );
    });

    const presetResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'agent_preset',
      value: 'minimal',
    });
    expect(selectValue(presetResponse.configOptions, 'agent_preset')).toBe('minimal');
    expect(agentPresetSwitches).toEqual(['minimal']);
    expect(selectOption(presetResponse.configOptions, 'plan_mode')).toBeUndefined();
    await expect(
      client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'plan_mode',
        type: 'boolean',
        value: true,
      })
    ).rejects.toThrow();

    const assemblyListener = scopedListeners.get('system-prompt/assemble') as
      | ((
          assembly: unknown,
          context: unknown,
          next: () => Promise<{ variables: Record<string, unknown> }>
        ) => Promise<{ variables: Record<string, unknown> }>)
      | undefined;
    const requestListener = scopedListeners.get('agent/request') as
      | ((
          payload: unknown,
          next: () => Promise<Record<string, unknown>>
        ) => Promise<Record<string, unknown>>)
      | undefined;
    expect(assemblyListener).toBeDefined();
    expect(requestListener).toBeDefined();
    if (!assemblyListener || !requestListener) throw new Error('missing Harness model listeners');

    await assemblyListener({}, {}, async () => ({ variables: {} }));
    await expect(
      requestListener({}, async () => ({
        provider: 'inherited',
        model: 'inherited',
        reasoningEffort: 'high',
        maxTokens: 4096,
      }))
    ).resolves.toMatchObject({
      provider: 'deepseek-official',
      model: 'kimi-k2.6',
      reasoningEffort: 'low',
      maxTokens: 4096,
    });

    const unlistedModel = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'gateway-model',
    });
    expect(selectOption(unlistedModel.configOptions, 'model')).toMatchObject({
      currentValue: acpModelId('deepseek-official', 'gateway-model'),
      options: expect.arrayContaining([
        expect.objectContaining({
          value: acpModelId('deepseek-official', 'gateway-model'),
          name: 'gateway-model (deepseek-official)',
        }),
      ]),
    });

    const noReasoningModel = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'no-reasoning',
    });
    expect(selectOption(noReasoningModel.configOptions, 'reasoning_effort')).toBeUndefined();
    await expect(
      client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'reasoning_effort',
        value: 'high',
      })
    ).rejects.toThrow(/does not support reasoning effort/u);
  });

  it('mounts ACP MCP servers in the Agent scope and releases their namespaces on close', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const mountedConfigs: Array<Record<string, unknown>> = [];
    const disposedSessions: string[] = [];
    const agents = new Map<string, TestAgent>();
    const mcpClientPlugin = { apply: vi.fn() };
    const importMcpClient = vi.fn(() => Promise.resolve(mcpClientPlugin));
    let nextMcpMountFailure: Error | undefined;
    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            get: () => undefined,
            on: () => () => undefined,
            plugin(_plugin, pluginConfig) {
              mountedConfigs.push({ ...pluginConfig });
              return {
                await: async () => {
                  const failure = nextMcpMountFailure;
                  nextMcpMountFailure = undefined;
                  if (failure) throw failure;
                },
              };
            },
            loader: {
              import: importMcpClient,
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          const agent: TestAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup: vi.fn(),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          agents.set(agent.id, agent);
          return {
            agent,
            dispose: async () => {
              disposedSessions.push(agent.id);
              agents.delete(agent.id);
            },
          };
        },
        get: (sessionId) => agents.get(sessionId),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        optionOf: permissionOption,
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        select: async (_agent, id) => id,
      },
      logger: { warn: vi.fn() },
      on: () => () => undefined,
      get: testHarnessService,
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async () => undefined,
      }),
      streams.client
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentCapabilities.mcpCapabilities).toEqual({ http: true });
    expect(initialized.agentCapabilities.sessionCapabilities?.close).toEqual({});

    const first = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [
        {
          name: 'lody',
          command: process.execPath,
          args: ['lody-mcp.js'],
          env: [{ name: 'LODY_MCP_SESSION_ID', value: 'session-1' }],
        },
        {
          type: 'http',
          name: 'remote tools',
          url: 'https://mcp.example.test',
          headers: [{ name: 'Authorization', value: 'Bearer test' }],
        },
      ],
    });
    expect(importMcpClient).toHaveBeenCalledWith('@deepseek-ai/dsh-mcp-client');
    expect(mountedConfigs).toEqual([
      {
        transport: 'stdio',
        serverName: 'lody',
        command: process.execPath,
        args: ['lody-mcp.js'],
        env: { LODY_MCP_SESSION_ID: 'session-1' },
        cwd: process.cwd(),
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      },
      {
        transport: 'streamable-http',
        serverName: expect.stringMatching(/^remote_tools_[a-f0-9]{8}$/u),
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer test' },
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      },
    ]);

    await client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'lody', command: process.execPath, args: [], env: [] }],
    });
    expect(mountedConfigs[2]?.serverName).toMatch(/^lody_[a-f0-9]{8}$/u);

    await client.closeSession({ sessionId: first.sessionId });
    expect(disposedSessions).toContain(first.sessionId);

    await client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'lody', command: process.execPath, args: [], env: [] }],
    });
    expect(mountedConfigs[3]?.serverName).toBe('lody');

    await expect(
      client.newSession({
        cwd: process.cwd(),
        mcpServers: [
          {
            type: 'sse',
            name: 'legacy-sse',
            url: 'https://mcp.example.test/sse',
            headers: [],
          },
        ],
      })
    ).rejects.toThrow(/MCP transport sse is not supported/u);

    nextMcpMountFailure = new Error('MCP startup failed');
    await expect(
      client.newSession({
        cwd: process.cwd(),
        mcpServers: [{ name: 'failing', command: process.execPath, args: [], env: [] }],
      })
    ).rejects.toThrow(/failed to create session: MCP startup failed/u);
    await client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'failing', command: process.execPath, args: [], env: [] }],
    });
    expect(mountedConfigs.at(-1)?.serverName).toBe('failing');
  });

  it('persists ACP images for the selected vision model and rejects them on text models', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const agents = new Map<string, TestAgent>();
    const globalListeners = new Map<string, Listener>();
    const updates: unknown[] = [];
    const queuedMessages: unknown[] = [];
    const attachmentRef = {
      attachmentId: `sha256:${'a'.repeat(64)}`,
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    };
    const saveImages = vi.fn(async () => [attachmentRef]);
    const attachments = {
      imageLimits: { mediaTypes: ['image/png'] },
      saveImages,
      readImage: vi.fn(async (ref: Awaited<ReturnType<typeof saveImages>>[number]) => ({
        data: Uint8Array.of(1, 2, 3),
        ref,
      })),
    };
    const runtimeModels = [
      {
        provider: 'deepseek-official',
        id: 'runtime-text',
        name: 'Runtime text',
        description: 'Discovered text model',
        inputModalities: ['text'],
      },
      {
        provider: 'deepseek-official',
        id: 'runtime-vision',
        name: 'Runtime vision',
        description: 'Discovered vision model',
        inputModalities: ['text', 'image'],
      },
    ];
    const llm = {
      listModels: vi.fn(async () => runtimeModels),
      resolveModelInfo: vi.fn(async (provider: string, modelId: string) => {
        const model = runtimeModels.find((candidate) => candidate.id === modelId);
        if (!model) throw new Error(`unknown model: ${modelId}`);
        return {
          ...model,
          provider,
          reasoning: {
            efforts: [{ id: 'off', name: 'Off' }],
            defaultEffort: 'off',
          },
        };
      }),
    };
    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            get: () => undefined,
            on: () => () => undefined,
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          const agent: TestAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup: (message) => queuedMessages.push(message),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          agents.set(agent.id, agent);
          return { agent, dispose: () => Promise.resolve() };
        },
        get: (sessionId) => agents.get(sessionId),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        optionOf: permissionOption,
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        select: async (_agent, id) => id,
      },
      logger: { warn: vi.fn() },
      on<TArgs extends unknown[]>(
        event: string,
        listener: (...args: TArgs) => unknown
      ): () => void {
        globalListeners.set(event, listener as Listener);
        return () => globalListeners.delete(event);
      },
      get: (service) => {
        if (service === 'attachments') return attachments;
        if (service === 'llm') return llm;
        return testHarnessService(service);
      },
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent, model: 'runtime-vision' });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async (notification) => {
          updates.push(notification);
        },
      }),
      streams.client
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentCapabilities.promptCapabilities.image).toBe(true);
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(selectOption(session.configOptions, 'model')).toMatchObject({
      currentValue: acpModelId('deepseek-official', 'runtime-vision'),
      options: [
        {
          value: acpModelId('deepseek-official', 'runtime-text'),
          name: 'Runtime text (deepseek-official)',
          description: 'Discovered text model',
        },
        {
          value: acpModelId('deepseek-official', 'runtime-vision'),
          name: 'Runtime vision (deepseek-official)',
          description: 'Discovered vision model',
        },
      ],
    });
    expect(
      (
        session as typeof session & {
          models: {
            currentModelId: string;
            availableModels: Array<{ modelId: string }>;
          };
        }
      ).models
    ).toMatchObject({
      currentModelId: acpModelId('deepseek-official', 'runtime-vision'),
      availableModels: expect.arrayContaining([
        expect.objectContaining({ modelId: acpModelId('deepseek-official', 'runtime-text') }),
        expect.objectContaining({
          modelId: `${acpModelId('deepseek-official', 'runtime-text')}[off]`,
        }),
        expect.objectContaining({ modelId: acpModelId('deepseek-official', 'runtime-vision') }),
        expect.objectContaining({
          modelId: `${acpModelId('deepseek-official', 'runtime-vision')}[off]`,
        }),
      ]),
    });
    expect(llm.listModels).toHaveBeenCalledWith('deepseek-official');

    await client.prompt({
      sessionId: session.sessionId,
      prompt: [
        { type: 'text', text: 'What is shown? ' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
        { type: 'text', text: 'Be concise.' },
      ],
    });
    expect(saveImages).toHaveBeenCalledWith([
      { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
    ]);
    expect(llm.resolveModelInfo).toHaveBeenCalledWith(
      'deepseek-official',
      'runtime-vision',
      expect.any(AbortSignal)
    );
    expect(queuedMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown? ' },
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${'a'.repeat(64)}`,
              mediaType: 'image/png',
              bytes: 3,
              width: 1,
              height: 1,
            },
          },
          { type: 'text', text: 'Be concise.' },
        ],
      }),
    ]);

    const sessionEvent = globalListeners.get('session/event');
    const agent = agents.get(session.sessionId);
    if (!sessionEvent || !agent) throw new Error('missing Harness session event listener');
    sessionEvent(agent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'image', attachment: attachmentRef }] } },
    });
    await vi.waitFor(() => {
      expect(updates).toContainEqual({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: 'AQID', mimeType: 'image/png' },
        },
      });
    });
    expect(attachments.readImage).toHaveBeenCalledWith(attachmentRef);

    await client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'runtime-text',
    });
    await expect(
      client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }],
      })
    ).rejects.toThrow(/does not support image input/u);
    expect(saveImages).toHaveBeenCalledTimes(1);
  });

  async function streamingHarness(
    onUpdate: (notification: { sessionId: string; update: Record<string, unknown> }) => void,
    lookup: (name: string, scope: unknown) => unknown = () => undefined,
    onPermission?: (request: { toolCall: unknown }) => void,
    attachments?: unknown,
    subagentUpdate?: (event: Record<string, unknown>) => void
  ) {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const globalListeners = new Map<string, Listener>();
    let createdAgent: TestAgent | undefined;
    const childAgents = new Map<string, TestAgent>();
    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            get: (name) => (name === 'tools' ? { get: lookup } : undefined),
            on: () => () => undefined,
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({ carrierKeyOf: (carrier: unknown) => carrier }),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          createdAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              append() {},
              snapshotEvents: () => [],
            },
            followup: vi.fn(),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          return { agent: createdAgent, dispose: () => Promise.resolve() };
        },
        get: (sessionId) =>
          createdAgent?.id === sessionId ? createdAgent : childAgents.get(sessionId),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        optionOf: permissionOption,
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        select: async (_agent, id) => id,
      },
      logger: { warn: vi.fn() },
      on<TArgs extends unknown[]>(
        event: string,
        listener: (...args: TArgs) => unknown
      ): () => void {
        globalListeners.set(event, listener as Listener);
        return () => globalListeners.delete(event);
      },
      get: (name) => (name === 'attachments' ? attachments : testHarnessService(name)),
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async (request) => {
          onPermission?.(request);
          return { outcome: { outcome: 'selected' as const, optionId: 'allow-once' } };
        },
        sessionUpdate: async (notification) => onUpdate(notification),
        extNotification: async (_method, params) => subagentUpdate?.(params),
      }),
      streams.client
    );
    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: subagentUpdate
        ? { _meta: { lody: { subagentEvents: { version: 1 } } } }
        : {},
    });
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    const sessionEvent = globalListeners.get('session/event');
    const streamEvent = globalListeners.get('agent/assistant-stream');
    if (!createdAgent || !sessionEvent || !streamEvent) {
      throw new Error('missing Harness session or assistant-stream listener');
    }

    return {
      client,
      session,
      agent: createdAgent,
      sessionEvent,
      streamEvent,
      currentAgent: () => createdAgent!,
      claim: globalListeners.get('agent/inbox/claimed')!,
      approval: globalListeners.get('approval/request')!,
      spawnChild: (id: string, nativeId: string, parent = createdAgent!) => {
        const agent = {
          ...createdAgent!,
          id,
          session: { id, header: { id } },
          cancel() {
            globalListeners.get('subagent/end')!({
              id,
              runId: nativeId,
              provider: 'spawn',
              local: true,
              stopReason: 'aborted',
            });
          },
        };
        childAgents.set(id, agent);
        globalListeners
          .get('subagent/start')!
          .call(parent, { id, runId: nativeId, provider: 'spawn', local: true });
        return agent;
      },
      childEnd: (id: string, nativeId: string) =>
        globalListeners.get('subagent/end')!({
          id,
          runId: nativeId,
          provider: 'spawn',
          local: true,
          stopReason: 'completed',
        }),
    };
  }

  it('streams owned descendant runs over ACP without admitting unrelated agents', async () => {
    const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
    const events: LodySubagentEvent[] = [];
    const done = Promise.withResolvers<void>();
    const h = await streamingHarness(
      (value) => updates.push(value),
      undefined,
      undefined,
      undefined,
      (value) => {
        if (!isLodySubagentEvent(value)) return;
        events.push(value);
        if (value.type === 'snapshot' && value.snapshot.state === 'completed') done.resolve();
      }
    );
    const child = h.spawnChild('child', 'native-one');
    h.streamEvent({
      agent: child,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Thinking' } },
    });
    h.sessionEvent(child.session, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'Found it' }] } },
    });
    h.spawnChild('nested', 'native-nested', child);
    const foreign = {
      ...child,
      id: 'foreign',
      session: { id: 'foreign', header: { id: 'foreign' } },
    };
    h.spawnChild('unowned', 'native-foreign', foreign);
    h.childEnd('child', 'native-one');
    h.sessionEvent(child.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'late' }] } },
    });
    await done.promise;
    expect(events.map((event) => event.type)).toEqual([
      'snapshot',
      'output',
      'output',
      'snapshot',
      'snapshot',
    ]);
    expect(events[0]).toMatchObject({
      sessionId: h.session.sessionId,
      snapshot: { parentRunId: null, support: { stream: ['text', 'thought', 'tool'] } },
    });
    expect(events[3]).toMatchObject({ snapshot: { parentRunId: events[0].runId } });
    const roster = await h.client.extMethod('_lody/subagents/list', {
      sessionId: h.session.sessionId,
    });
    expect(roster.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: events[0].runId, status: 'completed' }),
        expect.objectContaining({ taskId: events[3].runId, status: 'running' }),
      ])
    );
    expect((roster.tasks as unknown[]).length).toBe(2);
    expect(
      await h.client.extMethod('_lody/subagents/output', {
        sessionId: h.session.sessionId,
        taskId: events[0].runId,
      })
    ).toEqual({ output: 'Found it\n' });
    await expect(
      h.client.extMethod('_lody/subagents/output', {
        sessionId: h.session.sessionId,
        taskId: 'native-foreign',
      })
    ).rejects.toThrow('unknown subagent');
    expect(
      await h.client.extMethod('_lody/subagents/list', {
        sessionId: h.session.sessionId,
        activeOnly: true,
      })
    ).toEqual({ tasks: [expect.objectContaining({ taskId: events[3].runId })] });

    expect(updates.filter((value) => value.update.sessionUpdate === 'agent_message_chunk')).toEqual(
      []
    );
    await h.client.extMethod('_lody/subagents/cancel', {
      sessionId: h.session.sessionId,
      taskId: events[3].runId,
    });
    expect(
      await h.client.extMethod('_lody/subagents/list', {
        sessionId: h.session.sessionId,
        activeOnly: true,
      })
    ).toEqual({ tasks: [] });
    expect(
      (await h.client.extMethod('_lody/subagents/list', { sessionId: h.session.sessionId })).tasks
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: events[3].runId, status: 'killed' }),
      ])
    );
    h.spawnChild('reused', 'first-activation');
    h.spawnChild('reused', 'replacement-activation');
    const replacements = (
      await h.client.extMethod('_lody/subagents/list', { sessionId: h.session.sessionId })
    ).tasks as Array<{ agentId: string; taskId: string; status: string }>;
    expect(
      replacements.filter((task) => task.agentId === 'reused').map((task) => task.status)
    ).toEqual(['lost', 'running']);
    expect(new Set(replacements.map((task) => task.taskId)).size).toBe(replacements.length);
  });

  it.each([
    { isError: false, content: [{ type: 'text', text: 'done' }], status: 'completed' },
    { isError: true, content: [{ type: 'text', text: 'denied' }], status: 'failed' },
    { isError: false, content: [], status: 'completed' },
  ])(
    'settles a prompt with a $status native tool result ($content)',
    async ({ isError, content, status }) => {
      const updates: Array<{ update: Record<string, unknown> }> = [];
      const h = await streamingHarness((notification) => updates.push(notification));
      h.agent.followup = (message) => {
        h.claim({ agent: h.agent, message, turn: 1 });
        h.sessionEvent(h.agent.session, {
          type: 'tool/call',
          data: { callId: 'result-1', name: 'read', arguments: '{}' },
        });
        h.sessionEvent(h.agent.session, {
          type: 'tool/result',
          data: { message: { role: 'tool', toolCallId: 'result-1', content, isError } },
        });
        h.sessionEvent(h.agent.session, {
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 'completed' } },
        });
      };
      await expect(
        h.client.prompt({
          sessionId: h.session.sessionId,
          prompt: [{ type: 'text', text: 'read' }],
        })
      ).resolves.toEqual({ stopReason: 'end_turn' });
      expect(updates.filter(({ update }) => update.sessionUpdate === 'tool_call_update')).toEqual([
        expect.objectContaining({
          update: expect.objectContaining({
            toolCallId: 'result-1',
            status,
            content: content.map((block) => ({ type: 'content', content: block })),
            rawOutput: { message: { role: 'tool', toolCallId: 'result-1', content, isError } },
          }),
        }),
      ]);
    }
  );

  it('rejects a malformed tool result instead of hiding output failure', async () => {
    const h = await streamingHarness(() => {});
    h.agent.followup = (message) => {
      h.claim({ agent: h.agent, message, turn: 1 });
      h.sessionEvent(h.agent.session, {
        type: 'tool/result',
        data: { message: { role: 'tool', content: [{ type: 'text', text: 'missing call id' }] } },
      });
    };
    await expect(
      h.client.prompt({
        sessionId: h.session.sessionId,
        prompt: [{ type: 'text', text: 'read' }],
      })
    ).rejects.toThrow('assistant output delivery failed');
  });

  it('delivers tool details, nested calls, approval and terminal failures through ACP', async () => {
    const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
    let finished!: () => void;
    const received = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let permission: unknown;
    const scopes: unknown[] = [];
    const fixture = await streamingHarness(
      (notification) => {
        updates.push(notification);
        if (notification.update.sessionUpdate === 'agent_message_chunk') finished();
      },
      (name, scope) => {
        scopes.push(scope);
        if (name === 'bash')
          return {
            presentCall: (args: { command: string }) => ({ card: 'terminal', title: args.command }),
            presentResult: () => ({ card: 'terminal', output: 'hello', exitCode: 0 }),
          };
        if (name === 'edit')
          return {
            presentCall: () => ({
              card: 'diff',
              title: 'Edit a.ts',
              locations: [{ path: 'a.ts', line: 1 }],
              diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
            }),
            presentResult: (_args: unknown, result: { meta: unknown }) => result.meta,
          };
        if (name === 'broken')
          return {
            presentCall: () => {
              throw new Error('bad presenter');
            },
          };
        return undefined;
      },
      (request) => {
        permission = request.toolCall;
      }
    );
    const { agent, sessionEvent, approval, session } = fixture;
    const event = (type: string, data: unknown) => sessionEvent(agent.session, { type, data });
    const result = (
      id: string,
      isError = false,
      content: unknown[] = [{ type: 'text', text: 'done' }],
      meta?: unknown
    ) =>
      event('tool/result', {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: id, isError, content },
        ...(meta === undefined ? {} : { meta }),
      });
    event('tool/call', { callId: 'shell', name: 'bash', arguments: '{"command":"echo hello"}' });
    // A duplicate start must not create a second card. Foreign session instances are ignored.
    event('tool/call', { callId: 'shell', name: 'bash', arguments: '{}' });
    sessionEvent(
      { ...agent.session },
      { type: 'tool/call', data: { callId: 'foreign', name: 'bash', arguments: '{}' } }
    );
    expect(await approval({ agent, callId: 'shell' }, async () => 'unowned')).toBe('allowed-once');
    expect(permission).toMatchObject({
      toolCallId: 'shell',
      title: 'echo hello',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'echo hello' },
    });
    expect(updates.map(({ update }) => update)).toHaveLength(1);
    result('shell');
    event('tool/call', { callId: 'edit', name: 'edit', arguments: '{"path":"a.ts"}' });
    result('edit', false, [{ type: 'text', text: 'applied' }], {
      card: 'diff',
      diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
    });
    event('tool/call', { callId: 'bad-edit', name: 'edit', arguments: '{}' });
    result('bad-edit', true, [{ type: 'text', text: 'permission denied' }], {
      card: 'diff',
      diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
    });
    event('tool/call', {
      callId: 'ptc',
      name: 'run_code',
      arguments: '{"code":"await tools.read({path: \"a.ts\"})"}',
    });
    const nested = {
      rootCallId: 'ptc',
      parentCallId: 'ptc',
      subCallId: 'ptc:ptc:1',
      name: 'read',
      arguments: { path: 'a.ts' },
    };
    event('tool/ptc-dispatch-start', nested);
    event('tool/ptc-dispatch', {
      ...nested,
      isError: false,
      content: [{ type: 'text', text: 'new' }],
    });
    result('ptc');
    event('tool/call', {
      callId: 'mcp',
      name: 'mcp__test__fetch',
      arguments: '{"url":"https://example.test"}',
    });
    result('mcp', true, [{ type: 'text', text: 'ABORTED_BEFORE_DISPATCH' }]);
    event('tool/call', { callId: 'broken', name: 'broken', arguments: '{invalid' });
    result('broken', false, [
      { type: 'future-block', value: 'preserved' },
      { type: 'image', attachment: {} },
    ]);
    event('tool/call', {
      callId: 'interrupted',
      name: 'bash',
      arguments: '{"command":"long job"}',
    });
    event('turn/end', { turn: 1, reason: { kind: 'aborted' } });
    event('assistant/message', { message: { content: [{ type: 'text', text: 'barrier' }] } });
    await received;
    const tools = updates.map(({ update }) => update).filter((update) => 'toolCallId' in update);
    const starts = tools.filter((update) => update.sessionUpdate === 'tool_call');
    const ends = tools.filter((update) => update.sessionUpdate === 'tool_call_update');
    expect(starts.map((update) => update.toolCallId)).toEqual([
      'shell',
      'edit',
      'bad-edit',
      'ptc',
      'ptc:ptc:1',
      'mcp',
      'broken',
      'interrupted',
    ]);
    expect(ends.map((update) => [update.toolCallId, update.status])).toEqual([
      ['shell', 'completed'],
      ['edit', 'completed'],
      ['bad-edit', 'failed'],
      ['ptc:ptc:1', 'completed'],
      ['ptc', 'completed'],
      ['mcp', 'failed'],
      ['broken', 'completed'],
      ['interrupted', 'failed'],
    ]);
    expect(ends[0]).toMatchObject({
      content: [{ type: 'content', content: { type: 'text', text: 'hello' } }],
      rawOutput: { message: { role: 'tool', toolCallId: 'shell', isError: false } },
    });
    expect(starts[1]).toMatchObject({ locations: [{ path: `${process.cwd()}/a.ts`, line: 1 }] });
    expect(starts[1]).not.toHaveProperty('content');
    expect(ends[1]).toMatchObject({
      content: [
        expect.anything(),
        { type: 'diff', path: `${process.cwd()}/a.ts`, oldText: 'old', newText: 'new' },
      ],
    });
    expect(ends[2]).toMatchObject({
      content: [{ type: 'content', content: { text: 'permission denied' } }],
    });
    expect(starts[6]).toMatchObject({ title: 'broken', rawInput: '{invalid' });
    expect(ends[6]).toMatchObject({
      content: [
        { type: 'content', content: { text: '{"type":"future-block","value":"preserved"}' } },
        { type: 'content', content: { text: 'Tool attachment unavailable.' } },
      ],
    });
    expect(ends[7]).toMatchObject({
      content: [
        { type: 'content', content: { text: expect.stringContaining('outcome is unknown') } },
      ],
    });
    expect(updates.every((update) => update.sessionId === session.sessionId)).toBe(true);
    expect(scopes.every((scope) => scope === agent)).toBe(true);
  });

  it('keeps overlapping sessions isolated and awaits image output before later notifications', async () => {
    const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
    let releaseImage!: () => void;
    const imageReady = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let done!: () => void;
    const received = new Promise<void>((resolve) => {
      done = resolve;
    });
    const fixture = await streamingHarness(
      (notification) => {
        updates.push(notification);
        if (notification.update.sessionUpdate === 'agent_message_chunk') done();
      },
      undefined,
      undefined,
      {
        imageLimits: { mediaTypes: ['image/png'] },
        saveImages: async () => [],
        readImage: async (ref: unknown) => {
          readStarted();
          await imageReady;
          return { ref, data: new Uint8Array([1, 2, 3]) };
        },
      }
    );
    const second = await fixture.client.newSession({ cwd: process.cwd(), mcpServers: [] });
    const agent2 = fixture.currentAgent();
    for (const agent of [fixture.agent, agent2])
      fixture.sessionEvent(agent.session, {
        type: 'tool/call',
        data: { callId: 'same-id', name: 'read', arguments: JSON.stringify({ session: agent.id }) },
      });
    const content = [
      {
        type: 'image',
        attachment: {
          attachmentId: 'synthetic-image',
          mediaType: 'image/png',
          bytes: 3,
          width: 1,
          height: 1,
        },
      },
    ];
    fixture.sessionEvent(fixture.agent.session, {
      type: 'tool/result',
      data: { message: { role: 'tool', toolCallId: 'same-id', content } },
    });
    fixture.sessionEvent(fixture.agent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'after image' }] } },
    });
    await reading;
    // A permission request on the other live session flushes that session's queue only.
    expect(
      await fixture.approval({ agent: agent2, callId: 'same-id' }, async () => 'unowned')
    ).toBe('allowed-once');
    expect(updates.filter((n) => n.update.sessionUpdate === 'tool_call_update')).toEqual([]);
    releaseImage();
    await received;
    const first = updates.filter((n) => n.sessionId === fixture.session.sessionId);
    expect(first.map((n) => n.update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    expect(first[1]?.update).toMatchObject({
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'image', data: 'AQID', mimeType: 'image/png' } },
      ],
    });
    expect(updates.filter((n) => n.sessionId === second.sessionId).map((n) => n.update)).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        rawInput: { session: second.sessionId },
      }),
    ]);
  });

  it('streams Harness reasoning and compaction lifecycle updates', async () => {
    const updates: unknown[] = [];
    let markUpdated: (() => void) | undefined;
    const updated = new Promise<void>((resolve) => {
      markUpdated = resolve;
    });
    const {
      session,
      agent: createdAgent,
      sessionEvent,
      streamEvent,
    } = await streamingHarness((notification) => {
      updates.push(notification);
      if (updates.length === 8) markUpdated?.();
    });

    streamEvent({
      agent: createdAgent,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'First thought. ' } },
    });
    streamEvent({
      agent: createdAgent,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '' } },
    });
    streamEvent({
      agent: createdAgent,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Second thought.' } },
    });
    streamEvent({
      agent: createdAgent,
      frame: {
        type: 'chunk',
        chunk: { type: 'text-delta', text: 'not forwarded before the final message' },
      },
    });
    streamEvent({
      agent: createdAgent,
      frame: { type: 'chunk', chunk: { type: 'block-end', block: { type: 'reasoning' } } },
    });
    streamEvent({
      agent: createdAgent,
      frame: { type: 'chunk', chunk: { type: 'block-end', block: { type: 'text' } } },
    });
    sessionEvent(createdAgent.session, {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'First thought. Second thought.' },
            { type: 'text', text: 'Final answer.' },
          ],
        },
      },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/start',
      data: { compactionId: 'manual-1', turn: null },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/end',
      data: { compactionId: 'manual-1', turn: null },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/start',
      data: { compactionId: 'automatic-1', turn: 2 },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/end',
      data: { compactionId: 'automatic-1', turn: 2, error: 'summary failed' },
    });

    await updated;
    expect(updates).toEqual([
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'First thought. ' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Second thought.' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '\n\n' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Final answer.' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'context-compaction:manual-1',
          title: 'Compacting context',
          kind: 'think',
          status: 'in_progress',
          _meta: {
            lody: {
              activity: { version: 1, kind: 'context_compaction', automatic: false },
            },
          },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'context-compaction:manual-1',
          title: 'Context compacted',
          status: 'completed',
          _meta: {
            lody: {
              activity: { version: 1, kind: 'context_compaction', automatic: false },
            },
          },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'context-compaction:automatic-1',
          title: 'Compacting context',
          kind: 'think',
          status: 'in_progress',
          _meta: {
            lody: {
              activity: { version: 1, kind: 'context_compaction', automatic: true },
            },
          },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'context-compaction:automatic-1',
          title: 'Context compaction failed',
          status: 'failed',
          _meta: {
            lody: {
              activity: {
                version: 1,
                kind: 'context_compaction',
                automatic: true,
                failureReason: 'summary failed',
              },
            },
          },
        },
      },
    ]);
  });

  it('keeps a cancelled prompt slot until its Harness agent is idle', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    let createdAgent: TestAgent | undefined;
    let markQueued: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve;
    });
    let markIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      markIdle = resolve;
    });
    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            get: () => undefined,
            on: () => () => undefined,
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          createdAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup: () => markQueued?.(),
            cancel: vi.fn(),
            whenIdle: () => idle,
          };
          return { agent: createdAgent, dispose: () => Promise.resolve() };
        },
        get: (sessionId) => (createdAgent?.id === sessionId ? createdAgent : undefined),
      },
      permissionPresets: {
        names: ['workspace-write'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        optionOf: permissionOption,
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        select: async (_agent, id) => id,
      },
      logger: { warn: vi.fn() },
      on: () => () => undefined,
      get: testHarnessService,
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async () => undefined,
      }),
      streams.client
    );
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    const firstPrompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    await queued;

    await client.cancel({ sessionId: session.sessionId });
    await expect(
      client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      })
    ).rejects.toThrow(/already in flight/u);
    expect(createdAgent?.cancel).toHaveBeenCalledWith({ kind: 'user' });

    markIdle?.();
    await expect(firstPrompt).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('rejects the active ACP prompt when Harness reports an error for its turn', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const globalListeners = new Map<string, Listener>();
    let createdAgent: TestAgent | undefined;
    let queuedMessage: { id: string } | undefined;
    let markQueued: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve;
    });
    let markIdle: (() => void) | undefined;
    const remainsBusy = new Promise<void>((resolve) => {
      markIdle = resolve;
    });

    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            get: () => undefined,
            on: () => () => undefined,
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          createdAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup(message) {
              queuedMessage = message;
              markQueued?.();
            },
            cancel: vi.fn(),
            whenIdle: () => remainsBusy,
          };
          return { agent: createdAgent, dispose: () => Promise.resolve() };
        },
        get: (sessionId) => (createdAgent?.id === sessionId ? createdAgent : undefined),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        optionOf: permissionOption,
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }, { id: 'minimal' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        select: async (_agent, id) => id,
      },
      logger: { warn: vi.fn() },
      on<TArgs extends unknown[]>(
        event: string,
        listener: (...args: TArgs) => unknown
      ): () => void {
        globalListeners.set(event, listener as Listener);
        return () => globalListeners.delete(event);
      },
      get: testHarnessService,
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async () => undefined,
      }),
      streams.client
    );
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    await queued;
    await expect(
      client.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'agent_preset',
        value: 'minimal',
      })
    ).rejects.toThrow(/fixed after the session has started/u);
    if (!createdAgent || !queuedMessage) throw new Error('prompt was not queued');
    const inboxClaimed = globalListeners.get('agent/inbox/claimed');
    const agentError = globalListeners.get('agent/error');
    if (!inboxClaimed || !agentError) throw new Error('missing Harness lifecycle listeners');
    inboxClaimed({ agent: createdAgent, message: queuedMessage, turn: 7 });
    agentError({ agent: createdAgent, turn: 7, error: new Error('provider failed') });
    markIdle?.();

    await expect(prompt).rejects.toThrow(/turn failed: provider failed/u);
  });
});
