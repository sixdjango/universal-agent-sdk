import {
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../process/stream';

export const COLD_NPX_INIT_TIMEOUT_MS = 300_000;
export const DEFAULT_NPX_STARTUP_MAX_ATTEMPTS = 3;

export type AcpStartupTimeoutOptions = {
  initTimeoutMs?: number;
  newSessionTimeoutMs?: number;
  loadSessionTimeoutMs?: number;
  resumeSessionTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BROKEN_INSTALL_SIGNATURES: readonly string[] = [
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'Cannot find package',
  'Cannot find module',
  'Failed to locate',
  'no prebuilt binary for',
  'optional dependency was not installed',
  'could not determine executable to run',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_INVALID_PACKAGE_TARGET',
];

declare const NPX_INSTALL_STATE_BRAND: unique symbol;

type NpxInstallStateBrand = {
  readonly [NPX_INSTALL_STATE_BRAND]: true;
};

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type NpxInstallProblemReason =
  | 'root-package-json-missing'
  | 'root-package-json-invalid'
  | 'package-json-missing'
  | 'package-json-invalid'
  | 'package-version-mismatch'
  | 'package-bin-missing'
  | 'package-bin-target-missing';

export type NpxInstallProblem = Readonly<{
  dir: string;
  reason: NpxInstallProblemReason;
  path?: string;
  message?: string;
}>;

export type ReadyNpxInstallState = Readonly<
  {
    kind: 'ready';
    dirs: NonEmptyReadonlyArray<string>;
  } & NpxInstallStateBrand
>;

export type MissingNpxInstallState = Readonly<
  {
    kind: 'missing';
  } & NpxInstallStateBrand
>;

export type BrokenNpxInstallState = Readonly<
  {
    kind: 'broken';
    dirs: NonEmptyReadonlyArray<string>;
    problems: NonEmptyReadonlyArray<NpxInstallProblem>;
  } & NpxInstallStateBrand
>;

export type NpxInstallState = ReadyNpxInstallState | MissingNpxInstallState | BrokenNpxInstallState;

const NPM_CACHE_CORRUPTION_SIGNATURES: readonly string[] = [
  'eintegrity',
  'tarball data seems to be corrupted',
  'zlib: unexpected end of file',
  'invalid tar header',
];

const NPX_COMMAND_NAMES = new Set(['npx', 'npx.cmd', 'npx.exe']);

export function isNpxCommand(command: string): boolean {
  const normalized = command.trim().replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const basename = (lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized).toLowerCase();
  return NPX_COMMAND_NAMES.has(basename);
}

export function getManagedNpmCacheDir(
  options: { dataDir?: string; home?: string } = {}
): string {
  const dataDir = options.dataDir ?? join(options.home ?? homedir(), '.universal-agent');
  return join(dataDir, 'npm-cache');
}

/** @deprecated Use `getManagedNpmCacheDir`. */
export function getLodyNpmCacheDir(home: string = homedir()): string {
  return getManagedNpmCacheDir({ home });
}

function normalizeCachePathForCompare(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export function getConfiguredNpmCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  const cacheDir = env.npm_config_cache?.trim() || env.NPM_CONFIG_CACHE?.trim();
  return cacheDir || undefined;
}

export function getConfiguredNpxCacheRoot(env: NodeJS.ProcessEnv): string | undefined {
  const cacheDir = getConfiguredNpmCacheDir(env);
  return cacheDir ? join(cacheDir, '_npx') : undefined;
}

export function isManagedNpmCacheDir(
  cacheDir: string | undefined,
  options: { dataDir?: string; home?: string } = {}
): boolean {
  if (!cacheDir) {
    return false;
  }
  return (
    normalizeCachePathForCompare(cacheDir) ===
    normalizeCachePathForCompare(getManagedNpmCacheDir(options))
  );
}

export function withManagedNpmCacheForNpx(
  command: string,
  env: NodeJS.ProcessEnv,
  options: { dataDir?: string; home?: string } = {}
): NodeJS.ProcessEnv {
  if (!isNpxCommand(command)) {
    return env;
  }

  const cacheDir = getManagedNpmCacheDir(options);
  return {
    ...env,
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir,
  };
}

/** @deprecated Use `withManagedNpmCacheForNpx`. */
export const withLodyNpmCacheForNpx = withManagedNpmCacheForNpx;

export function isLikelyBrokenNpxInstall(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  if (
    normalized.includes('_npx') &&
    normalized.includes('package.json') &&
    (normalized.includes('could not read package.json') || normalized.includes('enoent'))
  ) {
    return true;
  }
  return BROKEN_INSTALL_SIGNATURES.some((signature) => text.includes(signature));
}

export function isLikelyNpmCacheCorruption(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  if (NPM_CACHE_CORRUPTION_SIGNATURES.some((signature) => normalized.includes(signature))) {
    return true;
  }

  const mentionsNpmCache =
    normalized.includes('_cacache') ||
    normalized.includes('npm cache') ||
    normalized.includes('.universal-agent/npm-cache') ||
    normalized.includes('.universal-agent\\npm-cache') ||
    normalized.includes('.lody/npm-cache') ||
    normalized.includes('.lody\\npm-cache');
  if (!mentionsNpmCache) {
    return false;
  }

  return (
    normalized.includes('syscall rename') ||
    normalized.includes('eexist') ||
    normalized.includes('eacces') ||
    normalized.includes('eperm') ||
    normalized.includes('permission denied') ||
    normalized.includes('file exists')
  );
}

const NPX_CACHE_DIR_RE = /([^\s'"`()]*[/\\]_npx[/\\][0-9a-fA-F]+)/g;

export function extractNpxCacheDirsFromText(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  const dirs = new Set<string>();
  for (const match of text.matchAll(NPX_CACHE_DIR_RE)) {
    if (match[1]) {
      dirs.add(match[1]);
    }
  }
  return [...dirs];
}

export interface NpxCacheIo {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  readdirSync(path: string): string[];
  rmSync(path: string): void;
}

const defaultIo: NpxCacheIo = {
  existsSync: (path) => fsExistsSync(path),
  readFileSync: (path) => fsReadFileSync(path, 'utf8'),
  readdirSync: (path) => fsReaddirSync(path),
  rmSync: (path) => fsRmSync(path, { recursive: true, force: true }),
};

function listNpxCacheDirs(
  roots: readonly string[],
  io: Pick<NpxCacheIo, 'existsSync' | 'readdirSync'>
): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    try {
      if (!io.existsSync(root)) {
        continue;
      }
      for (const entry of io.readdirSync(root)) {
        dirs.push(join(root, entry));
      }
    } catch {
      // Ignore unreadable roots
    }
  }
  return dirs;
}

function purgeExistingDirs(
  candidates: Iterable<string>,
  io: Pick<NpxCacheIo, 'existsSync' | 'rmSync'>,
  allowedRoots?: readonly string[]
): string[] {
  const normalizedAllowedRoots = allowedRoots?.map(normalizeCachePathForCompare);
  const purged: string[] = [];

  for (const dir of new Set(candidates)) {
    if (normalizedAllowedRoots) {
      const normalizedDir = normalizeCachePathForCompare(dir);
      const isAllowed = normalizedAllowedRoots.some(
        (root) => normalizedDir === root || normalizedDir.startsWith(`${root}/`)
      );
      if (!isAllowed) {
        continue;
      }
    }

    try {
      if (!io.existsSync(dir)) {
        continue;
      }
      io.rmSync(dir);
      purged.push(dir);
    } catch {
      // Best effort
    }
  }

  return purged;
}

function brandNpxInstallState<T extends object>(state: T): Readonly<T & NpxInstallStateBrand> {
  return Object.freeze(state) as Readonly<T & NpxInstallStateBrand>;
}

function toNonEmptyReadonlyArray<T>(items: readonly T[]): NonEmptyReadonlyArray<T> | undefined {
  if (items.length === 0) {
    return undefined;
  }
  return Object.freeze([...items]) as NonEmptyReadonlyArray<T>;
}

function createMissingNpxInstallState(): MissingNpxInstallState {
  return brandNpxInstallState({ kind: 'missing' });
}

function createReadyNpxInstallState(dirs: readonly string[]): ReadyNpxInstallState {
  const nonEmptyDirs = toNonEmptyReadonlyArray([...new Set(dirs)]);
  if (!nonEmptyDirs) {
    throw new Error('ready npx install state requires at least one directory');
  }
  return brandNpxInstallState({ kind: 'ready', dirs: nonEmptyDirs });
}

function createBrokenNpxInstallState(
  problems: readonly NpxInstallProblem[]
): BrokenNpxInstallState | MissingNpxInstallState {
  const dirs = toNonEmptyReadonlyArray([...new Set(problems.map((problem) => problem.dir))]);
  const nonEmptyProblems = toNonEmptyReadonlyArray(problems);
  if (!dirs || !nonEmptyProblems) {
    return createMissingNpxInstallState();
  }
  return brandNpxInstallState({
    kind: 'broken',
    dirs,
    problems: nonEmptyProblems,
  });
}

function readJsonRecord(
  io: Pick<NpxCacheIo, 'readFileSync'>,
  filePath: string
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed: unknown = JSON.parse(io.readFileSync(filePath));
    if (!isRecord(parsed)) {
      return { ok: false, message: 'JSON root is not an object' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function recordHasPackageVersion(
  rootPackageJson: Record<string, unknown>,
  packageName: string,
  version: string
): boolean {
  const npxMeta = rootPackageJson._npx;
  if (isRecord(npxMeta) && Array.isArray(npxMeta.packages)) {
    return npxMeta.packages.includes(`${packageName}@${version}`);
  }

  const dependencies = rootPackageJson.dependencies;
  if (isRecord(dependencies) && typeof dependencies[packageName] === 'string') {
    const dependencyVersion = dependencies[packageName].trim();
    return (
      dependencyVersion === version ||
      dependencyVersion === `^${version}` ||
      dependencyVersion === `~${version}`
    );
  }

  return false;
}

function resolvePackageBinTargets(
  packageJson: Record<string, unknown>,
  packageDir: string
): string[] {
  const bin = packageJson.bin;
  if (typeof bin === 'string' && bin.trim()) {
    return [join(packageDir, bin)];
  }
  if (!isRecord(bin)) {
    return [];
  }
  return Object.values(bin)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((relativePath) => join(packageDir, relativePath));
}

export interface NpxCacheLocateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  dataDir?: string;
}

export function getNpxCacheRoots(options: NpxCacheLocateOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const roots = new Set<string>();

  const configuredCache = env.npm_config_cache?.trim();
  if (configuredCache) {
    roots.add(join(configuredCache, '_npx'));
  }

  if (home) {
    if (platform === 'win32') {
      const localAppData = env.LOCALAPPDATA?.trim();
      if (localAppData) {
        roots.add(join(localAppData, 'npm-cache', '_npx'));
      }
      roots.add(join(home, 'AppData', 'Local', 'npm-cache', '_npx'));
    } else {
      roots.add(join(home, '.npm', '_npx'));
    }
  }

  return [...roots];
}

export interface InspectNpxInstallStateOptions extends NpxCacheLocateOptions {
  io?: NpxCacheIo;
  roots?: string[];
}

export function inspectNpxInstallState(
  packageName: string,
  version: string,
  options: InspectNpxInstallStateOptions = {}
): NpxInstallState {
  const io = options.io ?? defaultIo;
  const roots = options.roots ?? getNpxCacheRoots(options);
  const readyDirs: string[] = [];
  const problems: NpxInstallProblem[] = [];

  for (const dir of listNpxCacheDirs(roots, io)) {
    const rootPackageJsonPath = join(dir, 'package.json');
    const packageDir = join(dir, 'node_modules', packageName);
    const packageJsonPath = join(packageDir, 'package.json');
    const hasRootPackageJson = io.existsSync(rootPackageJsonPath);
    const hasPackageJson = io.existsSync(packageJsonPath);
    let rootPackageJson: Record<string, unknown> | null = null;
    let rootProblem: NpxInstallProblem | null = null;

    if (hasRootPackageJson) {
      const rootRead = readJsonRecord(io, rootPackageJsonPath);
      if (rootRead.ok) {
        rootPackageJson = rootRead.value;
      } else {
        rootProblem = {
          dir,
          reason: 'root-package-json-invalid',
          path: rootPackageJsonPath,
          message: rootRead.message,
        };
      }
    } else if (hasPackageJson) {
      rootProblem = {
        dir,
        reason: 'root-package-json-missing',
        path: rootPackageJsonPath,
      };
    }

    const rootReferencesPackage = rootPackageJson
      ? recordHasPackageVersion(rootPackageJson, packageName, version)
      : false;
    if (!rootReferencesPackage && !hasPackageJson) {
      continue;
    }

    if (!hasPackageJson) {
      problems.push({
        dir,
        reason: 'package-json-missing',
        path: packageJsonPath,
      });
      continue;
    }

    const packageRead = readJsonRecord(io, packageJsonPath);
    if (!packageRead.ok) {
      if (rootProblem) {
        problems.push(rootProblem);
      }
      problems.push({
        dir,
        reason: 'package-json-invalid',
        path: packageJsonPath,
        message: packageRead.message,
      });
      continue;
    }

    if (packageRead.value.version !== version) {
      if (rootReferencesPackage) {
        problems.push({
          dir,
          reason: 'package-version-mismatch',
          path: packageJsonPath,
          message: `expected ${version}, found ${String(packageRead.value.version)}`,
        });
      }
      continue;
    }

    if (rootProblem) {
      problems.push(rootProblem);
      continue;
    }

    const binTargets = resolvePackageBinTargets(packageRead.value, packageDir);
    if (binTargets.length === 0) {
      problems.push({
        dir,
        reason: 'package-bin-missing',
        path: packageJsonPath,
      });
      continue;
    }

    if (!binTargets.some((target) => io.existsSync(target))) {
      problems.push({
        dir,
        reason: 'package-bin-target-missing',
        path: binTargets[0],
      });
      continue;
    }

    readyDirs.push(dir);
  }

  if (problems.length > 0) {
    return createBrokenNpxInstallState(problems);
  }

  if (readyDirs.length > 0) {
    return createReadyNpxInstallState(readyDirs);
  }

  return createMissingNpxInstallState();
}

export function findNpxCacheDirsForPackage(
  packageName: string,
  version: string,
  options: NpxCacheLocateOptions & { io?: NpxCacheIo; roots?: string[] } = {}
): string[] {
  const io = options.io ?? defaultIo;
  const roots = options.roots ?? getNpxCacheRoots(options);
  const found = new Set<string>();

  for (const dir of listNpxCacheDirs(roots, io)) {
    const packageJsonPath = join(dir, 'node_modules', packageName, 'package.json');
    try {
      if (!io.existsSync(packageJsonPath)) {
        continue;
      }
      const parsed: unknown = JSON.parse(io.readFileSync(packageJsonPath));
      if (isRecord(parsed) && parsed.version === version) {
        found.add(dir);
      }
    } catch {
      found.add(dir);
    }
  }

  return [...found];
}

export interface PurgeBrokenNpxCacheArgs extends NpxCacheLocateOptions {
  packageName?: string;
  version?: string;
  hintText?: string | null;
  io?: NpxCacheIo;
  roots?: string[];
  allowedRoots?: string[];
}

export function purgeBrokenNpxCache(args: PurgeBrokenNpxCacheArgs): string[] {
  const io = args.io ?? defaultIo;
  const candidates = new Set<string>(extractNpxCacheDirsFromText(args.hintText));

  if (args.packageName && args.version) {
    for (const dir of findNpxCacheDirsForPackage(args.packageName, args.version, {
      io,
      roots: args.roots,
      env: args.env,
      platform: args.platform,
      home: args.home,
      dataDir: args.dataDir,
    })) {
      candidates.add(dir);
    }
  }

  return purgeExistingDirs(candidates, io, args.allowedRoots);
}

export interface PurgeBrokenNpxInstallArgs {
  io?: Pick<NpxCacheIo, 'existsSync' | 'rmSync'>;
  allowedRoots?: string[];
}

export function purgeBrokenNpxInstall(
  state: BrokenNpxInstallState,
  args: PurgeBrokenNpxInstallArgs = {}
): string[] {
  const io = args.io ?? defaultIo;
  return purgeExistingDirs(state.dirs, io, args.allowedRoots);
}

export interface PurgeManagedNpmCacheArgs extends NpxCacheLocateOptions {
  io?: Pick<NpxCacheIo, 'existsSync' | 'rmSync'>;
}

export function purgeManagedNpmCache(args: PurgeManagedNpmCacheArgs): string[] {
  const io = args.io ?? defaultIo;
  const cacheDir = getConfiguredNpmCacheDir(args.env ?? process.env);
  if (!cacheDir || !isManagedNpmCacheDir(cacheDir, { dataDir: args.dataDir, home: args.home })) {
    return [];
  }

  const candidates = [join(cacheDir, '_npx'), join(cacheDir, '_cacache')];
  return purgeExistingDirs(candidates, io);
}

/** @deprecated Use `purgeManagedNpmCache`. */
export const purgeLodyNpmCache = purgeManagedNpmCache;

export interface NpxPackageSpec {
  name: string;
  version: string;
}

export function parseNpxPackageSpec(spec: string | undefined): NpxPackageSpec | undefined {
  if (!spec) {
    return undefined;
  }
  const at = spec.lastIndexOf('@');
  if (at <= 0) {
    return undefined;
  }
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!name || !version) {
    return undefined;
  }
  return { name, version };
}

export function parseNpxPackageSpecFromArgs(args: readonly string[]): NpxPackageSpec | undefined {
  const yesIndex = args.findIndex((arg) => arg === '-y' || arg === '--yes');
  if (yesIndex === -1) {
    return undefined;
  }
  const directSpec = parseNpxPackageSpec(args[yesIndex + 1]);
  if (directSpec) {
    return directSpec;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--package' || arg === '-p') {
      const packageSpec = parseNpxPackageSpec(args[index + 1]);
      if (packageSpec) return packageSpec;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--package=')) {
      const packageSpec = parseNpxPackageSpec(arg.slice('--package='.length));
      if (packageSpec) return packageSpec;
    }
  }
  return undefined;
}

export type NpxStartupAttemptInput = {
  attempt: number;
  args: readonly string[];
  startupTimeouts?: AcpStartupTimeoutOptions;
};

export type RunNpxStartupWithRecoveryOptions<T> = {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  logger: Pick<Logger, 'debug' | 'warn'>;
  logPrefix: string;
  attempt(input: NpxStartupAttemptInput): Promise<T>;
  getStderrTail(): string;
  cleanupFailedAttempt?: () => Promise<void>;
  startupTimeouts?: AcpStartupTimeoutOptions;
  coldInitTimeoutMs?: number;
  maxAttempts?: number;
  npxCacheIo?: NpxCacheIo;
  npxCacheRoots?: string[];
  dataDir?: string;
};

function describeStartupError(error: unknown, stderrTail?: string): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const embeddedStderrTail =
    typeof error === 'object' &&
    error !== null &&
    'stderrTail' in error &&
    typeof error.stderrTail === 'string'
      ? error.stderrTail
      : undefined;
  const fallbackStderrTail = embeddedStderrTail ?? stderrTail?.trim() ?? '';
  return fallbackStderrTail ? `${errorMessage}\n${fallbackStderrTail}` : errorMessage;
}

function withColdNpxInitTimeout(
  startupTimeouts: AcpStartupTimeoutOptions | undefined,
  coldInitTimeoutMs: number
): AcpStartupTimeoutOptions {
  const currentInitTimeoutMs = startupTimeouts?.initTimeoutMs ?? 0;
  return {
    ...startupTimeouts,
    initTimeoutMs: Math.max(currentInitTimeoutMs, coldInitTimeoutMs),
  };
}

function isColdNpxInitializeTimeout(error: unknown, installWasCold: boolean): boolean {
  return (
    installWasCold &&
    error instanceof Error &&
    error.name === 'AcpTimeoutError' &&
    (error as { operationName?: unknown }).operationName === 'connection.initialize'
  );
}

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isLikelyStaleNpxPackageMetadata(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('code etarget') ||
    normalized.includes('no matching version found for') ||
    (normalized.includes('code e404') && normalized.includes('no match found for version'))
  );
}

