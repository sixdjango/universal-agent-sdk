import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCustomAcpCommandLine,
  parseCustomAcpCommandLine,
} from '../src/launcher/custom-acp-command';
import {
  BUILTIN_AGENT_TYPES,
  detectAgentExecutable,
  listDetectableAgents,
  resolveAgentExecutable,
} from '../src/launcher/executable-resolver';
import {
  getRegistryAgent,
  isRegistryAgentType,
  listRegistryAgents,
} from '../src/launcher/registry';
import {
  resolveACPProcessLaunchAsync,
  resolveBundledAdapterEntry,
  withLoopbackNoProxy,
} from '../src/launcher/setting';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const distDir = resolve(pkgRoot, 'dist');

function createDummyBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const isWin = process.platform === 'win32';
  const filePath = join(dir, isWin ? `${name}.cmd` : name);
  writeFileSync(filePath, isWin ? '@ECHO OFF\r\n' : '#!/bin/sh\nexit 0\n');
  if (!isWin) {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

describe('launcher & 7 built-in agent resolution', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('verifies all 7 flat adapter entries and index.js exist in dist/', () => {
    const expectedFiles = [
      'index.js',
      'claude-acp.js',
      'codex-acp.js',
      'kimi-acp.js',
      'deepseek-acp.js',
      'grok-acp.js',
      'devin-acp.js',
      'pi-acp.js',
      'extension.js',
    ];
    for (const file of expectedFiles) {
      expect(existsSync(join(distDir, file)), `Expected dist/${file} to exist`).toBe(true);
    }
    expect(existsSync(join(distDir, 'deepseek-agent-presets'))).toBe(true);
    expect(existsSync(join(distDir, 'chunks'))).toBe(false);
  });

  it('resolves all 7 built-in agents and custom agent launch specs accurately', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'ua-bins-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'ua-data-'));
    tempDirs.push(binDir, dataDir);

    const binaries: Record<string, string> = {};
    for (const name of ['claude', 'codex', 'kimi', 'pi', 'npx', 'grok', 'devin', 'bub', 'dimcode']) {
      binaries[name] = createDummyBinary(binDir, name);
    }

    const baseInput = {
      env: { PATH: binDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      loginShellEnv: null,
      probeLoginShell: false,
      homeDir: dataDir,
      dataDir,
    };

    // 1. Claude
    const claudeLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'claude',
      extraArgs: ['--verbose'],
    });
    expect(claudeLaunch.command).toBe(process.execPath);
    expect(claudeLaunch.args[0]).toBe(resolveBundledAdapterEntry('claude-acp'));
    expect(claudeLaunch.args).toContain('--verbose');
    expect(claudeLaunch.env?.CLAUDE_CODE_EXECUTABLE).toBe(binaries.claude);

    // 2. Codex
    const codexLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'codex',
    });
    expect(codexLaunch.command).toBe(process.execPath);
    expect(codexLaunch.args[0]).toBe(resolveBundledAdapterEntry('codex-acp'));
    expect(codexLaunch.args).toContain('features.goals=true');
    expect(codexLaunch.env?.CODEX_PATH).toBe(binaries.codex);

    // 3. Kimi
    const kimiLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'kimi',
    });
    expect(kimiLaunch.command).toBe(binaries.kimi);
    expect(kimiLaunch.args[0]).toBe('acp');
    expect(kimiLaunch.env?.KIMI_CODE_NO_AUTO_UPDATE).toBe('1');

    // 4. Pi
    const piLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'pi',
      piExtensions: ['/tmp/custom-ext.js'],
    });
    expect(piLaunch.command).toBe(process.execPath);
    expect(piLaunch.args[0]).toBe(resolveBundledAdapterEntry('pi-acp'));
    expect(piLaunch.args).toContain('/tmp/custom-ext.js');
    expect(piLaunch.env?.UA_PI_PATH).toBe(binaries.pi);
    expect(piLaunch.env?.LODY_PI_PATH).toBe(binaries.pi);

    // 5. DeepSeek Harness (falls back to npx when dsh binary is not installed, or uses local dsh binary directly when present)
    const dshNpxFallbackLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'deepseek',
      providerId: 'test-provider',
    });
    expect(dshNpxFallbackLaunch.command).toBe('npx');
    expect(dshNpxFallbackLaunch.env?.DSH_HOME).toContain('test-provider');

    binaries.dsh = createDummyBinary(binDir, 'dsh');
    const dshLocalLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'deepseek',
      providerId: 'test-provider',
    });
    expect(dshLocalLaunch.command).toBe(binaries.dsh);
    expect(dshLocalLaunch.args[0]).toBe('--profile');
    expect(dshLocalLaunch.env?.DSH_HOME).toContain('test-provider');

    // 6. Grok
    const grokLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'grok',
    });
    expect(grokLaunch.command).toBe(process.execPath);
    expect(grokLaunch.args[0]).toBe(resolveBundledAdapterEntry('grok-acp'));
    expect(grokLaunch.env?.GROK_PATH).toBe(binaries.grok);
    expect(grokLaunch.env?.GROK_DISABLE_AUTOUPDATER).toBe('1');

    // 7. Devin
    const devinLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'devin',
    });
    expect(devinLaunch.command).toBe(process.execPath);
    expect(devinLaunch.args[0]).toBe(resolveBundledAdapterEntry('devin-acp'));
    expect(devinLaunch.env?.DEVIN_PATH).toBe(binaries.devin);

    // 8. Bub & Dimcode (native ACP builtins)
    const bubLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'bub',
    });
    expect(bubLaunch.command).toBe(binaries.bub);
    expect(bubLaunch.args).toEqual(['acp']);

    const dimcodeLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'dimcode',
    });
    expect(dimcodeLaunch.command).toBe(binaries.dimcode);
    expect(dimcodeLaunch.args).toEqual(['acp']);
    expect(dimcodeLaunch.env?.DIMCODE_DISABLE_AUTOUPDATE).toBe('1');

    // 9. Custom
    const customLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'custom',
      customCommand: {
        command: 'opencode',
        args: ['acp'],
        env: { OPENCODE_MODE: 'test' },
      },
    });
    expect(customLaunch.command).toBe('opencode');
    expect(customLaunch.args).toEqual(['acp']);
    expect(customLaunch.env?.OPENCODE_MODE).toBe('test');
  });

  it('resolves all 37+ ACP Registry agents (antigravity-acp, gemini, cursor, opencode, qwen-code, etc.) with local-first priority', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'ua-reg-bins-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'ua-reg-data-'));
    tempDirs.push(binDir, dataDir);

    expect(listRegistryAgents().length).toBeGreaterThanOrEqual(37);
    expect(isRegistryAgentType('antigravity-acp')).toBe(true);
    expect(isRegistryAgentType('antigravity')).toBe(true);
    expect(isRegistryAgentType('agy')).toBe(true);
    expect(getRegistryAgent('antigravity')?.id).toBe('antigravity-acp');

    const baseInput = {
      env: { PATH: binDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      loginShellEnv: null,
      probeLoginShell: false,
      homeDir: dataDir,
      dataDir,
    };

    // Gemini falls back to npx when not locally installed
    const geminiNpx = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'gemini',
    });
    expect(geminiNpx.command).toBe('npx');
    expect(geminiNpx.args).toContain('@google/gemini-cli@0.64.0');
    expect(geminiNpx.args).toContain('--acp');

    // When gemini is installed locally in PATH, it prefers the local binary over npx
    const localGeminiBin = createDummyBinary(binDir, 'gemini');
    const geminiLocal = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'gemini',
    });
    expect(geminiLocal.command).toBe(localGeminiBin);
    expect(geminiLocal.args).toEqual(['--acp']);

    // Antigravity (via alias 'antigravity' or 'antigravity-acp') uses local agy_acp_server.par when present
    const localAgyServer = createDummyBinary(binDir, 'agy_acp_server.par');
    const agyLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'antigravity',
    });
    expect(agyLaunch.command).toBe(localAgyServer);
    expect(agyLaunch.capabilitySourceVersion).toBe('antigravity-acp@1.4.1');

    // OpenCode & Cursor local registry agents
    const localOpencode = createDummyBinary(binDir, 'opencode');
    const opencodeLaunch = await resolveACPProcessLaunchAsync({
      ...baseInput,
      agentType: 'opencode',
    });
    expect(opencodeLaunch.command).toBe(localOpencode);
    expect(opencodeLaunch.args).toEqual(['acp']);

    // Custom command line tokenizer round-trip
    const parsed = parseCustomAcpCommandLine('"/path/with spaces/my-agent" --acp --flag="hello world"');
    expect(parsed).toEqual({
      command: '/path/with spaces/my-agent',
      args: ['--acp', '--flag=hello world'],
    });
    expect(formatCustomAcpCommandLine(parsed!)).toBe(
      '"/path/with spaces/my-agent" --acp "--flag=hello world"'
    );
  });

  it('detects found and not-found agents via listDetectableAgents and prioritizes executablePath override', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'ua-empty-'));
    const customDir = mkdtempSync(join(tmpdir(), 'ua-custom-'));
    tempDirs.push(emptyDir, customDir);

    const claudeOverride = createDummyBinary(customDir, 'my-claude');
    const defaultKimiDir = join(emptyDir, '.kimi-code', 'bin');
    const defaultKimiBin = createDummyBinary(defaultKimiDir, 'kimi');

    const detected = await listDetectableAgents({
      env: { PATH: emptyDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      executablePaths: { claude: claudeOverride },
      probeLoginShell: false,
      homeDir: emptyDir,
    });

    expect(detected).toHaveLength(BUILTIN_AGENT_TYPES.length);
    const claude = detected.find((d) => d.agentType === 'claude');
    expect(claude).toEqual({
      agentType: 'claude',
      found: true,
      resolvedPath: claudeOverride,
      source: 'override',
    });

    const kimi = detected.find((d) => d.agentType === 'kimi');
    expect(kimi).toEqual({
      agentType: 'kimi',
      found: true,
      resolvedPath: defaultKimiBin,
      source: 'default-dir',
    });

    const codex = detected.find((d) => d.agentType === 'codex');
    expect(codex).toEqual({
      agentType: 'codex',
      found: false,
    });

    await expect(
      resolveAgentExecutable('codex', {
        env: { PATH: emptyDir },
        loginShellEnv: null,
        probeLoginShell: false,
        homeDir: emptyDir,
      })
    ).rejects.toThrow(/Could not locate executable \(codex\).*pass executablePath/);
  });

  it('appends loopback hosts to NO_PROXY / no_proxy when any proxy variable is set', () => {
    const noProxyEnv = withLoopbackNoProxy<NodeJS.ProcessEnv>({ PATH: '/usr/bin' });
    expect(noProxyEnv.NO_PROXY).toBeUndefined();

    const proxiedEnv = withLoopbackNoProxy<NodeJS.ProcessEnv>({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'internal.corp',
    });
    expect(proxiedEnv.NO_PROXY).toBe('internal.corp,localhost,127.0.0.1,::1');
    expect(proxiedEnv.no_proxy).toBe('internal.corp,localhost,127.0.0.1,::1');
  });
});
