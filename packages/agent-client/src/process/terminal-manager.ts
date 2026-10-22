import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { noopLogger, type Logger } from './stream.js';
import { startProcess, type NodeProcessApi, type ProcessHandle } from './process-tree.js';

export type TerminalExitStatus = { exitCode: number | null; signal?: string | null };

export class TerminalSpawnError extends Error {
  readonly spawnCode: 'ENOENT' | 'EACCES';
  readonly command: string;

  constructor(spawnCode: 'ENOENT' | 'EACCES', command: string, cause: unknown) {
    super(
      spawnCode === 'ENOENT'
        ? `Terminal command not found: ${command}`
        : `Terminal command is not executable: ${command}`,
      { cause }
    );
    this.name = 'TerminalSpawnError';
    this.spawnCode = spawnCode;
    this.command = command;
  }
}

export interface TerminalManager {
  createTerminal(
    acpSessionId: string,
    command: string,
    args?: string[],
    cwd?: string,
    env?: Record<string, string>,
    outputByteLimit?: number
  ): Promise<string>;
  terminalOutput(
    acpSessionId: string,
    terminalId: string
  ): Promise<{
    output: string;
    truncated: boolean;
    exitStatus: TerminalExitStatus | null;
  }>;
  releaseTerminal(acpSessionId: string, terminalId: string): Promise<void>;
  waitForTerminalExit(acpSessionId: string, terminalId: string): Promise<TerminalExitStatus>;
  killTerminal(acpSessionId: string, terminalId: string): Promise<void>;
  disposeAll?(acpSessionId?: string): Promise<void>;
}

interface TerminalState {
  id: string;
  handle: ProcessHandle;
  output: Buffer;
  outputByteLimit: number;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  waiters: Array<(status: TerminalExitStatus) => void>;
}

export interface LocalTerminalManagerOptions {
  logger?: Logger;
  sessionLabel?: string;
  getActiveAcpSessionId?: () => string | null;
  resolveWorkdir?: (cwd?: string) => string;
  buildEnv?: (overrides?: Record<string, string>) => NodeJS.ProcessEnv;
  defaultOutputByteLimit?: number;
  platform?: NodeJS.Platform;
  nodeProcess?: NodeProcessApi;
}

const DEFAULT_TERMINAL_BYTE_LIMIT = 1024 * 1024; // 1MB

export class LocalTerminalManager implements TerminalManager {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly logger: Logger;
  private readonly sessionLabel: string;
  private readonly getActiveSessionId?: () => string | null;
  private readonly resolveWorkdir: (cwd?: string) => string;
  private readonly buildEnv: (overrides?: Record<string, string>) => NodeJS.ProcessEnv;
  private readonly defaultOutputByteLimit: number;
  private readonly platform: NodeJS.Platform;
  private readonly nodeProcess?: NodeProcessApi;

  constructor(options: LocalTerminalManagerOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.sessionLabel = options.sessionLabel ?? 'acp-terminal';
    this.getActiveSessionId = options.getActiveAcpSessionId;
    this.resolveWorkdir =
      options.resolveWorkdir ?? ((cwd) => (cwd ? path.resolve(process.cwd(), cwd) : process.cwd()));
    this.buildEnv =
      options.buildEnv ?? ((overrides) => (overrides ? { ...process.env, ...overrides } : process.env));
    this.defaultOutputByteLimit = options.defaultOutputByteLimit ?? DEFAULT_TERMINAL_BYTE_LIMIT;
    this.platform = options.platform ?? process.platform;
    this.nodeProcess = options.nodeProcess;
  }