function preferOnlineNpxArgs(args: readonly string[]): readonly string[] {
  return args.map((arg) => (arg === '--prefer-offline' ? '--prefer-online' : arg));
}

export async function runNpxStartupWithRecovery<T>(
  options: RunNpxStartupWithRecoveryOptions<T>
): Promise<T> {
  const npxSpec = isNpxCommand(options.command)
    ? parseNpxPackageSpecFromArgs(options.args)
    : undefined;
  if (!npxSpec) {
    return options.attempt({
      attempt: 1,
      args: options.args,
      startupTimeouts: options.startupTimeouts,
    });
  }

  const maxAttempts = options.maxAttempts ?? DEFAULT_NPX_STARTUP_MAX_ATTEMPTS;
  const coldInitTimeoutMs = options.coldInitTimeoutMs ?? COLD_NPX_INIT_TIMEOUT_MS;
  const npxCacheRoot = getConfiguredNpxCacheRoot(options.env);
  const roots = options.npxCacheRoots ?? (npxCacheRoot ? [npxCacheRoot] : undefined);
  const allowedRoots = options.npxCacheRoots ?? (npxCacheRoot ? [npxCacheRoot] : []);
  let refreshMetadataOnNextAttempt = false;
  let metadataRefreshAttempted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let installState = inspectNpxInstallState(npxSpec.name, npxSpec.version, {
      env: options.env,
      roots,
      io: options.npxCacheIo,
      dataDir: options.dataDir,
    });
    let installWasCold = installState.kind === 'missing';

    if (installState.kind === 'broken') {
      const purged = purgeBrokenNpxInstall(installState, {
        io: options.npxCacheIo,
        allowedRoots,
      });
      installWasCold = true;
      options.logger.warn(
        `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} has a broken npx install; ` +
          `purged ${purged.length} npx cache dir(s) before startup (attempt ${attempt}/${maxAttempts})`
      );
      installState = inspectNpxInstallState(npxSpec.name, npxSpec.version, {
        env: options.env,
        roots,
        io: options.npxCacheIo,
        dataDir: options.dataDir,
      });
    }

    const startupTimeouts = installWasCold
      ? withColdNpxInitTimeout(options.startupTimeouts, coldInitTimeoutMs)
      : options.startupTimeouts;
    const attemptArgs = refreshMetadataOnNextAttempt
      ? preferOnlineNpxArgs(options.args)
      : options.args;
    refreshMetadataOnNextAttempt = false;

    try {
      return await options.attempt({
        attempt,
        args: attemptArgs,
        startupTimeouts,
      });
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }

      const hintText = describeStartupError(error, options.getStderrTail());
      const shouldRefreshPackageMetadata =
        installWasCold &&
        !metadataRefreshAttempted &&
        options.args.includes('--prefer-offline') &&
        EXACT_SEMVER_RE.test(npxSpec.version) &&
        isLikelyStaleNpxPackageMetadata(hintText);
      if (shouldRefreshPackageMetadata) {
        metadataRefreshAttempted = true;
        refreshMetadataOnNextAttempt = true;
        await options.cleanupFailedAttempt?.();
        options.logger.warn(
          `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} was missing from cached npm ` +
            `metadata; retrying once with an online metadata refresh (attempt ${
              attempt + 1
            }/${maxAttempts})`
        );
        continue;
      }

      const shouldPurgeCache =
        isLikelyNpmCacheCorruption(hintText) || isColdNpxInitializeTimeout(error, installWasCold);
      if (shouldPurgeCache) {
        const brokenPurged = purgeBrokenNpxCache({
          packageName: npxSpec.name,
          version: npxSpec.version,
          hintText,
          env: options.env,
          roots,
          allowedRoots,
          io: options.npxCacheIo,
          dataDir: options.dataDir,
        });
        const managedPurged =
          brokenPurged.length === 0
            ? purgeManagedNpmCache({
                env: options.env,
                io: options.npxCacheIo,
                dataDir: options.dataDir,
              })
            : [];
        await options.cleanupFailedAttempt?.();
        options.logger.warn(
          `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} failed during npx startup; ` +
            `purged ${brokenPurged.length + managedPurged.length} npm cache dir(s), retrying ` +
            `(attempt ${attempt + 1}/${maxAttempts})`
        );
        continue;
      }

      if (isLikelyBrokenNpxInstall(hintText)) {
        const purged = purgeBrokenNpxCache({
          packageName: npxSpec.name,
          version: npxSpec.version,
          hintText,
          env: options.env,
          roots,
          allowedRoots,
          io: options.npxCacheIo,
          dataDir: options.dataDir,
        });
        await options.cleanupFailedAttempt?.();
        options.logger.warn(
          `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} failed with a broken-install error; ` +
            `purged ${purged.length} npx cache dir(s), retrying (attempt ${
              attempt + 1
            }/${maxAttempts})`
        );
        continue;
      }

      throw error;
    }
  }

  throw new Error('[acp-startup] exhausted ACP startup attempts without a result');
}
