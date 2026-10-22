import type { Logger } from './stream.js';

export const DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS = 2;
export const DEFAULT_ACP_SESSION_START_CONCURRENCY = DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS;
export const ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS = 120_000;
export const UA_SESSION_START_GATE_ENV = 'UA_MAX_CONCURRENT_ACP_SESSION_STARTS';
export const ACP_SESSION_START_GATE_ENV = 'LODY_MAX_CONCURRENT_ACP_SESSION_STARTS';

export type AcpSessionStartGateOptions = {
  maxConcurrent?: number;
  /** Default queue deadline. Omitted means an unbounded wait. */
  waitTimeoutMs?: number;
};

export type AcpSessionStartSlotOptions = {
  label: string;
  logger?: Logger;
  abortSignal?: AbortSignal;
  waitTimeoutMs?: number;
  /** Optional concurrency override for the process-level gate. */
  concurrency?: number;
};

export class AcpSessionStartQueueTimeoutError extends Error {
  readonly waitedMs: number;

  constructor(label: string, waitedMs: number, inUse: number, maxConcurrent: number) {
    super(
      `[${label}] Timed out after ${waitedMs}ms waiting for an ACP session-start slot ` +
        `(${inUse}/${maxConcurrent} in use). The machine is busy starting other agents.`
    );
    this.name = 'AcpSessionStartQueueTimeoutError';
    this.waitedMs = waitedMs;
  }
}

type QueuedAcquire = {
  grant(): void;
  abort(error: unknown): void;
};

export const resolveAcpSessionStartLimit = (explicit?: number): number => {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.max(1, Math.floor(explicit));
  }
  const raw =
    process.env[UA_SESSION_START_GATE_ENV]?.trim() ||
    process.env[ACP_SESSION_START_GATE_ENV]?.trim();
  if (!raw) {
    return DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_CONCURRENT_ACP_SESSION_STARTS;
  }
  return Math.floor(parsed);
};

export class AcpSessionStartGate {
  private _inUse = 0;
  private _maxConcurrent: number;
  private readonly waiters: QueuedAcquire[] = [];
  readonly waitTimeoutMs: number | undefined;

  constructor(options?: AcpSessionStartGateOptions) {
    this._maxConcurrent = resolveAcpSessionStartLimit(options?.maxConcurrent);
    this.waitTimeoutMs = options?.waitTimeoutMs;
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  setMaxConcurrent(limit: number): void {
    const nextLimit = resolveAcpSessionStartLimit(limit);
    this._maxConcurrent = nextLimit;
    this.drainQueue();
  }

  get inUse(): number {
    return this._inUse;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async run<T>(options: AcpSessionStartSlotOptions, fn: () => Promise<T>): Promise<T> {
    if (options.concurrency !== undefined) {
      this.setMaxConcurrent(options.concurrency);
    }
    await this.acquire(options);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(options: AcpSessionStartSlotOptions): Promise<void> {
    options.abortSignal?.throwIfAborted();
    if (this._inUse < this._maxConcurrent) {
      this._inUse += 1;
      return;
    }

    options.logger?.debug(
      `[${options.label}] Waiting for ACP session-start slot (inUse=${this.inUse} queued=${this.queued + 1} max=${this.maxConcurrent})`
    );

    const waitTimeoutMs = options.waitTimeoutMs ?? this.waitTimeoutMs;
    const waitStartedAtMs = Date.now();

    await new Promise<void>((resolve, reject) => {
      let waiter: QueuedAcquire;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const dequeue = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      const onAbort = (): void => {
        dequeue();
        waiter.abort(new DOMException('ACP session start was cancelled', 'AbortError'));
      };
      const onTimeout = (): void => {
        dequeue();
        waiter.abort(
          new AcpSessionStartQueueTimeoutError(
            options.label,
            Date.now() - waitStartedAtMs,
            this.inUse,
            this.maxConcurrent
          )
        );
      };
      waiter = {
        grant: () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          options.abortSignal?.removeEventListener('abort', onAbort);
          this._inUse += 1;
          resolve();
        },
        abort: (error) => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          options.abortSignal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      this.waiters.push(waiter);
      if (waitTimeoutMs !== undefined && waitTimeoutMs > 0 && Number.isFinite(waitTimeoutMs)) {
        timeoutId = setTimeout(onTimeout, waitTimeoutMs);
        timeoutId.unref?.();
      }
      options.abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (options.abortSignal?.aborted) {
        onAbort();
      }
    });
  }

  private drainQueue(): void {
    while (this._inUse < this._maxConcurrent && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) {
        next.grant();
      }
    }
  }

  private release(): void {
    this._inUse = Math.max(0, this._inUse - 1);
    this.drainQueue();
  }
}

let defaultGate: AcpSessionStartGate | undefined;

export const getAcpSessionStartGate = (): AcpSessionStartGate => {
  defaultGate ??= new AcpSessionStartGate();
  return defaultGate;
};

export const withAcpSessionStartSlot = <T>(
  options: AcpSessionStartSlotOptions,
  fn: () => Promise<T>
): Promise<T> => getAcpSessionStartGate().run(options, fn);

export const resetAcpSessionStartGateForTest = (): void => {
  defaultGate = undefined;
};

export const __test__ = {
  resetDefaultGate(): void {
    defaultGate = undefined;
  },
  setDefaultGate(gate: AcpSessionStartGate): void {
    defaultGate = gate;
  },
};
