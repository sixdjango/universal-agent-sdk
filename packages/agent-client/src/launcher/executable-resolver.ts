import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, normalize, resolve } from 'node:path';
import { getLoginShellEnv } from '../process/login-shell-env';

export const BUILTIN_AGENT_TYPES = [
  'claude',
  'codex',
  'kimi',
  'pi',
  'deepseek',
  'grok',
  'devin',
] as const;

export type BuiltinAgentType = (typeof BUILTIN_AGENT_TYPES)[number];

export function isBuiltinAgentType(value: string): value is BuiltinAgentType {
  return (BUILTIN_AGENT_TYPES as readonly string[]).includes(value);
}

export type ExecutableResolutionSource = 'override' | 'path' | 'login-shell' | 'default-dir';

export interface AgentExecutableResolution {
  agentType: BuiltinAgentType;
  found: boolean;
  resolvedPath?: string;
  source?: ExecutableResolutionSource;
}

export const AGENT_BINARY_CANDIDATES: Record<BuiltinAgentType, readonly string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  kimi: ['kimi', 'kimi-code'],
  pi: ['pi'],
  deepseek: ['npx'],
  grok: ['grok'],
  devin: ['devin'],
};

export const DEFAULT_ACP_RELATIVE_DIRS = [
  '.local/bin',
  'bin',
  '.claude/local',
  '.kimi-code/bin',
  '.grok/bin',
] as const;

export function expandHomePath(pathValue: string, homeDir: string = homedir()): string {
  if (pathValue === '~') return homeDir;
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
    return join(homeDir, pathValue.slice(2));
  }
  return pathValue;
}

function isExecutableFile(
  candidatePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  try {
    if (!existsSync(candidatePath)) return false;
    const stat = statSync(candidatePath);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') {
      accessSync(candidatePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function getPathEnvValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') {
    return env.PATH ?? '';
  }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  return env[key] ?? '';
}

function getWindowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'pathext');
  const raw = (key ? env[key] : undefined) ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
}

export function findExecutableInDir(
  dir: string,
  binaryName: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cleanDir = dir.replace(/^"|"$/g, '').trim();
  if (!cleanDir) return undefined;

  if (platform === 'win32') {
    const hasExtension = /\.[a-z0-9]+$/i.test(binaryName);
    if (hasExtension) {
      const fullPath = resolve(cleanDir, binaryName);
      if (isExecutableFile(fullPath, platform)) return fullPath;
    }
    for (const ext of getWindowsPathExtensions(env)) {
      const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
      const lowerCandidate = resolve(cleanDir, `${binaryName}${normalizedExt.toLowerCase()}`);
      if (isExecutableFile(lowerCandidate, platform)) return lowerCandidate;
      const upperCandidate = resolve(cleanDir, `${binaryName}${normalizedExt.toUpperCase()}`);
      if (isExecutableFile(upperCandidate, platform)) return upperCandidate;
    }
    const bareCandidate = resolve(cleanDir, binaryName);
    if (isExecutableFile(bareCandidate, platform)) return bareCandidate;
    return undefined;
  }

  const candidate = resolve(cleanDir, binaryName);
  return isExecutableFile(candidate, platform) ? candidate : undefined;
}

export interface ResolveExecutableOptions {
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  loginShellEnv?: NodeJS.ProcessEnv | null;
  probeLoginShell?: boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

function normalizeDir(dir: string): string {
  const normalized = normalize(dir.trim());
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
}

export async function detectAgentExecutable(
  agentType: BuiltinAgentType,
  options: ResolveExecutableOptions = {}
): Promise<AgentExecutableResolution> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  const explicit = options.executablePath?.trim();
  if (explicit) {
    const expanded = expandHomePath(explicit, homeDir);
    const resolvedExplicit = isAbsolute(expanded) ? expanded : resolve(expanded);
    if (isExecutableFile(resolvedExplicit, platform)) {
      return {
        agentType,
        found: true,
        resolvedPath: resolvedExplicit,
        source: 'override',
      };
    }
    // On Windows an explicit path might omit .exe/.cmd
    if (platform === 'win32') {
      const parent = resolve(resolvedExplicit, '..');
      const base = resolvedExplicit.slice(parent.length).replace(/^[\\/]+/, '');
      const matched = findExecutableInDir(parent, base, { platform, env });
      if (matched) {
        return {
          agentType,
          found: true,
          resolvedPath: matched,
          source: 'override',
        };
      }
    }
    return {
      agentType,
      found: false,
    };
  }

