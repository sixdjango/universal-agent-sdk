import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export interface RunKimiAcpOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export function resolveKimiExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.UA_KIMI_PATH?.trim() || env.KIMI_PATH?.trim();
  if (explicit && existsSync(explicit)) {
    return resolve(explicit);
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates: string[] = [];
  if (home) {
    candidates.push(join(home, '.kimi-code', 'bin'));
    candidates.push(join(home, '.local', 'bin'));
    candidates.push(join(home, 'bin'));
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const pathDirs = (env[pathKey] ?? '').split(delimiter).filter(Boolean);
  const allDirs = [...pathDirs, ...candidates];
  const extList =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

  for (const dir of allDirs) {
    for (const ext of extList) {
      const fullPath = join(dir, `kimi${ext.toLowerCase()}`);
      if (existsSync(fullPath)) {
        return fullPath;
      }
      if (ext) {
        const upperPath = join(dir, `kimi${ext.toUpperCase()}`);
        if (existsSync(upperPath)) {
          return upperPath;
        }
      }
    }
  }
  return undefined;
}

export function runKimiAcp(options: RunKimiAcpOptions = {}): void {
  const env = {
    ...process.env,
    ...options.env,
    KIMI_CODE_NO_AUTO_UPDATE: '1',
  };
  const executable = resolveKimiExecutable(env);
  if (!executable) {
    console.error(
      '[acp-extension-kimi] Kimi CLI (`kimi`) was not found on PATH or ~/.kimi-code/bin. Install Kimi Code CLI or specify `executablePath`.'
    );
    process.exit(1);
  }

  const rawArgs = options.args ?? process.argv.slice(2);
  const finalArgs = rawArgs[0] === 'acp' ? rawArgs : ['acp', ...rawArgs];

  const child = spawn(executable, finalArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on('error', (error) => {
    console.error('[acp-extension-kimi] Failed to spawn kimi:', error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (!child.killed) {
        child.kill(sig);
      }
    });
  }
}
