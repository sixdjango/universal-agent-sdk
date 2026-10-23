import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  EXTENSION_METHODS,
  type RateLimit,
  type RateLimitsSnapshot,
  type SessionUsageUpdate,
} from '@universal-agent/acp-extension-core';
import { z } from 'zod';
import { AgentClient, type AgentClientOptions } from '../client/agent-client';
import {
  type AcpCapabilitiesResult,
  type FetchedAcpCapabilities,
  normalizeAcpSessionCapabilities,
} from '../client/capability-norm';
import { applyAcpSessionRunConfig } from '../client/config-applier';
import { parseExtensionCapabilities, parseRateLimitsSnapshot } from '../client/extension-parser';
import { SessionHistoryAccumulator } from '../history/accumulator';
import { getLoginShellEnv } from '../process/login-shell-env';
import {
  type NodeProcessApi,
  nodeProcessLive,
  startProcess,
  terminateChildTree,
} from '../process/process-tree';
import { ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS, withAcpSessionStartSlot } from '../process/start-gate';
import {
  appendStderrTail,
  createAcpStartupMonitor,
} from '../process/startup-monitor';
import { createStdinWritableStream, createStdoutReadableStream, type Logger } from '../process/stream';
import { LocalTerminalManager, type TerminalManager } from '../process/terminal-manager';
import type {
  ACPSessionId,
  AcpSessionNotification,
  AcpStartupStageEvent,
  AcpStartupTimeoutOptions,
  AcpWriteTextFileEvidence,
  AgentConfigCliType,
  AgentLaunchTarget,
  AgentSessionWarning,
  BuiltinAgentType,
  CustomAcpLaunchSpec,
  ImageGenerationBeginEvent,
  ImageGenerationEndEvent,
  ManagedAgentSession,
  SessionContextWindowUsage,
  SessionGoalAction,
  SessionGoalContent,
  SessionId,
  StartAgentSessionOptions,
} from '../types';
import { resolveDeepSeekHarnessSpawn } from './deepseek-runtime';
import { isBuiltinAgentType } from './executable-resolver';
import { runNpxStartupWithRecovery, withManagedNpmCacheForNpx } from './npx-cache';
import {
  isRegistryAgentType,
  normalizeRegistryAgentId,
  type RegistryAgentId,
} from './registry';
import {
  mergeACPProcessEnv,
  mergeLoginShellEnv,
  resolveACPProcessLaunchAsync,
  withDefaultAcpPathEntries,
  withLoopbackNoProxy,
} from './setting';

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateLogText(
  value: string,
  options: { maxChars?: number; headChars?: number; tailChars?: number } = {}
): string {
  const maxChars = options.maxChars ?? 1200;
  if (value.length <= maxChars) {
    return value;
  }
  const headChars = options.headChars ?? 900;
  const tailChars = options.tailChars ?? 180;
  return `${value.slice(0, headChars)}...[truncated ${value.length - headChars - tailChars} chars]...${value.slice(-tailChars)}`;
}

const DEFAULT_NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message, ...args) => console.error(`[universal-agent] WARN: ${message}`, ...args),
  error: (message, ...args) => console.error(`[universal-agent] ERROR: ${message}`, ...args),
};

