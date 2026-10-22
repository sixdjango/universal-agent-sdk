import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnDevinRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}

/** Launch the official Devin CLI in ACP stdio mode. No environment is injected. */
export function spawnDevinRuntime(
  devinPath: string,
  { env = process.env, spawnImpl = spawn }: SpawnDevinRuntimeOptions = {},
): ChildProcess {
  return spawnImpl(devinPath, ["acp"], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
}
