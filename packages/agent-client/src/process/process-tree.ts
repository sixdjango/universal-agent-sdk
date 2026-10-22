import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

export interface ProcessGroupMember {
  readonly pid: number;
  readonly zombie: boolean;
}

export interface NodeProcessApi {
  readonly platform: NodeJS.Platform;
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly spawnSync: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions
  ) => SpawnSyncReturns<Buffer>;
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly listProcessGroup?: (pgid: number) => readonly ProcessGroupMember[] | null;
}

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

const windowsEnvValue = (env: NodeJS.ProcessEnv, key: string): string | undefined =>
  Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];

export const resolveWindowsCommand = (
  command: string,
  options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv },
  isFile: (filePath: string) => boolean
): string | null => {
  const extensions = (windowsEnvValue(options.env, 'PATHEXT') ?? WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .filter(Boolean);
  const candidates = (base: string) => [
    ...(path.win32.extname(base) === '' ? [] : [base]),
    ...extensions.map((extension) => `${base}${extension}`),
  ];
  if (/[\\/]/u.test(command)) {
    const base = path.win32.resolve(options.cwd ?? process.cwd(), command);
    return candidates(base).find(isFile) ?? null;
  }
  for (const entry of (windowsEnvValue(options.env, 'PATH') ?? '').split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/u, '$1');
    if (!path.win32.isAbsolute(directory)) continue;
    const found = candidates(path.win32.join(directory, command)).find(isFile);
    if (found) return found;
  }
  return null;
};

const isFile = (filePath: string): boolean => {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const windowsSpawnTarget = (
  command: string,
  options: {
    readonly cwd?: string | URL;
    readonly env?: NodeJS.ProcessEnv;
    readonly shell?: unknown;
  }
): string | null => {
  if (options.shell) return command;
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd;
  return resolveWindowsCommand(command, { cwd, env: options.env ?? process.env }, isFile);
};

const listLinuxProcessGroup = (pgid: number): readonly ProcessGroupMember[] | null => {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  const members: ProcessGroupMember[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(group) !== pgid) continue;
    members.push({ pid: Number(entry), zombie: state === 'Z' || state === 'X' });
  }
  return members;
};

const listPsProcessGroup = (pgid: number): readonly ProcessGroupMember[] | null => {
  const result = spawn.sync('ps', ['-axo', 'pid=,pgid=,stat='], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  });
  if (result.error || result.status !== 0) return null;
  const members: ProcessGroupMember[] = [];
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const [pid, group, state] = line.trim().split(/\s+/u);
    if (!pid || !state || Number(group) !== pgid) continue;
    members.push({ pid: Number(pid), zombie: state.startsWith('Z') });
  }
  return members;
};

export const nodeProcessLive: NodeProcessApi = {
  platform: process.platform,
  spawn: (command, args, options) => {
    if (process.platform !== 'win32') return spawn(command, [...args], options);
    const target = windowsSpawnTarget(command, options);
    return target === null
      ? nodeSpawn(command, [...args], options)
      : spawn(target, [...args], options);
  },
  spawnSync: (command, args, options) => {
    const syncOptions = { ...options, encoding: 'buffer' as const };
    if (process.platform !== 'win32') return spawn.sync(command, [...args], syncOptions);
    const target = windowsSpawnTarget(command, options);
    return target === null
      ? nodeSpawnSync(command, [...args], syncOptions)
      : spawn.sync(target, [...args], syncOptions);
  },
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  listProcessGroup: (pgid) => {
    if (process.platform === 'win32') return null;
    return process.platform === 'linux' ? listLinuxProcessGroup(pgid) : listPsProcessGroup(pgid);
  },
};

export const errnoCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

export class TerminationFailed extends Error {
  readonly target: string;
  readonly reason: 'still-alive' | 'signal-failed';

