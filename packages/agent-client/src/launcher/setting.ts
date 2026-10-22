import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEEPSEEK_HARNESS_BASE_URL_ENV,
  DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION,
  resolveDeepSeekHarnessProcessLaunch,
} from './deepseek-runtime';
import {
  type BuiltinAgentType,
  DEFAULT_ACP_RELATIVE_DIRS,
  expandHomePath,
  isBuiltinAgentType,
  resolveAgentExecutable,
} from './executable-resolver';

export type BundledAdapterName =
  | 'claude-acp'
  | 'codex-acp'
  | 'kimi-acp'
  | 'deepseek-acp'
  | 'grok-acp'
  | 'devin-acp'
  | 'pi-acp';

export interface CustomAcpLaunchSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ResolveACPProcessLaunchInput {
  agentType: BuiltinAgentType | 'custom';
  executablePath?: string;
  customCommand?: CustomAcpLaunchSpec;
  piExtensions?: string[];
  extraArgs?: string[];
  dataDir?: string;
  providerId?: string;
  env?: NodeJS.ProcessEnv;
  loginShellEnv?: NodeJS.ProcessEnv | null;
  probeLoginShell?: boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface ResolvedACPProcessLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  capabilitySourceVersion?: string;
}

export const PROXY_ENV_KEYS = [
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'npm_config_proxy',
  'npm_config_http_proxy',
  'npm_config_https_proxy',
] as const;

export const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;
export const DEFAULT_NO_PROXY = LOOPBACK_NO_PROXY_HOSTS.join(',');

const isSet = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

export function hasProxyEnvValue(env: Record<string, string | undefined>): boolean {
  return PROXY_ENV_KEYS.some((key) => isSet(env[key]));
}

export function mergeLoopbackNoProxy(
  upper: string | undefined,
  lower: string | undefined
): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const raw of [upper, lower]) {
    for (const part of (raw ?? '').split(',')) {
      const entry = part.trim();
      if (entry.length === 0) {
        continue;
      }
      if (entry === '*') {
        return '*';
      }
      const key = entry.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    if (!seen.has(host)) {
      seen.add(host);
      entries.push(host);
    }
  }
  return entries.join(',');
}

export function withLoopbackNoProxy<T extends Record<string, string | undefined>>(env: T): T {
  if (!hasProxyEnvValue(env)) {
    return env;
  }
  const merged = mergeLoopbackNoProxy(env.NO_PROXY, env.no_proxy);
  if (env.NO_PROXY === merged && env.no_proxy === merged) {
    return env;
  }
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}

function maybeUnpackAsarPath(candidatePath: string): string {
  if (candidatePath.includes('.asar.unpacked')) {
    return candidatePath;
  }
  return candidatePath.replace(/\.asar([/\\])/, '.asar.unpacked$1');
}

export function resolveBundledAdapterEntry(adapter: BundledAdapterName): string {
  const importDir = dirname(fileURLToPath(import.meta.url));
  const argvEntry = process.argv[1] ? resolve(process.argv[1]) : undefined;
  const rawCandidates: string[] = [
    resolve(importDir, `${adapter}.js`),
    resolve(importDir, '..', `${adapter}.js`),
    resolve(importDir, '..', '..', 'dist', `${adapter}.js`),
  ];
  if (argvEntry) {
    rawCandidates.push(resolve(dirname(argvEntry), `${adapter}.js`));
  }

  const candidates: string[] = [];
  for (const candidate of rawCandidates) {
    const unpacked = maybeUnpackAsarPath(candidate);
    if (unpacked !== candidate) {
      candidates.push(unpacked);
    }
    candidates.push(candidate);
  }

  const matched = candidates.find((candidate) => existsSync(candidate));
  return matched ?? maybeUnpackAsarPath(rawCandidates[0]!);
}

export const CODEX_DEFAULT_ADAPTER_ARGS = [
  '-c',
  'shell_environment_policy.ignore_default_excludes=true',
  '-c',
  'features.goals=true',
] as const;