export type CreateAcpClientOptions = {
  resolveWorktreeProject?: AgentClientOptions['resolveWorktreeProject'];
  stream: Stream;
  workdir: string;
  logger: Logger;
  terminalManager: TerminalManager;
  agentConfig?: {
    cliType: AgentConfigCliType;
    agentType: string;
  };
  modelId?: AgentClientOptions['modelId'];
  configOptionValues?: AgentClientOptions['configOptionValues'];
  resumeSessionId?: ACPSessionId;
  forkSessionId?: ACPSessionId;
  forkSessionTurnId?: string;
  terminalEnabled?: boolean;
  mcpServers?: AgentClientOptions['mcpServers'];
  resolveMcpServers?: AgentClientOptions['resolveMcpServers'];
  loadExternalMcpServers?: AgentClientOptions['loadExternalMcpServers'];
  onStartupStage?: (event: AcpStartupStageEvent) => void;
  onUpdateMessage(message: AcpSessionNotification): void;
  onRequestPermission(
    requestId: string,
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse>;
  onUsageUpdate?(usage: SessionUsageUpdate, accountingId?: string): void;
  onContextWindowUsageUpdate?(usage: SessionContextWindowUsage): void;
  onRateLimitUpdate?(limits: RateLimit): void;
  onThreadGoalUpdated?(goal: SessionGoalContent): void;
  onThreadGoalCleared?(threadId: string): void;
  onSessionTitleUpdate?(title: string): void;
  onAgentWarning?(warning: AgentSessionWarning): void;
  onImageGenerationBegin?(event: ImageGenerationBeginEvent): void;
  onImageGenerationEnd?(event: ImageGenerationEndEvent): void;
  onWriteTextFile?(event: AcpWriteTextFileEvidence): void | Promise<void>;
  sessionId?: SessionId;
  startupTimeouts?: AcpStartupTimeoutOptions;
  startupAbort?: Promise<never>;
};

export const createAcpClient = async (options: CreateAcpClientOptions) => {
  const sessionId = options.sessionId ?? (randomUUID() as SessionId);
  options.logger.debug(`[${sessionId}] createAcpClient: creating AgentClient`);
  const client = new AgentClient({
    logger: options.logger,
    sessionId,
    terminalManager: options.terminalManager,
    agentConfig: options.agentConfig,
    modelId: options.modelId,
    configOptionValues: options.configOptionValues,
    resolveWorktreeProject: options.resolveWorktreeProject,
    terminalEnabled: options.terminalEnabled,
    mcpServers: options.mcpServers,
    resolveMcpServers: options.resolveMcpServers,
    loadExternalMcpServers: options.loadExternalMcpServers,
    onStartupStage: options.onStartupStage,
    onUpdateMessage: options.onUpdateMessage,
    onRequestPermission: options.onRequestPermission,
    onUsageUpdate: options.onUsageUpdate,
    onContextWindowUsageUpdate: options.onContextWindowUsageUpdate,
    onRateLimitUpdate: options.onRateLimitUpdate,
    onThreadGoalUpdated: options.onThreadGoalUpdated,
    onThreadGoalCleared: options.onThreadGoalCleared,
    onSessionTitleUpdate: options.onSessionTitleUpdate,
    onAgentWarning: options.onAgentWarning,
    onImageGenerationBegin: options.onImageGenerationBegin,
    onImageGenerationEnd: options.onImageGenerationEnd,
    onWriteTextFile: options.onWriteTextFile,
  });
  options.logger.debug(`[${sessionId}] createAcpClient: AgentClient created, calling startSession`);
  const sessionResponse = await client.startSession(
    options.stream,
    options.workdir,
    options.resumeSessionId,
    options.startupTimeouts,
    options.startupAbort,
    options.forkSessionId,
    options.forkSessionTurnId
  );
  options.logger.debug(
    `[${sessionId}] createAcpClient: startSession returned (acpSessionId=${sessionResponse.sessionId})`
  );
  return { client, acpSessionId: sessionResponse.sessionId as ACPSessionId, sessionResponse };
};

export async function terminateAcpProcessTree(
  child: ChildProcess,
  options: {
    logger: Logger;
    sessionLabel: string;
    exitTimeoutMs: number;
    /** Skip SIGTERM: for probes whose output no longer matters. */
    force?: boolean;
    nodeProcess?: NodeProcessApi;
  }
): Promise<void> {
  await terminateChildTree(
    child,
    {
      graceMs: options.force ? 0 : options.exitTimeoutMs,
      killWaitMs: options.exitTimeoutMs,
      processGroup: true,
    },
    {
      nodeProcess: options.nodeProcess,
    }
  );
}

export type SpawnAcpProcessOptions = {
  cliType?: AgentConfigCliType;
  agentType?: string;
  workdir: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  command: string;
  spawnImpl?: NodeProcessApi['spawn'];
};

export const spawnAcpProcess = (options: SpawnAcpProcessOptions): ChildProcess => {
  const executable = resolveDeepSeekHarnessSpawn({
    command: options.command,
    args: options.args,
    env: options.env,
    workdir: options.workdir,
  });

  return startProcess(
    {
      command: executable.command,
      args: executable.args,
      options: { cwd: options.workdir, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
      processGroup: true,
    },
    options.spawnImpl
      ? { nodeProcess: { ...nodeProcessLive, spawn: options.spawnImpl } }
      : undefined
  ).child;
};

export type StartLocalAcpAgentOptions = {
  cliType: AgentConfigCliType;
  agentType: BuiltinAgentType | 'custom' | string;
  executablePath?: string;
  customCommand?: CustomAcpLaunchSpec;
  piExtensions?: string[];
  providerId?: string;
  dataDir?: string;
  workdir: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  terminalManager: TerminalManager;
  terminalEnabled?: boolean;
  sessionId?: SessionId;
  resumeSessionId?: ACPSessionId;
  forkSessionId?: ACPSessionId;
  forkSessionTurnId?: string;
  modelId?: string;
  configOptionValues?: AgentClientOptions['configOptionValues'];
  mcpServers?: AgentClientOptions['mcpServers'];
  resolveMcpServers?: AgentClientOptions['resolveMcpServers'];
  loadExternalMcpServers?: AgentClientOptions['loadExternalMcpServers'];
  resolveWorktreeProject?: AgentClientOptions['resolveWorktreeProject'];
  onStartupStage?: (event: AcpStartupStageEvent) => void;
  onUpdateMessage(message: AcpSessionNotification): void;
  onRequestPermission(
    requestId: string,
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse>;
  onUsageUpdate?(usage: SessionUsageUpdate, accountingId?: string): void;
  onContextWindowUsageUpdate?(usage: SessionContextWindowUsage): void;
  onRateLimitUpdate?(limits: RateLimit): void;
  onThreadGoalUpdated?(goal: SessionGoalContent): void;
  onThreadGoalCleared?(threadId: string): void;
  onSessionTitleUpdate?(title: string): void;
  onAgentWarning?(warning: AgentSessionWarning): void;
  onImageGenerationBegin?(event: ImageGenerationBeginEvent): void;
  onImageGenerationEnd?(event: ImageGenerationEndEvent): void;
  onWriteTextFile?(event: AcpWriteTextFileEvidence): void | Promise<void>;
  signal?: AbortSignal;
  startupTimeouts?: AcpStartupTimeoutOptions;
  concurrency?: number;
  extraArgs?: string[];
  spawnImpl?: NodeProcessApi['spawn'];
};

const CodexConfigOverrideSchema = z.record(z.string(), z.unknown());

function prepareCodexHomeEnv(
  options: Pick<StartLocalAcpAgentOptions, 'cliType' | 'agentType' | 'workdir'>,
  baseEnv: NodeJS.ProcessEnv
): {
  env: NodeJS.ProcessEnv;
  isTitleAgentCodexRun: boolean;
  shouldUseWorkdirCodexHome: boolean;
} {
  const isBuiltinCodex = options.cliType === 'builtin' && options.agentType === 'codex';
  const isTitleAgentCodexRun =
    isBuiltinCodex && (baseEnv.UA_TITLE_AGENT === '1' || baseEnv.LODY_TITLE_AGENT === '1');
  const shouldUseWorkdirCodexHome =
    isBuiltinCodex &&
    !baseEnv.CODEX_HOME &&
    (baseEnv.UA_E2E === '1' || baseEnv.LODY_E2E === '1' || isTitleAgentCodexRun);

  return {
    env: shouldUseWorkdirCodexHome
      ? { ...baseEnv, CODEX_HOME: path.join(options.workdir, '.codex') }
      : baseEnv,
    isTitleAgentCodexRun,
    shouldUseWorkdirCodexHome,
  };
}

function withTitleAgentCodexConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existingConfig = env.CODEX_CONFIG
    ? CodexConfigOverrideSchema.parse(JSON.parse(env.CODEX_CONFIG))
    : {};

  return {
    ...env,
    CODEX_CONFIG: JSON.stringify({
      ...existingConfig,
      project_doc_max_bytes: 0,
      include_environment_context: false,
      skills: {
        include_instructions: false,
        bundled: { enabled: false },
      },
    }),
  };
}

function copyTitleAgentCodexConfig(sourcePath: string, destinationPath: string): void {
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

export const __test__ = {
  copyTitleAgentCodexConfig,
  prepareCodexHomeEnv,
  withTitleAgentCodexConfig,
};

export const startLocalAcpAgent = (options: StartLocalAcpAgentOptions) =>
  startLocalAcpProtocol(options, createAcpClient);

export class AcpQuotaCleanupError extends Error {
  constructor(
    readonly child: ChildProcess,
    cause: unknown
  ) {
    super('Quota ACP process cleanup was not confirmed', { cause });
  }
}

export async function initializeAndReadAcpRateLimits(stream: Stream): Promise<RateLimitsSnapshot> {
  const connection = new ClientSideConnection(
    () => ({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
      sessionUpdate: async () => {},
    }),
    stream
  );
  const initialized = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } },
  });
  const capabilities = parseExtensionCapabilities(
    initialized.agentCapabilities?._meta as Record<string, unknown> | null | undefined
  );
  if (capabilities.rateLimits?.query !== true) {
    throw new Error('Rate-limit query unsupported');
  }
  return parseRateLimitsSnapshot(
    await connection.request(EXTENSION_METHODS.rateLimitsGet, {})
  );
}

