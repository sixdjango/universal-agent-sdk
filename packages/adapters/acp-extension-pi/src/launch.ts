import { fileURLToPath } from "node:url";

export const UA_PI_PATH_ENV = "UA_PI_PATH";
export const PI_PATH_ENV = "LODY_PI_PATH";

export type PiLaunch = {
  command: string;
  args: string[];
};

/**
 * Resolve the Pi CLI to launch. UA_PI_PATH (or legacy LODY_PI_PATH) overrides
 * the packaged CLI; the result is handed straight to cross-spawn.
 */
export function resolvePiLaunch(
  extraArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  resolveBundledEntry: () => string = defaultBundledEntry,
): PiLaunch {
  const override = env[UA_PI_PATH_ENV]?.trim() || env[PI_PATH_ENV]?.trim();
  if (!override) {
    return {
      command: process.execPath,
      args: [resolveBundledEntry(), ...extraArgs],
    };
  }
  return { command: override, args: extraArgs };
}

function defaultBundledEntry(): string {
  return fileURLToPath(
    new URL(
      "./bundle/cli.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ),
  );
}