export function getAcpCapabilitySourceVersion(input: {
  agentType: BuiltinAgentType | 'custom';
  executablePath?: string;
  customCommand?: CustomAcpLaunchSpec;
  piExtensions?: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  if (input.agentType === 'custom') {
    if (!input.customCommand) {
      return 'custom:unknown';
    }
    return `custom:${input.customCommand.command}\x00${(input.customCommand.args ?? []).join('\x01')}`;
  }
  const overrideSuffix = input.executablePath?.trim()
    ? `+override:${input.executablePath.trim()}`
    : '';
  if (input.agentType === 'deepseek') {
    const baseUrl = input.env?.[DEEPSEEK_HARNESS_BASE_URL_ENV]?.trim();
    const endpointSuffix = baseUrl
      ? `+endpoint:${createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)}`
      : '';
    return `${DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION}${endpointSuffix}${overrideSuffix}`;
  }
  if (input.agentType === 'pi' && input.piExtensions?.length) {
    return `builtin-pi+extensions:${input.piExtensions.join(',')}${overrideSuffix}`;
  }
  return `builtin-${input.agentType}${overrideSuffix}`;
}

export async function resolveACPProcessLaunchAsync(
  input: ResolveACPProcessLaunchInput
): Promise<ResolvedACPProcessLaunch> {
  const capabilitySourceVersion = getAcpCapabilitySourceVersion(input);

  if (input.agentType === 'custom') {
    const configured = input.customCommand?.command.trim();
    if (!configured) {
      throw new Error('Custom ACP agent requires customCommand.command to be configured');
    }
    const command = expandHomePath(configured, input.homeDir);
    return {
      command,
      args: [...(input.customCommand?.args ?? []), ...(input.extraArgs ?? [])],
      ...(input.customCommand?.env ? { env: { ...input.customCommand.env } } : {}),
      capabilitySourceVersion,
    };
  }

  if (!isBuiltinAgentType(input.agentType)) {
    throw new Error(`Unsupported builtin ACP agentType: ${String(input.agentType)}`);
  }

  const resolveExec = async () =>
    await resolveAgentExecutable(input.agentType as BuiltinAgentType, {
      executablePath: input.executablePath,
      env: input.env,
      loginShellEnv: input.loginShellEnv,
      probeLoginShell: input.probeLoginShell,
      homeDir: input.homeDir,
      platform: input.platform,
    });

  switch (input.agentType) {
    case 'deepseek': {
      // Prefer local `dsh` binary when available; fall back to `npx` only if `dsh` is not installed
      const resolvedDshOrNpx = await resolveExec();
      const adapterPath = resolveBundledAdapterEntry('deepseek-acp');
      const launch = await resolveDeepSeekHarnessProcessLaunch({
        adapterPath,
        executablePath: resolvedDshOrNpx,
        dataRoot: input.dataDir,
        providerId: input.providerId,
        extraArgs: input.extraArgs,
        env: input.env,
      });
      return {
        ...launch,
        capabilitySourceVersion,
      };
    }

    case 'kimi': {
      const resolvedKimi = await resolveExec();
      return {
        command: resolvedKimi,
        args: ['acp', ...(input.extraArgs ?? [])],
        env: {
          KIMI_CODE_NO_AUTO_UPDATE: '1',
          KIMI_PATH: resolvedKimi,
        },
        capabilitySourceVersion,
      };
    }

    case 'pi': {
      const resolvedPi = await resolveExec();
      const adapterPath = resolveBundledAdapterEntry('pi-acp');
      const extensionArgs = (input.piExtensions ?? []).flatMap((extPath) => ['-e', extPath]);
      return {
        command: process.execPath,
        args: [adapterPath, ...extensionArgs, ...(input.extraArgs ?? [])],
        env: {
          UA_PI_PATH: resolvedPi,
          LODY_PI_PATH: resolvedPi,
        },
        capabilitySourceVersion,
      };
    }

    case 'claude': {
      const resolvedClaude = await resolveExec();
      const adapterPath = resolveBundledAdapterEntry('claude-acp');
      return {
        command: process.execPath,
        args: [adapterPath, ...(input.extraArgs ?? [])],
        env: {
          CLAUDE_CODE_EXECUTABLE: resolvedClaude,
        },
        capabilitySourceVersion,
      };
    }

    case 'codex': {
      const resolvedCodex = await resolveExec();
      const adapterPath = resolveBundledAdapterEntry('codex-acp');
      return {
        command: process.execPath,
        args: [adapterPath, ...CODEX_DEFAULT_ADAPTER_ARGS, ...(input.extraArgs ?? [])],
        env: {
          CODEX_PATH: resolvedCodex,
        },
        capabilitySourceVersion,
      };
    }

    case 'grok': {
      const resolvedGrok = await resolveExec();
      const adapterPath = resolveBundledAdapterEntry('grok-acp');
      return {
        command: process.execPath,
        args: [adapterPath, ...(input.extraArgs ?? [])],
        env: {
          GROK_PATH: resolvedGrok,
          GROK_DISABLE_AUTOUPDATER: '1',
        },
        capabilitySourceVersion,
      };
    }

    case 'devin': {
      const resolvedDevin = await resolveExec();
      const adapterPath = resolveBundledAdapterEntry('devin-acp');
      return {
        command: process.execPath,
        args: [adapterPath, ...(input.extraArgs ?? [])],
        env: {
          DEVIN_PATH: resolvedDevin,
        },
        capabilitySourceVersion,
      };
    }
  }
}

export const resolveAgentLaunch = resolveACPProcessLaunchAsync;

export function mergeACPProcessEnv(
  launch: Pick<ResolvedACPProcessLaunch, 'env'>,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return launch.env ? { ...baseEnv, ...launch.env } : baseEnv;
}

function getPathEnvKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return 'PATH';
  }
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
}