  constructor(options: {
    target: string;
    reason: 'still-alive' | 'signal-failed';
    message: string;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'TerminationFailed';
    this.target = options.target;
    this.reason = options.reason;
  }
}

export interface TerminationPolicy {
  readonly gracefulSignal?: NodeJS.Signals;
  readonly graceMs: number;
  readonly killWaitMs: number;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly processGroup: boolean;
  readonly windowsDetached?: boolean;
  readonly onSpawned?: (child: ChildProcess) => void;
}

export interface ProcessHandle {
  readonly child: ChildProcess;
  readonly exited: Promise<ProcessExit>;
  terminate(policy: TerminationPolicy): Promise<void>;
}

/** @deprecated Use `ProcessHandle` instead. */
export type ProcessHandleLegacy = ProcessHandle;

const TREE_POLL_INTERVAL_MS = 20;
const MEMBER_SCAN_DELAY_MS = 250;
const TASKKILL_DEADLINE_MS = 10_000;
const TASKKILL_NOT_FOUND = 128;

export const hasExited = (child: ChildProcess): boolean =>
  (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;

const hasPid = (child: ChildProcess): child is ChildProcess & { pid: number } =>
  typeof child.pid === 'number' && child.pid > 0;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const signalFailed = (target: string, signal: NodeJS.Signals | 0, cause: unknown) =>
  new TerminationFailed({
    target,
    reason: 'signal-failed',
    message: `Failed to send ${signal === 0 ? 'liveness probe' : signal} to ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

interface ProcessTree {
  readonly description: string;
  isAlive(): Promise<boolean>;
  signal(signal: NodeJS.Signals): Promise<'delivered' | 'gone'>;
  hasRunningMembers?(): Promise<boolean>;
}

const posixGroupTree = (np: NodeProcessApi, pgid: number): ProcessTree => {
  const description = `process group ${pgid}`;
  const isAlive = async (): Promise<boolean> => {
    try {
      np.kill(-pgid, 0);
      return true;
    } catch (cause) {
      const code = errnoCode(cause);
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw signalFailed(description, 0, cause);
    }
  };
  return {
    description,
    isAlive,
    ...(np.listProcessGroup
      ? {
          hasRunningMembers: async () => {
            const members = np.listProcessGroup!(pgid);
            if (members === null || members.some((m) => !m.zombie)) {
              return true;
            }
            return members.length > 0 ? false : isAlive();
          },
        }
      : {}),
    signal: async (signal) => {
      try {
        np.kill(-pgid, signal);
        return 'delivered';
      } catch (cause) {
        const code = errnoCode(cause);
        if (code === 'ESRCH') return 'gone';
        if (code === 'EPERM') return 'delivered';
        throw signalFailed(description, signal, cause);
      }
    },
  };
};

const singleChildTree = (child: ChildProcess): ProcessTree => {
  const description = `process ${child.pid ?? '(not started)'}`;
  return {
    description,
    isAlive: async () => hasPid(child) && !hasExited(child),
    signal: async (signal) => {
      try {
        const delivered = hasPid(child) && child.kill(signal);
        return delivered ? 'delivered' : 'gone';
      } catch (cause) {
        if (errnoCode(cause) === 'ESRCH') return 'gone';
        throw signalFailed(description, signal, cause);
      }
    },
  };
};

const runTaskkill = (np: NodeProcessApi, args: readonly string[]): Promise<number | null> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let taskkill: ChildProcess | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (taskkill && !hasExited(taskkill)) taskkill.kill();
      reject(new Error(`taskkill did not finish within ${TASKKILL_DEADLINE_MS}ms`));
    }, TASKKILL_DEADLINE_MS);
    timer.unref?.();

    try {
      taskkill = np.spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      taskkill.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      });
      taskkill.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });

const windowsTree = (np: NodeProcessApi, root: ChildProcess & { pid: number }): ProcessTree => {
  const description = `process tree ${root.pid}`;
  return {
    description,
    isAlive: async () => !hasExited(root),
    signal: async (signal) => {
      if (hasExited(root)) return 'gone';
      const force = signal === 'SIGKILL';
      let code: number | null;
      try {
        code = await runTaskkill(np, [
          '/PID',
          String(root.pid),
          '/T',
          ...(force ? ['/F'] : []),
        ]);
      } catch (cause) {
        throw signalFailed(description, signal, cause);
      }
      if (code === 0) return 'delivered';
      if (code === TASKKILL_NOT_FOUND) return 'gone';
      throw signalFailed(description, signal, new Error(`taskkill exited with status ${code}`));
    },
  };
};

const makeProcessTree = (
  np: NodeProcessApi,
  child: ChildProcess,
  processGroup: boolean
): ProcessTree => {
  if (!hasPid(child)) return singleChildTree(child);
  if (np.platform === 'win32') return windowsTree(np, child);
  return processGroup ? posixGroupTree(np, child.pid) : singleChildTree(child);
};

const waitUntilGone = async (tree: ProcessTree, withinMs: number): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (true) {
    if (!(await tree.isAlive())) return true;
    const now = Date.now();
    if (now >= deadline) return false;
    await sleep(Math.min(TREE_POLL_INTERVAL_MS, deadline - now));
  }
};

const settleWithin = async (tree: ProcessTree, withinMs: number): Promise<boolean> => {
  if (!tree.hasRunningMembers) return waitUntilGone(tree, withinMs);
  const early = Math.min(withinMs, MEMBER_SCAN_DELAY_MS);
  if (await waitUntilGone(tree, early)) return true;
  if (!(await tree.hasRunningMembers())) return true;
  const rest = withinMs - early;
  if (rest > 0 && (await waitUntilGone(tree, rest))) return true;
  return !(await tree.hasRunningMembers());
};

export const terminateTree = async (
  tree: ProcessTree,
  policy: TerminationPolicy
): Promise<void> => {
  if (!(await tree.isAlive())) return;

  if (policy.graceMs > 0) {
    try {
      const outcome = await tree.signal(policy.gracefulSignal ?? 'SIGTERM');
      if (outcome === 'gone') return;
      if (await settleWithin(tree, policy.graceMs)) return;
    } catch {
      // Escalate to SIGKILL immediately if graceful signal delivery failed
    }
  }

  let killError: TerminationFailed | undefined;
  try {
    const outcome = await tree.signal('SIGKILL');
    if (outcome === 'gone') return;
  } catch (err) {
    killError = err instanceof TerminationFailed ? err : signalFailed(tree.description, 'SIGKILL', err);
  }

  if (await settleWithin(tree, policy.killWaitMs)) return;
  throw (
    killError ??
    new TerminationFailed({
      target: tree.description,
      reason: 'still-alive',
      message: `${tree.description} was still running ${policy.killWaitMs}ms after SIGKILL`,
    })
  );
};

export interface ProcessFacadeOptions {
  readonly nodeProcess?: NodeProcessApi;
  readonly signal?: AbortSignal;
}

export const startProcess = (
  spec: SpawnSpec,
  options: ProcessFacadeOptions = {}
): ProcessHandle => {
  options.signal?.throwIfAborted();
  const np = options.nodeProcess ?? nodeProcessLive;
  const processGroup = spec.processGroup && np.platform !== 'win32';

  const child = np.spawn(spec.command, spec.args, {
    windowsHide: true,
    ...spec.options,
    detached: np.platform === 'win32' ? spec.windowsDetached === true : processGroup,
  });

  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => {
      if (typeof child.pid !== 'number') {
        resolve({ code: null, signal: null });
      }
    });
  });

  const tree = makeProcessTree(np, child, processGroup);

  try {
    spec.onSpawned?.(child);
  } catch (error) {
    void tree.signal('SIGKILL').catch(() => {});
    throw error;
  }

  const abort = () => {
    void terminateTree(tree, { graceMs: 0, killWaitMs: 1_000 }).catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();

  return {
    child,
    exited,
    terminate: async (policy) => {
      try {
        await terminateTree(tree, policy);
      } finally {
        options.signal?.removeEventListener('abort', abort);
      }
    },
  };
};

export const terminateChildTree = async (
  child: ChildProcess,
  policy: TerminationPolicy & { readonly processGroup: boolean },
  options: ProcessFacadeOptions = {}
): Promise<void> => {
  const np = options.nodeProcess ?? nodeProcessLive;
  const tree = makeProcessTree(np, child, policy.processGroup && np.platform !== 'win32');
  await terminateTree(tree, policy);
};

/** @deprecated Use `startProcess` instead. */
export const startProcessLegacy = startProcess;
/** @deprecated Use `terminateChildTree` instead. */
export const terminateChildTreeLegacy = terminateChildTree;
