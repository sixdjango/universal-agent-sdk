import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

export const WORKSPACE_CONFIG_ENV = "LODY_PI_WORKSPACE_CONFIG";

const absolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => isAbsolute(value) && !value.includes("\0"),
    "Workspace paths must be absolute",
  );
const workspaceSchema = z.object({
  cwd: absolutePath,
  additionalDirectories: z.array(absolutePath).optional(),
});
export type Workspace = { cwd: string; additionalDirectories: string[] };

/** Each activation supplies the whole request-owned list; omission clears it. */
export function validateWorkspace(input: unknown): Workspace {
  const parsed = workspaceSchema.parse(input);
  return {
    cwd: normalize(parsed.cwd),
    additionalDirectories: [
      ...new Set((parsed.additionalDirectories ?? []).map(normalize)),
    ],
  };
}

/** Private runtime bridge, read once per native extension activation. */
export function readWorkspace(): Workspace {
  const file = process.env[WORKSPACE_CONFIG_ENV];
  if (!file) throw new Error("Missing Lody Pi workspace configuration");
  return validateWorkspace(JSON.parse(readFileSync(file, "utf8")));
}

export function workspaceContext(workspace: Workspace): string {
  return [
    "ACP workspace directories",
    JSON.stringify(workspace),
    "cwd is the primary working directory and the base for relative paths. The additional directories are also part of this activation's workspace; use absolute paths to access them with native file tools or bash. This list supplies workspace context, not a sandbox or a change to Pi's permissions. Existing user configuration remains in effect.",
  ].join("\n");
}
