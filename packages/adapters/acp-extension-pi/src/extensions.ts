import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix } from "node:path";
import { z } from "zod";

export const PI_EXTENSIONS_ENV = "LODY_PI_EXTENSIONS";

const MAX_SELECTIONS = 32;
const MAX_DISCOVERED = 256;
const MAX_SETTINGS_BYTES = 1024 * 1024;

const USAGE =
  "Pi accepts only --provider, --model, --thinking and repeatable -e/--extension flags";
const VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--thinking",
  "-e",
  "--extension",
]);

const settingsSchema = z.object({
  packages: z
    .array(
      z.union([
        z.string(),
        z.object({
          source: z.string(),
          autoload: z.boolean().optional(),
          extensions: z.array(z.string()).optional(),
          skills: z.array(z.string()).optional(),
          prompts: z.array(z.string()).optional(),
          themes: z.array(z.string()).optional(),
        }),
      ]),
    )
    .optional(),
  extensions: z.array(z.string()).optional(),
});

function normalizeExtensionPath(value: string): string {
  let path = value.trim();
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || path.startsWith("~\\"))
    path = join(homedir(), path.slice(2));
  if (!isAbsolute(path))
    throw new Error(
      `Invalid extension path "${value}": expected an absolute path or ~/path`,
    );
  path = normalize(path);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`Invalid extension path "${value}": path does not exist`);
  }
  if (!stats.isFile() && !stats.isDirectory())
    throw new Error(
      `Invalid extension path "${value}": expected a file or directory`,
    );
  return path;
}

export function parsePiLaunchArgs(args: string[]): {
  args: string[];
  extensions: string[];
} {
  const passthrough: string[] = [];
  const extensions: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (!VALUE_FLAGS.has(flag) || !value?.trim() || value.startsWith("-"))
      throw new Error(`${USAGE}; got "${flag}"`);
    i++;
    if (flag === "-e" || flag === "--extension") {
      const path = normalizeExtensionPath(value);
      // Dedupe on the resolved path so case or symlink aliases of the same
      // file do not reach Pi twice.
      const key = realpathSync(path);
      if (seen.has(key)) continue;
      seen.add(key);
      extensions.push(path);
      if (extensions.length > MAX_SELECTIONS)
        throw new Error(
          `At most ${MAX_SELECTIONS} extension selections are supported`,
        );
      continue;
    }
    passthrough.push(flag, value);
  }
  return {
    args: [...passthrough, ...extensions.flatMap((path) => ["-e", path])],
    extensions,
  };
}

function extensionNames(
  items: Array<{ path: string; packageDir?: string }>,
): string[] {
  const slash = (path: string) => path.replace(/\\/g, "/");
  const packageEntries = new Map<string, number>();
  for (const { packageDir } of items)
    if (packageDir !== undefined)
      packageEntries.set(packageDir, (packageEntries.get(packageDir) ?? 0) + 1);
  return items.map(({ path, packageDir }) => {
    const file = posix.parse(slash(path));
    if (packageDir === undefined)
      return file.name === "index" ? posix.basename(file.dir) : file.base;
    const dir = slash(packageDir);
    const label =
      /\/node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(dir)?.[1] ??
      posix.basename(dir);
    if (packageEntries.get(packageDir) === 1) return label;
    const entry = posix.relative(dir, slash(path)).replace(/^extensions\//, "");
    const parsed = posix.parse(entry);
    return `${label}:${parsed.name === "index" && parsed.dir ? parsed.dir : entry}`;
  });
}

export async function discoverPiExtensions(): Promise<{
  version: 1;
  agentDir: string;
  extensions: Array<{
    path: string;
    name: string;
    source: "package" | "settings" | "directory";
  }>;
  warnings: string[];
}> {
  const { DefaultPackageManager, SettingsManager, getAgentDir } =
    await import("@earendil-works/pi-coding-agent");
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");
  let content: string | undefined;
  try {
    content = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Pi settings could not be read: ${settingsPath}`);
  }
  if (content !== undefined && Buffer.byteLength(content) > MAX_SETTINGS_BYTES)
    throw new Error(`Pi settings exceed the 1 MiB limit: ${settingsPath}`);
  let settings = {};
  if (content !== undefined) {
    try {
      settings = settingsSchema.parse(
        JSON.parse(content.replace(/^\uFEFF/, "")),
      );
    } catch {
      throw new Error(`Pi settings are invalid: ${settingsPath}`);
    }
  }
  const settingsManager = SettingsManager.inMemory(settings, {
    projectTrusted: false,
  });
  const manager = new DefaultPackageManager({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
  });
  let missing = false;
  const resources = await manager.resolve(async () => {
    missing = true;
    return "skip";
  });
  const user = resources.extensions.filter(
    (item) => item.metadata.scope === "user",
  );
  const names = extensionNames(
    user.map((item) => ({
      path: item.path,
      packageDir:
        item.metadata.origin === "package" ? item.metadata.baseDir : undefined,
    })),
  );
  const extensions = user
    .map((item, index) => ({
      path: item.path,
      name: names[index],
      source:
        item.metadata.origin === "package"
          ? ("package" as const)
          : item.metadata.source === "auto"
            ? ("directory" as const)
            : ("settings" as const),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const warnings: string[] = [];
  if (missing)
    warnings.push(
      "Some configured packages are not installed at the configured version. Install them with Pi, then scan again.",
    );
  if (extensions.length > MAX_DISCOVERED) {
    extensions.length = MAX_DISCOVERED;
    warnings.push(
      `Only the first ${MAX_DISCOVERED} discovered extensions are listed.`,
    );
  }
  return { version: 1, agentDir, extensions, warnings };
}
