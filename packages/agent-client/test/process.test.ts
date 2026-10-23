import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveDeepSeekHarnessSpawn,
  UA_DSH_NODE_EXECUTABLE_ENV,
} from '../src/launcher/deepseek-runtime';
import { startProcess, terminateChildTree } from '../src/process/process-tree';
import {
  AcpSessionStartGate,
  AcpSessionStartQueueTimeoutError,
} from '../src/process/start-gate';
import {
  AcpStartupProcessExitError,
  appendStderrTail,
  createAcpStartupMonitor,
} from '../src/process/startup-monitor';

describe('process primitives & invariants', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('enforces concurrency limit, dynamic concurrency override, and queue timeout in AcpSessionStartGate', async () => {
    const gate = new AcpSessionStartGate({ maxConcurrent: 1 });
    expect(gate.maxConcurrent).toBe(1);

    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstRun = gate.run({ label: 'first' }, async () => {
      await first;
      return 'done-1';
    });

    await expect(
      gate.run({ label: 'second', waitTimeoutMs: 40 }, async () => 'done-2')
    ).rejects.toBeInstanceOf(AcpSessionStartQueueTimeoutError);

    // Override concurrency to 2 while first is still holding a slot
    const thirdRun = gate.run({ label: 'third', concurrency: 2 }, async () => 'done-3');
    await expect(thirdRun).resolves.toBe('done-3');
    expect(gate.maxConcurrent).toBe(2);

    releaseFirst();
    await expect(firstRun).resolves.toBe('done-1');
  });

  it('captures stderr tail when child exits early in createAcpStartupMonitor', async () => {
    let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let tail = '';
    tail = appendStderrTail(tail, 'Fatal: missing API credentials\n');

    const monitor = createAcpStartupMonitor(
      {
        onExit: (listener) => {
          exitListener = listener;
          return () => {
            exitListener = undefined;
          };
        },
        onError: () => () => {},
      },
      {
        sessionId: 'test-session',
        command: 'claude-acp',
        args: ['--stdio'],
        getStderrTail: () => tail,
      }
    );

    exitListener?.(1, null);

    await expect(monitor.abortPromise).rejects.toThrowError(AcpStartupProcessExitError);
    await expect(monitor.abortPromise).rejects.toThrowError(/missing API credentials/);
    monitor.dispose();
  });

  it(
    'spawns a process group and terminates the entire child tree cleanly',
    async () => {
      const handle = startProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        options: { stdio: 'ignore' },
        processGroup: true,
      });

      expect(typeof handle.child.pid).toBe('number');
      await terminateChildTree(handle.child, {
        graceMs: process.platform === 'win32' ? 0 : 200,
        killWaitMs: 5000,
        processGroup: true,
      });
      const exit = await handle.exited;
      expect(exit.code !== null || exit.signal !== null).toBe(true);
    },
    20_000
  );

  it('bypasses cmd.exe on Windows for DeepSeek Harness by resolving npx-cli.js', () => {
    const fakeNodeBin = mkdtempSync(join(tmpdir(), 'ua-win-npx-'));
    tempDirs.push(fakeNodeBin);

    const npxCmd = join(fakeNodeBin, 'npx.cmd');
    const npxCliDir = join(fakeNodeBin, 'node_modules', 'npm', 'bin');
    const npxCliJs = join(npxCliDir, 'npx-cli.js');
    writeFileSync(npxCmd, '@ECHO OFF\r\n');
    rmSync(npxCliDir, { recursive: true, force: true });
    mkdirSync(npxCliDir, { recursive: true });
    writeFileSync(npxCliJs, '// npx-cli stub\n');

    const resolved = resolveDeepSeekHarnessSpawn({
      command: 'npx',
      args: ['--prefer-offline', '-y', '--package', '@deepseek-ai/dsh@1.0.0'],
      env: {
        PATH: fakeNodeBin,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        [UA_DSH_NODE_EXECUTABLE_ENV]: process.execPath,
      },
      workdir: fakeNodeBin,
      platform: 'win32',
    });

    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toBe('--import');
    expect(resolved.args[1]).toMatch(/^data:text\/javascript;base64,/);
    expect(resolved.args[2]).toContain('npx-cli.js');
  });
});