  async createTerminal(
    acpSessionId: string,
    command: string,
    args?: string[],
    cwd?: string,
    env?: Record<string, string>,
    outputByteLimit?: number
  ): Promise<string> {
    this.ensureValidSession(acpSessionId);

    const terminalId = randomUUID();
    const workdir = this.resolveWorkdir(cwd);
    const mergedEnv = this.buildEnv(env);
    const target = await resolveTerminalSpawnTarget(
      command,
      args ?? [],
      workdir,
      this.platform
    );

    const state: TerminalState = {
      id: terminalId,
      handle: null as unknown as ProcessHandle,
      output: Buffer.alloc(0),
      outputByteLimit: outputByteLimit ?? this.defaultOutputByteLimit,
      truncated: false,
      exitStatus: null,
      waiters: [],
    };

    let handle: ProcessHandle;
    try {
      handle = startProcess(
        {
          command: target.command,
          args: target.args,
          options: {
            cwd: workdir,
            env: mergedEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
          processGroup: true,
          onSpawned: (child: ChildProcess) => {
            child.stdout?.on('data', (chunk: Buffer) => this.appendOutput(state, chunk));
            child.stderr?.on('data', (chunk: Buffer) => this.appendOutput(state, chunk));
            child.once('close', (code, signal) => this.handleExit(state, code, signal));
            child.once('error', (err) => {
              this.logger.error(`[${this.sessionLabel}] Terminal ${terminalId} error: ${err.message}`);
              this.handleExit(state, null, null);
            });
          },
        },
        { nodeProcess: this.nodeProcess }
      );
      await waitForSpawnConfirmation(handle.child);
    } catch (error) {
      throw toTerminalSpawnError(error, target.command);
    }

    state.handle = handle;
    this.terminals.set(terminalId, state);
    return terminalId;
  }

  async terminalOutput(acpSessionId: string, terminalId: string) {
    const state = this.getTerminal(acpSessionId, terminalId);
    return {
      output: state.output.toString('utf8'),
      truncated: state.truncated,
      exitStatus: state.exitStatus,
    };
  }

  async releaseTerminal(acpSessionId: string, terminalId: string): Promise<void> {
    const state = this.getTerminal(acpSessionId, terminalId);
    try {
      if (!state.exitStatus) {
        await state.handle.terminate({ graceMs: 1_000, killWaitMs: 1_000 });
      }
    } catch (error) {
      this.logger.debug(
        `[${this.sessionLabel}] Failed to kill terminal ${terminalId} on release: ${error}`
      );
    }
    if (!state.exitStatus) {
      state.exitStatus = { exitCode: null, signal: 'SIGTERM' };
      this.resolveWaiters(state);
    }
    this.terminals.delete(terminalId);
  }

  async waitForTerminalExit(acpSessionId: string, terminalId: string): Promise<TerminalExitStatus> {
    const state = this.getTerminal(acpSessionId, terminalId);
    if (state.exitStatus) {
      return state.exitStatus;
    }
    return new Promise<TerminalExitStatus>((resolve) => {
      state.waiters.push(resolve);
    });
  }

  async killTerminal(acpSessionId: string, terminalId: string): Promise<void> {
    const state = this.getTerminal(acpSessionId, terminalId);
    if (!state.exitStatus) {
      await state.handle.terminate({ graceMs: 1_000, killWaitMs: 1_000 });
    }
  }

  async disposeAll(acpSessionId?: string): Promise<void> {
    const active = this.getActiveSessionId?.();
    if (acpSessionId && active && active !== acpSessionId) {
      return;
    }
    const terminalIds = Array.from(this.terminals.keys());
    await Promise.allSettled(
      terminalIds.map(async (id) => {
        const state = this.terminals.get(id);
        if (state && !state.exitStatus) {
          await state.handle.terminate({ graceMs: 500, killWaitMs: 500 }).catch(() => {});
        }
        this.terminals.delete(id);
      })
    );
  }

  private ensureValidSession(acpSessionId: string) {
    if (!this.getActiveSessionId) {
      return;
    }
    const active = this.getActiveSessionId();
    if (!active) {
      throw new Error('ACP session is not active yet.');
    }
    if (active !== acpSessionId) {
      throw new Error(`ACP session mismatch for terminal request: ${acpSessionId}`);
    }
  }

  private getTerminal(acpSessionId: string, terminalId: string): TerminalState {
    this.ensureValidSession(acpSessionId);
    const state = this.terminals.get(terminalId);
    if (!state) {
      throw new Error(`Terminal ${terminalId} not found or already released`);
    }
    return state;
  }

  private handleExit(
    state: TerminalState,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ) {
    if (!this.terminals.has(state.id) && state.exitStatus) {
      return;
    }
    state.exitStatus = {
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      signal: signal ?? undefined,
    };
    this.resolveWaiters(state);
  }

  private resolveWaiters(state: TerminalState) {
    const exitStatus = state.exitStatus ?? { exitCode: null, signal: null };
    while (state.waiters.length) {
      const waiter = state.waiters.shift();
      if (waiter) waiter(exitStatus);
    }
  }

  private appendOutput(state: TerminalState, chunk: Buffer) {
    if (state.outputByteLimit === 0) {
      if (chunk.length) state.truncated = true;
      return;
    }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.output = Buffer.concat([state.output, data]);
    if (state.output.length > state.outputByteLimit) {
      state.truncated = true;
      state.output = truncateBuffer(state.output, state.outputByteLimit);
    }
  }
}

async function resolveTerminalSpawnTarget(
  command: string,
  args: string[],
  workdir: string,
  platform: NodeJS.Platform
): Promise<{ command: string; args: string[] }> {
  if (args.length > 0 || !/\s/.test(command)) {
    return { command, args };
  }
  if (await isExistingFile(path.resolve(workdir, command))) {
    return { command, args };
  }
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', command] }
    : { command: '/bin/sh', args: ['-c', command] };
}

async function isExistingFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function waitForSpawnConfirmation(child: ChildProcess): Promise<void> {
  if (typeof child.pid === 'number' && child.pid > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function toTerminalSpawnError(error: unknown, command: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES') {
    return new TerminalSpawnError(code, command, error);
  }
  return error;
}

function truncateBuffer(buffer: Buffer, limit: number): Buffer {
  if (buffer.length <= limit) return buffer;
  let start = buffer.length - limit;
  while (start < buffer.length && isUtf8ContinuationByte(buffer[start])) {
    start += 1;
  }
  return buffer.slice(start);
}

function isUtf8ContinuationByte(byte: number | undefined): byte is number {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