function normalizePathEntry(entry: string): string {
  const normalized = normalize(entry);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
}

export function getDefaultAcpPathEntries(homeDir = homedir(), agentType?: string): string[] {
  if (!homeDir) {
    return [];
  }
  const relativeDirs =
    agentType === 'kimi' || agentType === 'kimi-code'
      ? ['.kimi-code/bin', ...DEFAULT_ACP_RELATIVE_DIRS.filter((d) => d !== '.kimi-code/bin')]
      : DEFAULT_ACP_RELATIVE_DIRS;
  return relativeDirs.map((relativeDir) => join(homeDir, relativeDir));
}

export function withDefaultAcpPathEntries(
  env: NodeJS.ProcessEnv,
  agentType?: string,
  homeDir = homedir()
): NodeJS.ProcessEnv {
  const defaultEntries = getDefaultAcpPathEntries(homeDir, agentType);
  if (defaultEntries.length === 0) {
    return env;
  }

  const pathKey = getPathEnvKey(env);
  const currentParts = (env[pathKey] ?? '').split(delimiter).filter(Boolean);
  const defaultEntrySet = new Set(defaultEntries.map(normalizePathEntry));
  const currentWithoutDefaults = currentParts.filter(
    (entry) => !defaultEntrySet.has(normalizePathEntry(entry))
  );
  const nextPath = [...defaultEntries, ...currentWithoutDefaults].join(delimiter);

  if (env[pathKey] === nextPath) {
    return env;
  }

  return {
    ...env,
    [pathKey]: nextPath,
  };
}

export function mergeLoginShellEnv(
  base: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv | null | undefined
): NodeJS.ProcessEnv {
  if (!shellEnv || Object.keys(shellEnv).length === 0) {
    return base;
  }

  const merged: NodeJS.ProcessEnv = { ...shellEnv, ...base };

  const pathKey = getPathEnvKey(base);
  const shellPathKey = getPathEnvKey(shellEnv);
  const shellParts = (shellEnv[shellPathKey] ?? '').split(delimiter).filter(Boolean);
  const baseParts = (base[pathKey] ?? '').split(delimiter).filter(Boolean);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of [...shellParts, ...baseParts]) {
    const normalized = normalizePathEntry(entry);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(entry);
  }

  if (ordered.length > 0) {
    merged[pathKey] = ordered.join(delimiter);
  }

  return merged;
}
