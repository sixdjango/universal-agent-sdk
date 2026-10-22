import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  DEEPSEEK_HARNESS_PROFILE_NAME,
  createDeepSeekHarnessProfileFiles,
} from '../dist/profile.js';

// Supply a preinstalled exact profile closure; this test never installs packages
// or sends a model request. See README.md for preparation outside the test.
const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT;
assert.ok(runtimeRoot, 'Set DSH_TEST_RUNTIME_ROOT to the installed Harness node_modules directory');
const runtimeRequire = createRequire(join(runtimeRoot, '.settings-profile-test.cjs'));
const extensionRoot = fileURLToPath(new URL('../', import.meta.url));

// Resolve the launcher through the preinstalled runtime closure.
const dshBin = join(dirname(runtimeRequire.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');

function decodeModelRoute(value) {
  if (!value.startsWith('dsh-route:')) return undefined;
  const decoded = JSON.parse(
    Buffer.from(value.slice('dsh-route:'.length), 'base64url').toString('utf8')
  );
  return Array.isArray(decoded) && decoded.length === 2 ? decoded : undefined;
}

const cases = [
  {
    name: 'settings catalog is available to the first ACP request',
    settings:
      '# preserved comment\nllm-deepseek:\n  models:\n    - id: synthetic-settings-model\n      name: Synthetic settings model\n',
    expectedModel: 'synthetic-settings-model',
    discoveryCredential: true,
  },
  {
    name: 'unlisted pi-ai route is selectable and missing credential fails before provider I/O',
    settings: `llm-pi-ai:
  providers:
    synthetic-route:
      displayName: Synthetic route
      apiKeyEnv: SYNTHETIC_ROUTE_API_KEY
      api: openai-completions
      baseURL: https://provider.invalid/v1
      models:
        - id: shared-model
          name: Shared model
          contextWindow: 32768
          maxTokens: 4096
`,
    expectedProvider: 'synthetic-route',
    expectedModel: 'shared-model',
    missingCredential: true,
  },
  { name: 'absent settings retain defaults', expectedModel: 'deepseek-flash' },
  {
    name: 'unavailable configured preset falls back to standard',
    settings: 'agent-presets:\n  default: missing\n',
    expectedModel: 'deepseek-flash',
  },
  {
    name: 'legacy custom preset remains selectable and survives restoration',
    settings: 'agent-presets:\n  default: synthetic-custom\n',
    expectedModel: 'deepseek-flash',
    customPreset: true,
  },
  { name: 'invalid YAML rejects initialization', settings: 'llm-deepseek: [\n', invalid: true },
  {
    name: 'non-mapping settings document rejects initialization',
    settings: '- invalid-settings-document\n',
    invalid: true,
  },
];

for (const fixture of cases) {
  await test(fixture.name, { timeout: 60_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-settings-test-'));
    let child;
    let exited;
    t.after(async () => {
      try {
        child?.kill();
        await exited;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const settingsPath = join(root, 'settings.yaml');
    if (fixture.settings !== undefined) await writeFile(settingsPath, fixture.settings);
    await mkdir(join(root, 'sessions'), { recursive: true });
    if (fixture.customPreset) {
      const custom = join(root, '.agent-presets', 'synthetic-custom');
      await mkdir(custom, { recursive: true });
      await writeFile(join(custom, 'preset.yml'), 'name: Synthetic custom\n');
      await writeFile(
        join(custom, 'agent.cordis.yml'),
        '- name: ./plugin.mjs\n  config:\n    marker: !!js baseUrl\n- name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: Synthetic custom preset\n'
      );
      await writeFile(
        join(custom, 'plugin.mjs'),
        "import { realpathSync } from 'node:fs'; export function apply(ctx, config) { if (realpathSync(new URL(config.marker)) !== realpathSync(new URL('.', import.meta.url))) throw new Error('wrong preset expression base'); }\n"
      );
    }

    const profileDir = join(root, 'profiles', DEEPSEEK_HARNESS_PROFILE_NAME);
    await mkdir(profileDir, { recursive: true });
    const files = createDeepSeekHarnessProfileFiles({
      adapterPath: join(extensionRoot, 'dist/index.js'),
      presetRoot: join(extensionRoot, 'presets'),
    });
    await writeFile(join(profileDir, 'package.json'), files.packageJson);
    await writeFile(join(profileDir, 'cordis.yml'), files.cordisYml);
    await writeFile(join(profileDir, 'cordis.patch.yml'), files.cordisPatchYml);
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), files.pnpmWorkspaceYaml);

    child = spawn(process.execPath, [dshBin, '--profile', DEEPSEEK_HARNESS_PROFILE_NAME], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        DSH_HOME: root,
        // Native discovery now requires credentials; this synthetic key is never sent.
        ...(fixture.discoveryCredential ? { DEEPSEEK_API_KEY: 'synthetic-settings-test-key' } : {}),
        ACP_EXTENSION_DSH_SESSION_ROOT: join(root, 'sessions'),
        ACP_EXTENSION_DSH_QUERY_PATH: join(root, 'sessions/query.db'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: t.signal,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    exited = once(child, 'exit');
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    );
    try {
      const initialized = connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      if (fixture.invalid) {
        await assert.rejects(initialized, /settings|YAML/iu);
      } else {
        await initialized;
        const session = await connection.newSession({ cwd: root, mcpServers: [] });
        const presets = session.configOptions.find((option) => option.id === 'agent_preset');
        assert.deepEqual(
          presets.options.map((option) => option.value).sort(),
          [
            'cordis',
            'minimal',
            'ptc',
            'standard',
            ...(fixture.customPreset ? ['synthetic-custom'] : []),
          ].sort()
        );
        assert.equal(presets.currentValue, fixture.customPreset ? 'synthetic-custom' : 'standard');
        for (const preset of [
          'minimal',
          'ptc',
          'cordis',
          'standard',
          ...(fixture.customPreset ? ['synthetic-custom'] : []),
        ]) {
          const changed = await connection.setSessionConfigOption({
            sessionId: session.sessionId,
            configId: 'agent_preset',
            value: preset,
          });
          assert.equal(
            changed.configOptions.find((option) => option.id === 'agent_preset').currentValue,
            preset
          );
        }
        const model = session.configOptions.find((option) => option.id === 'model');
        let target = model.options.find((option) => {
          const [provider, modelId] = decodeModelRoute(option.value) ?? [];
          return (
            modelId === fixture.expectedModel &&
            (fixture.expectedProvider === undefined || provider === fixture.expectedProvider)
          );
        });
        if (fixture.missingCredential) {
          assert.equal(target, undefined, 'native catalog hides routes without credentials');
          target = {
            value: `dsh-route:${Buffer.from(
              JSON.stringify([fixture.expectedProvider, fixture.expectedModel])
            ).toString('base64url')}`,
          };
        }
        assert.ok(target, JSON.stringify(model.options));
        if (fixture.settings?.startsWith('# preserved comment')) {
          assert.ok(
            !model.options.some(
              (option) => decodeModelRoute(option.value)?.[1] === 'deepseek-v4-pro'
            )
          );
        }
        await connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: 'model',
          value: target.value,
        });
        await connection.setSessionMode({ sessionId: session.sessionId, modeId: 'read-only' });
        await connection.closeSession({ sessionId: session.sessionId });
        const loaded = await connection.loadSession({
          sessionId: session.sessionId,
          cwd: root,
          mcpServers: [],
        });
        assert.equal(
          loaded.configOptions.find((option) => option.id === 'model').currentValue,
          target.value
        );
        assert.equal(loaded.modes.currentModeId, 'read-only');
        assert.equal(
          loaded.configOptions.find((option) => option.id === 'agent_preset').currentValue,
          fixture.customPreset ? 'synthetic-custom' : 'standard'
        );
        if (fixture.missingCredential) {
          await connection.setSessionConfigOption({
            sessionId: session.sessionId,
            configId: 'model',
            value: target.value,
          });
          await assert.rejects(
            connection.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'Synthetic credential boundary probe' }],
            }),
            /MISSING_CREDENTIAL|credential/iu
          );
        }
      }
      if (fixture.settings !== undefined) {
        assert.equal(await readFile(settingsPath, 'utf8'), fixture.settings);
      } else {
        await assert.rejects(readFile(settingsPath), { code: 'ENOENT' });
      }
    } catch (error) {
      t.diagnostic(stderr);
      throw error;
    }
  });
}
