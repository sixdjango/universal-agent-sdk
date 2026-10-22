import type { Writable } from 'node:stream';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Creates a WritableStream that writes to a Node.js Writable stream with proper backpressure handling.
 */
export function createStdinWritableStream(stdin: Writable, logger: Logger = noopLogger): WritableStream<Uint8Array> {
  stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') {
      logger.debug(`[stream] stdin error: ${err.message}`);
    }
  });

  return new WritableStream({
    write(chunk) {
      if (stdin.destroyed) {
        return Promise.resolve();
      }
      const canContinue = stdin.write(chunk);
      if (!canContinue) {
        return new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            stdin.off('drain', onDrain);
            stdin.off('close', onClose);
            stdin.off('error', onError);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            resolve();
          };
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          stdin.once('drain', onDrain);
          stdin.once('close', onClose);
          stdin.once('error', onError);
        });
      }
      return Promise.resolve();
    },
    close() {
      if (!stdin.destroyed) {
        stdin.end();
      }
    },
  });
}

/**
 * Creates a ReadableStream from a Node.js Readable stream with buffering to prevent data loss.
 */
export function createStdoutReadableStream(
  stdout: NodeJS.ReadableStream
): ReadableStream<Uint8Array> {
  const bufferedChunks: Buffer[] = [];
  let streamStarted = false;
  let pendingController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stdoutEnded = false;
  let controllerClosed = false;

  const onData = (chunk: Buffer): void => {
    if (controllerClosed) return;
    if (streamStarted && pendingController) {
      pendingController.enqueue(chunk);
    } else {
      bufferedChunks.push(chunk);
    }
  };

  const closeController = (): void => {
    if (!pendingController || controllerClosed) return;
    controllerClosed = true;
    const controller = pendingController;
    pendingController = null;
    controller.close();
  };

  const onEnd = (): void => {
    stdoutEnded = true;
    if (streamStarted) closeController();
    detach();
  };

  const detach = (): void => {
    stdout.removeListener('data', onData);
    stdout.removeListener('end', onEnd);
  };

  stdout.on('data', onData);
  stdout.on('end', onEnd);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      pendingController = controller;
      for (const chunk of bufferedChunks) {
        controller.enqueue(chunk);
      }
      bufferedChunks.length = 0;
      streamStarted = true;

      if (stdoutEnded) {
        closeController();
      }
    },
    cancel() {
      controllerClosed = true;
      pendingController = null;
      bufferedChunks.length = 0;
      detach();
    },
  });
}

export interface LoggedNdJsonStreamOptions {
  logger: Logger;
  sessionId: string;
  logFullContent?: boolean;
}

interface AcpMessageForLogging {
  jsonrpc?: string;
  method?: string;
  id?: string | number | null;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function createLoggedNdJsonStream<
  TStream extends { readable: ReadableStream<unknown>; writable: WritableStream<unknown> },
>(
  ndJsonStreamFn: (
    output: WritableStream<Uint8Array>,
    input: ReadableStream<Uint8Array>
  ) => TStream,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options: LoggedNdJsonStreamOptions
): TStream {
  const { logger, sessionId, logFullContent = false } = options;
  const baseStream = ndJsonStreamFn(output, input);

  const loggedWritable = new WritableStream<unknown>({
    async write(message) {
      const msg = message as AcpMessageForLogging;
      if (msg.method) {
        logger.debug(
          `[${sessionId}] ACP >>> ${msg.method} (id=${msg.id ?? 'notification'})${
            logFullContent ? ` ${JSON.stringify(message)}` : ''
          }`
        );
      } else if (msg.id !== undefined && msg.id !== null) {
        const status = msg.error ? 'error' : 'result';
        logger.debug(
          `[${sessionId}] ACP >>> response (id=${msg.id} ${status})${
            logFullContent ? ` ${JSON.stringify(message)}` : ''
          }`
        );
      }
      const writer = baseStream.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
    },
    close() {
      logger.debug(`[${sessionId}] ACP writable stream closed`);
    },
  });

  const loggedReadable = new ReadableStream<unknown>({
    async start(controller) {
      const reader = baseStream.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            logger.debug(`[${sessionId}] ACP readable stream ended`);
            controller.close();
            break;
          }
          if (value) {
            const msg = value as AcpMessageForLogging;
            if (msg.method) {
              logger.debug(
                `[${sessionId}] ACP <<< ${msg.method} (id=${msg.id ?? 'notification'})${
                  logFullContent ? ` ${JSON.stringify(value)}` : ''
                }`
              );
            } else if (msg.id !== undefined && msg.id !== null) {
              const status = msg.error ? 'error' : 'result';
              logger.debug(
                `[${sessionId}] ACP <<< response (id=${msg.id} ${status})${
                  logFullContent ? ` ${JSON.stringify(value)}` : ''
                }`
              );
            }
            controller.enqueue(value);
          }
        }
      } catch (err) {
        logger.error(`[${sessionId}] ACP readable stream error: ${err}`);
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return { readable: loggedReadable, writable: loggedWritable } as TStream;
}