/** Read-only ACP initialization: no session, MCP servers, file access or prompts. */
export async function queryLocalAcpRateLimits(
  options: StartLocalAcpAgentOptions
): Promise<RateLimitsSnapshot> {
  const started = await startLocalAcpProtocol(
    options,
    async ({ stream, startupAbort }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const snapshot = await Promise.race([
          initializeAndReadAcpRateLimits(stream),
          ...(startupAbort ? [startupAbort] : []),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Rate-limit query timed out')), 20_000);
          }),
        ]);
        return { snapshot };
      } finally {
        clearTimeout(timer);
      }
    },
    true
  );
  try {
    await terminateAcpProcessTree(started.agentProcess, {
      logger: options.logger,
      sessionLabel: 'provider-rate-limits',
      exitTimeoutMs: 3000,
    });
  } catch (cause) {
    throw new AcpQuotaCleanupError(started.agentProcess, cause);
  }
  return started.snapshot;
}

async function startLocalAcpProtocol<T extends object>(
  options: StartLocalAcpAgentOptions,
  startClient: (options: CreateAcpClientOptions) => Promise<T>,
  retainCleanupFailure = false
): Promise<{ agentProcess: ChildProcess; capabilitySourceVersion?: string } & T> {
  options.signal?.throwIfAborted();
  const resolvedAgentType: string =
    options.cliType === 'custom' || options.agentType === 'custom'
      ? 'custom'
      : options.agentType;

  const loginShellEnv = await getLoginShellEnv();
  const launch = await resolveACPProcessLaunchAsync({
    cliType: options.cliType,
    agentType: resolvedAgentType,
    executablePath: options.executablePath,
    customCommand: options.customCommand,
    piExtensions: options.piExtensions,
    providerId: options.providerId,
    dataDir: options.dataDir,
    env: options.env,
    loginShellEnv,
    extraArgs: options.extraArgs,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();

  const baseEnv = options.env ? { ...process.env, ...options.env } : { ...process.env };
  const { env, isTitleAgentCodexRun, shouldUseWorkdirCodexHome } = prepareCodexHomeEnv(
    options,
    baseEnv
  );

  // withLoopbackNoProxy runs outermost so a proxy contributed by the login
  // shell is covered too.
  const mergedStartupEnv = withLoopbackNoProxy(
    withManagedNpmCacheForNpx(
      launch.command,
      withDefaultAcpPathEntries(
        mergeACPProcessEnv(launch, mergeLoginShellEnv(env, loginShellEnv)),
        options.agentType
      ),
      options.dataDir ? { dataDir: options.dataDir } : undefined
    )
  );
  const envWithAcpStartup = isTitleAgentCodexRun
    ? withTitleAgentCodexConfig(mergedStartupEnv)
    : mergedStartupEnv;

  const keepCodexHome = env.UA_KEEP_CODEX_HOME === '1' || env.LODY_KEEP_CODEX_HOME === '1';
  const defaultCodexHome = path.join(os.homedir(), '.codex');
  const defaultAuthPath = path.join(defaultCodexHome, 'auth.json');
  const defaultConfigPath = path.join(defaultCodexHome, 'config.toml');
  const localAuthPath = env.CODEX_HOME ? path.join(env.CODEX_HOME, 'auth.json') : null;
  const localConfigPath = env.CODEX_HOME ? path.join(env.CODEX_HOME, 'config.toml') : null;

  let lastStderrTail = '';
  const attemptStart = async (
    attemptArgs: readonly string[],
    startupTimeouts?: AcpStartupTimeoutOptions
  ) => {
    options.signal?.throwIfAborted();
    lastStderrTail = '';
    if (shouldUseWorkdirCodexHome) {
      fs.mkdirSync(env.CODEX_HOME!, { recursive: true });
      if (isTitleAgentCodexRun && localConfigPath && fs.existsSync(defaultConfigPath)) {
        copyTitleAgentCodexConfig(defaultConfigPath, localConfigPath);
      }
      if (localAuthPath && fs.existsSync(defaultAuthPath) && !fs.existsSync(localAuthPath)) {
        try {
          fs.copyFileSync(defaultAuthPath, localAuthPath);
        } catch {
          // Best-effort
        }
      }
    }

    const cleanupCodexHome = () => {
      if (!shouldUseWorkdirCodexHome || !env.CODEX_HOME || keepCodexHome) {
        return;
      }
      try {
        fs.rmSync(env.CODEX_HOME, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch {
        // ignore
      }
    };

    let agentProcess: ChildProcess;
    try {
      agentProcess = spawnAcpProcess({
        cliType: options.cliType,
        agentType: options.agentType,
        workdir: options.workdir,
        env: envWithAcpStartup,
        command: launch.command,
        args: [...attemptArgs],
        spawnImpl: options.spawnImpl,
      });
    } catch (error) {
      cleanupCodexHome();
      throw error;
    }
    agentProcess.once('exit', cleanupCodexHome);
    agentProcess.once('error', cleanupCodexHome);
    options.logger.debug(
      `[acp-startup] spawned ACP process (cliType=${options.cliType} agentType=${options.agentType} workdir=${options.workdir})`
    );

    const stderrStream = agentProcess.stderr;
    let stderrTail = '';
    if (stderrStream) {
      stderrStream.setEncoding('utf8');
      stderrStream.on('data', (chunk: string) => {
        if (!chunk) return;
        stderrTail = appendStderrTail(stderrTail, chunk);
        lastStderrTail = stderrTail;
        options.logger.debug(
          `[acp-startup] stderr (${chunk.length} chars): ${truncateLogText(chunk, {
            maxChars: 1200,
            headChars: 900,
            tailChars: 180,
          })}`
        );
      });
    }

    const startupMonitor = createAcpStartupMonitor(
      {
        onExit: (listener) => {
          agentProcess.on('exit', listener);
          return () => {
            agentProcess.off('exit', listener);
          };
        },
        onError: (listener) => {
          agentProcess.on('error', listener);
          return () => {
            agentProcess.off('error', listener);
          };
        },
      },
      {
        sessionId: options.sessionId ?? 'acp-startup',
        command: launch.command,
        args: [...attemptArgs],
        getStderrTail: () => stderrTail,
      }
    );

    if (!agentProcess.stdout) {
      throw new Error('Agent process stdout is not available');
    }
    if (!agentProcess.stdin) {
      throw new Error('Agent process stdin is not available');
    }

    const output = createStdoutReadableStream(agentProcess.stdout);
    const input = createStdinWritableStream(agentProcess.stdin);
    const stream = ndJsonStream(input, output);

    let rejectSignalAbort: ((error: DOMException) => void) | undefined;
    const signalAbort = options.signal
      ? new Promise<never>((_resolve, reject) => {
          rejectSignalAbort = reject;
        })
      : null;
    const handleSignalAbort = (): void => {
      rejectSignalAbort?.(new DOMException('ACP startup was cancelled', 'AbortError'));
    };
    options.signal?.addEventListener('abort', handleSignalAbort, { once: true });

    const effectiveTimeouts = startupTimeouts ?? options.startupTimeouts;
    try {
      options.signal?.throwIfAborted();
      options.logger.debug('[acp-startup] creating ACP client');
      const started = await startClient({
        stream,
        workdir: options.workdir,
        logger: options.logger,
        terminalManager: options.terminalManager,
        agentConfig: {
          cliType: options.cliType,
          agentType: options.agentType,
        },
        sessionId: options.sessionId,
        resumeSessionId: options.resumeSessionId,
        forkSessionId: options.forkSessionId,
        forkSessionTurnId: options.forkSessionTurnId,
        modelId: options.modelId,
        configOptionValues: options.configOptionValues,
        terminalEnabled: options.terminalEnabled,
        mcpServers: options.mcpServers,
        resolveMcpServers: options.resolveMcpServers,
        loadExternalMcpServers: options.loadExternalMcpServers,
        resolveWorktreeProject: options.resolveWorktreeProject,
        onStartupStage: options.onStartupStage,
        onUpdateMessage: options.onUpdateMessage,
        onRequestPermission: options.onRequestPermission,
        onUsageUpdate: options.onUsageUpdate,
        onContextWindowUsageUpdate: options.onContextWindowUsageUpdate,
        onRateLimitUpdate: options.onRateLimitUpdate,
        onThreadGoalUpdated: options.onThreadGoalUpdated,
        onThreadGoalCleared: options.onThreadGoalCleared,
        onSessionTitleUpdate: options.onSessionTitleUpdate,
        onAgentWarning: options.onAgentWarning,
        onImageGenerationBegin: options.onImageGenerationBegin,
        onImageGenerationEnd: options.onImageGenerationEnd,
        onWriteTextFile: options.onWriteTextFile,
        startupTimeouts: effectiveTimeouts,
        startupAbort: signalAbort
          ? Promise.race([startupMonitor.abortPromise, signalAbort])
          : startupMonitor.abortPromise,
      });
      options.signal?.throwIfAborted();
      return {
        agentProcess,
        ...started,
        capabilitySourceVersion: launch.capabilitySourceVersion,
      };
    } catch (error) {
      await terminateAcpProcessTree(agentProcess, {
        logger: options.logger,
        sessionLabel: options.sessionId ?? 'acp-startup',
        exitTimeoutMs: 3000,
      }).catch((terminationError: unknown) => {
        if (retainCleanupFailure) throw new AcpQuotaCleanupError(agentProcess, terminationError);
        options.logger.warn(
          `[acp-startup] ACP agent process could not be terminated after a failed start: ${formatErrorMessage(terminationError)}`
        );
      });

      throw error;
    } finally {
      options.signal?.removeEventListener('abort', handleSignalAbort);
      startupMonitor.dispose();
    }
  };

  return await withAcpSessionStartSlot(
    {
      label: `acp-startup:${options.agentType}`,
      logger: options.logger,
      abortSignal: options.signal,
      waitTimeoutMs: ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS,
      concurrency: options.concurrency,
    },
    async () =>
      await runNpxStartupWithRecovery({
        maxAttempts: retainCleanupFailure ? 1 : undefined,
        command: launch.command,
        args: launch.args,
        env: envWithAcpStartup,
        logger: options.logger,
        logPrefix: '[acp-startup]',
        dataDir: options.dataDir,
        attempt: ({ args, startupTimeouts }) => attemptStart(args, startupTimeouts),
        getStderrTail: () => lastStderrTail,
      })
  );
}

export type ShutdownLocalAcpAgentOptions = {
  agentProcess: ChildProcess;
  client?: AgentClient | null;
  acpSessionId?: ACPSessionId | null;
  logger: Logger;
  sessionLabel: string;
  closeSessionTimeoutMs?: number;
  exitTimeoutMs?: number;
  nodeProcess?: NodeProcessApi;
};

export async function shutdownLocalAcpAgent(options: ShutdownLocalAcpAgentOptions): Promise<void> {
  const closeSessionTimeoutMs = Math.max(0, options.closeSessionTimeoutMs ?? 5000);
  const exitTimeoutMs = Math.max(1, options.exitTimeoutMs ?? 3000);

  if (options.client && options.acpSessionId) {
    try {
      await options.client.closeSession(options.acpSessionId, closeSessionTimeoutMs);
    } catch (error) {
      options.logger.debug(
        `[${options.sessionLabel}] ACP session close failed during local agent shutdown: ${formatErrorMessage(error)}`
      );
    }
  }

  try {
    options.agentProcess.stdin?.end();
  } catch {
    // ignore
  }

  try {
    await terminateAcpProcessTree(options.agentProcess, {
      logger: options.logger,
      sessionLabel: options.sessionLabel,
      exitTimeoutMs,
      nodeProcess: options.nodeProcess,
    });
  } catch (error) {
    options.logger.warn(
      `[${options.sessionLabel}] ACP agent process could not be terminated: ${formatErrorMessage(error)}`
    );
  } finally {
    try {
      options.agentProcess.stdin?.destroy();
      options.agentProcess.stdout?.destroy();
      options.agentProcess.stderr?.destroy();
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// High-Level Host API: Target Normalizer, startAgentSession, probe, rateLimits
// ============================================================================

interface NormalizedLaunchOptions {
  cliType: AgentConfigCliType;
  agentType: BuiltinAgentType | 'custom' | string;
  executablePath?: string;
  customCommand?: CustomAcpLaunchSpec;
  piExtensions?: string[];
  providerId?: string;
  extraArgs?: string[];
}

function normalizeTargetOptions(input: {
  target?: AgentLaunchTarget;
  agentType?: BuiltinAgentType | RegistryAgentId | 'custom' | (string & {});
  executablePath?: string;
  customCommand?: CustomAcpLaunchSpec;
  piExtensions?: string[];
  providerId?: string;
  extraArgs?: string[];
}): NormalizedLaunchOptions {
  if (input.target) {
    if (input.target.cliType === 'custom') {
      return {
        cliType: 'custom',
        agentType: input.target.agentType || 'custom',
        customCommand: {
          command: input.target.command,
          args: input.target.args,
        },
        extraArgs: input.extraArgs,
      };
    }
    if (input.target.cliType === 'registry') {
      return {
        cliType: 'registry',
        agentType: normalizeRegistryAgentId(input.target.agentType),
        executablePath: input.target.executablePath ?? input.executablePath,
        extraArgs: input.target.extraArgs ?? input.extraArgs,
      };
    }
    return {
      cliType: 'builtin',
      agentType: input.target.agentType,
      executablePath: input.target.executablePath ?? input.executablePath,
      piExtensions: input.target.piExtensions ?? input.piExtensions,
      providerId: input.target.providerId ?? input.providerId,
      extraArgs: input.target.extraArgs ?? input.extraArgs,
    };
  }

  if (!input.agentType) {
    throw new Error('Either `target` or `agentType` must be provided to start an agent session');
  }

  if (input.agentType === 'custom') {
    return {
      cliType: 'custom',
      agentType: 'custom',
      customCommand: input.customCommand,
      extraArgs: input.extraArgs,
    };
  }

  if (!isBuiltinAgentType(input.agentType) && isRegistryAgentType(input.agentType)) {
    return {
      cliType: 'registry',
      agentType: normalizeRegistryAgentId(input.agentType),
      executablePath: input.executablePath,
      extraArgs: input.extraArgs,
    };
  }

  return {
    cliType: 'builtin',
    agentType: input.agentType,
    executablePath: input.executablePath,
    piExtensions: input.piExtensions,
    providerId: input.providerId,
    extraArgs: input.extraArgs,
  };
}

export type ProbeAgentCapabilitiesOptions = {
  target?: AgentLaunchTarget;
  agentType?: BuiltinAgentType | RegistryAgentId | 'custom' | (string & {});
  executablePath?: string;
  customCommand?: CustomAcpLaunchSpec;
  piExtensions?: string[];
  providerId?: string;
  extraArgs?: string[];
  workdir: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  logger?: Logger;
  signal?: AbortSignal;
  concurrency?: number;
};

const GOAL_ACTIONS: readonly SessionGoalAction[] = ['set', 'pause', 'resume', 'clear'];

export async function probeAgentCapabilities(
  options: ProbeAgentCapabilitiesOptions
): Promise<FetchedAcpCapabilities> {
  const logger = options.logger ?? DEFAULT_NOOP_LOGGER;
  const normalizedTarget = normalizeTargetOptions(options);
  const terminalManager = new LocalTerminalManager();

  const started = await startLocalAcpAgent({
    ...normalizedTarget,
    workdir: options.workdir,
    env: options.env,
    dataDir: options.dataDir,
    logger,
    terminalManager,
    terminalEnabled: false,
    signal: options.signal,
    concurrency: options.concurrency,
    onUpdateMessage: () => {},
    onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  });

  try {
    const goalActions = GOAL_ACTIONS.filter(
      (action) => started.client.resolveGoalActionTransport(action) !== null
    );
    const normalized: AcpCapabilitiesResult = normalizeAcpSessionCapabilities(
      {
        ...started.sessionResponse,
        configOptions: started.client.getConfigOptions(),
      },
      {
        sessionFork: started.client.supportsSessionFork(),
        acknowledgedSteer: started.client.supportsAcknowledgedSteer(),
        sessionTitle: started.client.supportsSessionTitleGeneration(),
        rateLimits: started.client.getRateLimitsCapability(),
        goalActions,
        agent: {
          cliType: normalizedTarget.cliType,
          agentType: normalizedTarget.agentType,
        },
      }
    );

    return {
      ...normalized,
      ...(started.capabilitySourceVersion
        ? { capabilitySourceVersion: started.capabilitySourceVersion }
        : {}),
    };
  } finally {
    await shutdownLocalAcpAgent({
      agentProcess: started.agentProcess,
      client: started.client,
      acpSessionId: started.acpSessionId,
      logger,
      sessionLabel: `probe:${normalizedTarget.agentType}`,
    });
    await terminalManager.disposeAll().catch(() => {});
  }
}

export type QueryAgentRateLimitsOptions = {
  target?: AgentLaunchTarget;
  agentType?: BuiltinAgentType | RegistryAgentId | 'custom' | (string & {});
  executablePath?: string;
  customCommand?: CustomAcpLaunchSpec;
  piExtensions?: string[];
  providerId?: string;
  extraArgs?: string[];
  workdir: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  logger?: Logger;
  signal?: AbortSignal;
  concurrency?: number;
};

export async function queryAgentRateLimits(
  options: QueryAgentRateLimitsOptions
): Promise<RateLimitsSnapshot> {
  const logger = options.logger ?? DEFAULT_NOOP_LOGGER;
  const normalizedTarget = normalizeTargetOptions(options);
  const terminalManager = new LocalTerminalManager();
  try {
    return await queryLocalAcpRateLimits({
      ...normalizedTarget,
      workdir: options.workdir,
      env: options.env,
      dataDir: options.dataDir,
      logger,
      terminalManager,
      terminalEnabled: false,
      signal: options.signal,
      concurrency: options.concurrency,
      onUpdateMessage: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
  } finally {
    await terminalManager.disposeAll().catch(() => {});
  }
}

export async function startAgentSession(
  options: StartAgentSessionOptions
): Promise<ManagedAgentSession> {
  const sessionId = (options.sessionId ?? randomUUID()) as SessionId;
  const logger = options.logger ?? DEFAULT_NOOP_LOGGER;
  const normalizedTarget = normalizeTargetOptions(options);
  const ownsTerminalManager = !options.terminalManager;
  const terminalManager = options.terminalManager ?? new LocalTerminalManager();

  const initialModelId = options.initialConfig?.modelId ?? options.modelId;
  const initialModeId = options.initialConfig?.modeId ?? options.modeId;
  const initialConfigOptionValues =
    options.initialConfig?.configOptionValues ?? options.configOptionValues;

  const historyAccumulator = new SessionHistoryAccumulator({
    initialHistory: options.initialHistory,
    onChange: options.onHistoryChange,
  });

  const started = await startLocalAcpAgent({
    ...normalizedTarget,
    sessionId,
    workdir: options.workdir,
    env: options.env,
    dataDir: options.dataDir,
    logger,
    terminalManager,
    terminalEnabled: options.terminalEnabled,
    resumeSessionId: options.resumeSessionId,
    forkSessionId: options.forkSessionId,
    forkSessionTurnId: options.forkSessionTurnId,
    modelId: initialModelId,
    configOptionValues: initialConfigOptionValues,
    mcpServers: options.mcpServers,
    resolveMcpServers: options.resolveMcpServers,
    resolveWorktreeProject: options.resolveWorktreeProject,
    onStartupStage: options.onStartupStage,
    onUpdateMessage: (notification) => {
      historyAccumulator.applyNotification(notification);
      options.onUpdateMessage?.(notification);
    },
    onRequestPermission: options.onRequestPermission,
    onUsageUpdate: options.onUsageUpdate,
    onContextWindowUsageUpdate: options.onContextWindowUsageUpdate,
    onRateLimitUpdate: options.onRateLimitUpdate,
    onThreadGoalUpdated: options.onThreadGoalUpdated,
    onThreadGoalCleared: options.onThreadGoalCleared,
    onSessionTitleUpdate: options.onSessionTitleUpdate,
    onAgentWarning: options.onAgentWarning,
    onImageGenerationBegin: options.onImageGenerationBegin,
    onImageGenerationEnd: options.onImageGenerationEnd,
    onWriteTextFile: options.onWriteTextFile,
    signal: options.signal,
    startupTimeouts: options.startupTimeouts,
    concurrency: options.concurrency,
  });

  // Apply initial runtime config (e.g. modeId, modelId, configOptionValues) in order if requested
  if (
    initialModeId !== undefined ||
    initialModelId !== undefined ||
    (initialConfigOptionValues && Object.keys(initialConfigOptionValues).length > 0)
  ) {
    try {
      await applyAcpSessionRunConfig({
        session: {
          sessionId,
          acpSessionId: started.acpSessionId,
          agentClient: started.client,
        },
        config: {
          cliType: normalizedTarget.cliType,
          agentType: normalizedTarget.agentType,
          modeId: initialModeId,
          modelId: initialModelId,
          configOptionValues: initialConfigOptionValues,
        },
        logger,
        signal: options.signal,
      });
    } catch (error) {
      await shutdownLocalAcpAgent({
        agentProcess: started.agentProcess,
        client: started.client,
        acpSessionId: started.acpSessionId,
        logger,
        sessionLabel: sessionId,
      });
      if (ownsTerminalManager) {
        await terminalManager.disposeAll?.(started.acpSessionId).catch(() => {});
      }
      throw error;
    }
  }

  let isShutDown = false;

  const session: ManagedAgentSession = {
    sessionId,
    get acpSessionId() {
      return started.client.getAcpSessionId() ?? started.acpSessionId;
    },
    client: started.client,
    sessionResponse: started.sessionResponse,
    get capabilities() {
      return started.client.getExtensionCapabilities();
    },
    historyAccumulator,

    getHistory() {
      return historyAccumulator.getHistory();
    },

    getLatestAssistantTurn() {
      return historyAccumulator.getLatestAssistantTurn();
    },

    getLatestAssistantItems() {
      return historyAccumulator.getLatestAssistantItems();
    },

    async prompt(blocks, promptOptions) {
      historyAccumulator.appendUserTurn(blocks);
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      try {
        return await started.client.prompt(currentSessionId, blocks, promptOptions);
      } finally {
        historyAccumulator.completeActiveAssistantTurn();
      }
    },

    steer(blocks, steerOptions) {
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      return started.client.steerPrompt(currentSessionId, blocks, steerOptions);
    },

    steerPrompt(blocks, steerOptions) {
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      return started.client.steerPrompt(currentSessionId, blocks, steerOptions);
    },

    async applyConfig(config) {
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      await applyAcpSessionRunConfig({
        session: {
          sessionId,
          acpSessionId: currentSessionId,
          agentClient: started.client,
        },
        config: {
          cliType: normalizedTarget.cliType,
          agentType: normalizedTarget.agentType,
          modeId: config.modeId,
          modelId: config.modelId,
          configOptionValues: config.configOptionValues,
        },
        logger,
      });
    },

    async cancel() {
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      await started.client.cancel(currentSessionId);
    },

    async setMode(modeId) {
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      await started.client.setSessionMode(currentSessionId, modeId);
    },

    async setModel(modelId) {
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      await started.client.unstable_setSessionModel(currentSessionId, modelId);
    },

    async setConfigOption(configId, value) {
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      return await started.client.setSessionConfigOption(currentSessionId, configId, value);
    },

    getConfigOptions() {
      return started.client.getConfigOptions();
    },

    async cancelSubagent(taskId, reason) {
      await started.client.cancelSubagent(taskId, reason);
    },

    async controlGoal(action) {
      await started.client.controlGoal(action);
    },

    async getRateLimits(request) {
      return await started.client.getRateLimits(request);
    },

    async shutdown(shutdownOptions) {
      if (isShutDown) {
        return;
      }
      isShutDown = true;
      const currentSessionId = started.client.getAcpSessionId() ?? started.acpSessionId;
      await shutdownLocalAcpAgent({
        agentProcess: started.agentProcess,
        client: started.client,
        acpSessionId: currentSessionId,
        logger,
        sessionLabel: sessionId,
        closeSessionTimeoutMs: shutdownOptions?.closeSessionTimeoutMs,
        exitTimeoutMs: shutdownOptions?.exitTimeoutMs,
      });
      if (ownsTerminalManager) {
        await terminalManager.disposeAll?.(currentSessionId).catch(() => {});
      }
    },
  };

  return session;
}
