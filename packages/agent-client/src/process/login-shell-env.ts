import { userInfo } from 'node:os';
import { startProcess } from './process-tree.js';

const DELIMITER = '_UA_SHELL_ENV_DELIMITER_';
const DEFAULT_TIMEOUT_MS = 3000;
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash'];

const PROBE_ENV: Record<string, string> = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
};

const probeScript = (shell: string): string =>
  `${shell.endsWith('/bash') ? 'source ~/.bashrc >/dev/null 2>&1 || true; ' : ''}` +
  `printf '%s' "${DELIMITER}"; command env -0 2>/dev/null || command env; printf '%s' "${DELIMITER}"; exit`;

export const parseLoginShellEnvOutput = (stdout: string): NodeJS.ProcessEnv | null => {
  const section = stdout.split(DELIMITER)[1];
  if (section === undefined) return null;
  const parsed: NodeJS.ProcessEnv = {};
  for (const entry of section.split(section.includes('\0') ? '\0' : '\n')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
};

const withoutProbeEnv = (
  parsed: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const result = { ...parsed };
  for (const key of Object.keys(PROBE_ENV)) {
    if (baseEnv[key] === undefined) delete result[key];
    else result[key] = baseEnv[key];
  }
  return result;
};

const defaultShell = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => {
  try {
    const { shell } = userInfo();
    if (shell) return shell;
  } catch {
    // Fallback to environment
  }
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
};

export interface ProbeLoginShellEnvOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  shell?: string;
}

export async function probeLoginShellEnv(
  options: ProbeLoginShellEnvOptions = {}
): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === 'win32') return null;
  if (
    process.env.UA_DISABLE_SHELL_ENV === '1' ||
    process.env.LODY_DISABLE_SHELL_ENV === '1'
  ) {
    return {};
  }

  const baseEnv = { ...(options.env ?? process.env) };
  const first = options.shell ?? defaultShell(baseEnv, process.platform);
  const shells = [first, ...FALLBACK_SHELLS.filter((s) => s !== first)];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (const shell of shells) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const stdout = await runShellProbe(shell, { ...baseEnv, ...PROBE_ENV }, remainingMs);
    if (stdout !== null) {
      const parsed = parseLoginShellEnvOutput(stdout);
      if (parsed) return withoutProbeEnv(parsed, baseEnv);
    }
  }
  return null;
}

async function runShellProbe(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let handle: ReturnType<typeof startProcess> | undefined;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void handle?.terminate({ graceMs: 0, killWaitMs: 500 }).catch(() => {});
      resolve(null);
    }, timeoutMs);
    timer.unref?.();

    try {
      handle = startProcess({
        command: shell,
        args: ['-ilc', probeScript(shell)],
        options: {
          env,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
        processGroup: true,
      });

      handle.child.stdout?.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      handle.child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });

      void handle.exited.then((exit) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exit.code === 0 && exit.signal === null) {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } else {
          resolve(null);
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

let cachedEnv: NodeJS.ProcessEnv | null = null;
let inFlightProbe: Promise<NodeJS.ProcessEnv> | null = null;

export async function getLoginShellEnv(
  options: ProbeLoginShellEnvOptions = {}
): Promise<NodeJS.ProcessEnv> {
  if (
    process.env.UA_DISABLE_SHELL_ENV === '1' ||
    process.env.LODY_DISABLE_SHELL_ENV === '1'
  ) {
    return {};
  }
  if (cachedEnv !== null) {
    return cachedEnv;
  }
  if (!inFlightProbe) {
    inFlightProbe = probeLoginShellEnv(options)
      .then((res) => {
        cachedEnv = res ?? {};
        return cachedEnv;
      })
      .catch(() => {
        cachedEnv = {};
        return cachedEnv;
      })
      .finally(() => {
        inFlightProbe = null;
      });
  }
  return inFlightProbe;
}

export function getCachedLoginShellEnvSync(): NodeJS.ProcessEnv {
  if (
    process.env.UA_DISABLE_SHELL_ENV === '1' ||
    process.env.LODY_DISABLE_SHELL_ENV === '1'
  ) {
    return {};
  }
  return cachedEnv ?? {};
}

export function resetLoginShellEnvCache(): void {
  cachedEnv = null;
  inFlightProbe = null;
}

/** @deprecated Use `getLoginShellEnv` instead. */
export const getLoginShellEnvLegacy = getLoginShellEnv;
/** @deprecated Use `getCachedLoginShellEnvSync` instead. */
export const getCachedLoginShellEnvSyncLegacy = getCachedLoginShellEnvSync;