  const candidates = AGENT_BINARY_CANDIDATES[agentType];
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const pathDirs = getPathEnvValue(env, platform)
    .split(pathDelimiter)
    .map((d) => d.trim())
    .filter(Boolean);

  const seenDirs = new Set<string>();
  for (const dir of pathDirs) {
    const norm = normalizeDir(dir);
    if (seenDirs.has(norm)) continue;
    seenDirs.add(norm);
    for (const bin of candidates) {
      const found = findExecutableInDir(dir, bin, { platform, env });
      if (found) {
        return { agentType, found: true, resolvedPath: found, source: 'path' };
      }
    }
  }

  const shellEnv =
    options.loginShellEnv !== undefined
      ? options.loginShellEnv
      : options.probeLoginShell !== false
        ? await getLoginShellEnv()
        : null;

  if (shellEnv) {
    const shellDirs = getPathEnvValue(shellEnv, platform)
      .split(pathDelimiter)
      .map((d) => d.trim())
      .filter(Boolean);
    for (const dir of shellDirs) {
      const norm = normalizeDir(dir);
      if (seenDirs.has(norm)) continue;
      seenDirs.add(norm);
      for (const bin of candidates) {
        const found = findExecutableInDir(dir, bin, { platform, env: shellEnv });
        if (found) {
          return { agentType, found: true, resolvedPath: found, source: 'login-shell' };
        }
      }
    }
  }

  if (homeDir) {
    for (const rel of DEFAULT_ACP_RELATIVE_DIRS) {
      const dir = join(homeDir, rel);
      const norm = normalizeDir(dir);
      if (seenDirs.has(norm)) continue;
      seenDirs.add(norm);
      for (const bin of candidates) {
        const found = findExecutableInDir(dir, bin, { platform, env });
        if (found) {
          return { agentType, found: true, resolvedPath: found, source: 'default-dir' };
        }
      }
    }
  }

  return { agentType, found: false };
}

export async function resolveAgentExecutable(
  agentType: BuiltinAgentType,
  options: ResolveExecutableOptions = {}
): Promise<string> {
  const result = await detectAgentExecutable(agentType, options);
  if (result.found && result.resolvedPath) {
    return result.resolvedPath;
  }
  const explicit = options.executablePath?.trim();
  if (explicit) {
    throw new Error(
      `Configured executablePath for agent "${agentType}" does not exist or is not executable: ${explicit}`
    );
  }
  const bins = AGENT_BINARY_CANDIDATES[agentType].join(' / ');
  throw new Error(
    `Could not locate executable (${bins}) for builtin agent "${agentType}" on PATH, login shell PATH, or default install directories. Install ${bins} or pass executablePath.`
  );
}

export async function listDetectableAgents(options?: {
  env?: NodeJS.ProcessEnv;
  executablePaths?: Partial<Record<BuiltinAgentType, string>>;
  probeLoginShell?: boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): Promise<AgentExecutableResolution[]> {
  const loginShellEnv =
    options?.probeLoginShell !== false ? await getLoginShellEnv() : null;
  const results: AgentExecutableResolution[] = [];
  for (const agentType of BUILTIN_AGENT_TYPES) {
    results.push(
      await detectAgentExecutable(agentType, {
        executablePath: options?.executablePaths?.[agentType],
        env: options?.env,
        loginShellEnv,
        probeLoginShell: false,
        homeDir: options?.homeDir,
        platform: options?.platform,
      })
    );
  }
  return results;
}
