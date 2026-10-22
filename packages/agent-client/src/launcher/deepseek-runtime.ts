import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION,
  ACP_EXTENSION_DSH_QUERY_PATH_ENV,
  ACP_EXTENSION_DSH_SESSION_ROOT_ENV,
  DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION,
  DEEPSEEK_HARNESS_PROFILE_NAME,
  DEEPSEEK_HARNESS_VERSION,
  createDeepSeekHarnessNpxSpecifiers,
  createDeepSeekHarnessProfileFiles,
  type DeepSeekHarnessSessionCompression,
} from '@universal-agent/acp-extension-dsh/profile';

export { DEEPSEEK_HARNESS_VERSION, createDeepSeekHarnessProfileFiles };
export const DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION = `${ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION}:provider-home-v1`;
export const DEEPSEEK_HARNESS_HOME_ENV = 'DSH_HOME';
export const DEEPSEEK_HARNESS_BASE_URL_ENV = 'DSH_BASE_URL';

const RAW_SESSION_ARTIFACT = /^session(?:\.v[1-9]\d*)?\.jsonl$/;
const ZSTD_SESSION_ARTIFACT = /^session(?:\.v[1-9]\d*)?\.jsonl\.zstd$/;
export const UA_DSH_NODE_EXECUTABLE_ENV = 'UA_DSH_NODE_EXECUTABLE';
export const UA_DSH_NODE_ARGS_ENV = 'UA_DSH_NODE_ARGS';
export const LODY_DSH_NODE_EXECUTABLE_ENV = 'LODY_DSH_NODE_EXECUTABLE';
export const LODY_DSH_NODE_ARGS_ENV = 'LODY_DSH_NODE_ARGS';

// windowsHide is not inherited by descendants. npm's shell and DSH's Windows
// Job runner omit it, so apply the ACP host policy inside those two processes.
const HIDE_WINDOWS_CHILD_CONSOLES = `
import { ChildProcess } from 'node:child_process';
if (process.platform === 'win32') {
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    return spawn.call(this, { ...options, windowsHide: true });
  };
}
`.trim();

/** Keep npx's logical command/argv for cache recovery; bypass its Windows shell shim only at spawn. */
export function resolveDeepSeekHarnessSpawn(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  workdir: string;
  platform?: NodeJS.Platform;
}): { command: string; args: string[] } {
  const { command, args, env, workdir } = options;
  const hasDshEnv = Boolean(
    env[UA_DSH_NODE_EXECUTABLE_ENV] || env[LODY_DSH_NODE_EXECUTABLE_ENV]
  );
  if (
    (options.platform ?? process.platform) !== 'win32' ||
    command !== 'npx' ||
    !hasDshEnv
  ) {
    return { command, args };
  }

  const envValue = (name: string) => {
    const key = Object.keys(env)
      .sort()
      .find((candidate) => candidate.toLowerCase() === name);
    return key ? env[key] : undefined;
  };
  const directories = [workdir, ...(envValue('path') ?? '').split(';')];
  const extensions = (envValue('pathext') ?? '.COM;.EXE;.BAT;.CMD').split(';');
  for (const directory of directories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const executable = resolve(
        workdir,
        directory.replace(/^"|"$/g, ''),
        `npx${extension.toLowerCase()}`
      );
      if (!existsSync(executable)) continue;
      // Native shims already avoid cmd.exe and its 8191-character limit.
      if (/\.(exe|com)$/i.test(extension)) return { command: executable, args };
      const entry = join(
        dirname(realpathSync(executable)),
        'node_modules',
        'npm',
        'bin',
        'npx-cli.js'
      );
      if (!existsSync(entry)) {
        throw new Error(
          `Cannot launch DeepSeek Harness without cmd.exe: npm's npx-cli.js is missing beside ${executable}. Install Node.js with npm and retry.`
        );
      }
      return {
        command: process.execPath,
        args: [
          '--import',
          `data:text/javascript;base64,${encodeBase64(HIDE_WINDOWS_CHILD_CONSOLES)}`,
          entry,
          ...args,
        ],
      };
    }
  }
  throw new Error(
    'Cannot launch DeepSeek Harness: npx was not found on PATH. Install Node.js with npm and retry.'
  );
}

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function createDeepSeekHarnessNodeLauncherArg(): string {
  const source = `
const { spawn } = require('node:child_process');
const executable = process.env.${UA_DSH_NODE_EXECUTABLE_ENV} || process.env.${LODY_DSH_NODE_EXECUTABLE_ENV};
const encodedArgs = process.env.${UA_DSH_NODE_ARGS_ENV} || process.env.${LODY_DSH_NODE_ARGS_ENV};
if (!executable || !encodedArgs) throw new Error('Missing DSH runtime launch environment');
const args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf8'));
const child = spawn(executable, args, { env: process.env, stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code === null ? 1 : code;
});
`.trim();
  return `eval(Buffer.from('${encodeBase64(source)}','base64').toString('utf8'))`;
}

function createDeepSeekHarnessBootstrapSource(): string {
  return `
${HIDE_WINDOWS_CHILD_CONSOLES}
import { readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const expectedVersion = ${JSON.stringify(DEEPSEEK_HARNESS_VERSION)};
let entryPath;

for (const binDir of (process.env.PATH ?? '').split(delimiter)) {
  if (!binDir) continue;
  const packageRoot = join(dirname(binDir), '@deepseek-ai', 'dsh');
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== expectedVersion) continue;
    entryPath = join(packageRoot, 'lib', 'bin.js');
    await readFile(entryPath, 'utf8');
    break;
  } catch {}
}

if (!entryPath) {
  throw new Error(
    'The pinned @deepseek-ai/dsh@' + expectedVersion + ' entry was not found in the npx closure'
  );
}

if (process.platform === 'win32') {
  const familyRoot = dirname(dirname(dirname(await realpath(entryPath))));
  const nativeEntry = pathToFileURL(join(familyRoot, 'dsh-win32-process', 'lib', 'index.js')).href;
  const nativePolicy = [
    'const { loadWin32ProcessBindings } = await import(' + JSON.stringify(nativeEntry) + ');',
    'const api = loadWin32ProcessBindings();',
    'for (const [name, flagsIndex] of [["createProcessW", 5], ["createProcessAsUserW", 6]]) {',
    '  const create = api[name];',
    '  api[name] = (...args) => { args[flagsIndex] |= 0x08000000; return create(...args); };',
    '}',
  ].join('\\n');
  const preload = 'data:text/javascript;base64,' + Buffer.from(nativePolicy).toString('base64');
  await import(preload);
  const runnerEntry = join(familyRoot, 'dsh-subprocess-local', 'lib', 'runner.js');
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    if (options.file === process.execPath && options.args[1] === runnerEntry) {
      options = { ...options, args: [options.args[0], '--import', preload, ...options.args.slice(1)] };
    }
    return spawn.call(this, options);
  };
}

const dshArgs = process.argv.slice(1);
process.argv = [process.execPath, entryPath, ...dshArgs];
const dsh = await import(pathToFileURL(entryPath).href);
if (typeof dsh.runCli !== 'function') {
  throw new Error('The pinned @deepseek-ai/dsh entry does not export runCli()');
}
await dsh.runCli();
`.trim();
}

export class DeepSeekHarnessMixedSessionCompressionError extends Error {
  readonly code = 'DSH_MIXED_SESSION_COMPRESSION';

  constructor(
    readonly sessionsRoot: string,
    readonly rawArtifact: string,
    readonly zstdArtifact: string
  ) {
    super(
      `DeepSeek Harness session root ${JSON.stringify(
        sessionsRoot
      )} contains both raw and Zstandard session artifacts (${JSON.stringify(
        rawArtifact
      )} and ${JSON.stringify(
        zstdArtifact
      )}). All session artifacts were left unchanged. Back up the root and migrate every session to one compression mode, or use a separate DSH_HOME before retrying.`
    );
    this.name = 'DeepSeekHarnessMixedSessionCompressionError';
  }
}

/** Match the official Harness home lookup: $DSH_HOME, then ~/.dsh. */
export function resolveDeepSeekHarnessHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir()
): string {
  const configuredHome = env[DEEPSEEK_HARNESS_HOME_ENV]?.trim();
  if (!configuredHome) return resolve(homeDir, '.dsh');
  if (configuredHome === '~') return resolve(homeDir);
  if (configuredHome.startsWith('~/') || configuredHome.startsWith('~\\')) {
    return resolve(homeDir, configuredHome.slice(2));
  }
  return resolve(configuredHome);
}

export async function resolveDeepSeekHarnessSessionCompression(
  sessionsRoot: string
): Promise<DeepSeekHarnessSessionCompression> {
  let projectEntries;
  try {
    projectEntries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION;
    }
    throw error;
  }

  let rawArtifact: string | undefined;
  let zstdArtifact: string | undefined;
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(sessionsRoot, projectEntry.name);
    const sessionEntries = await readdir(projectPath, { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionPath = join(projectPath, sessionEntry.name);
      const artifactEntries = await readdir(sessionPath, { withFileTypes: true });
      for (const artifactEntry of artifactEntries) {
        if (RAW_SESSION_ARTIFACT.test(artifactEntry.name)) {
          rawArtifact ??= join(sessionPath, artifactEntry.name);
        } else if (ZSTD_SESSION_ARTIFACT.test(artifactEntry.name)) {
          zstdArtifact ??= join(sessionPath, artifactEntry.name);
        }
      }
      if (rawArtifact && zstdArtifact) {
        throw new DeepSeekHarnessMixedSessionCompressionError(
          sessionsRoot,
          rawArtifact,
          zstdArtifact
        );
      }
    }
  }

  return rawArtifact ? 'none' : DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION;
}

async function publishFileAtomically(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function getDeepSeekHarnessProviderHome(dataRoot: string, providerId: string): string {
  return join(dataRoot, 'deepseek-harness', 'providers', providerId);
}

export async function resolveDeepSeekHarnessProcessLaunch(options: {
  adapterPath: string;
  rootDir?: string;
  providerId?: string;
  dataRoot?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const legacyHome = options.rootDir ?? resolveDeepSeekHarnessHome(options.env);
  const defaultDataRoot = join(homedir(), '.universal-agent');
  const rootDir = options.providerId
    ? getDeepSeekHarnessProviderHome(options.dataRoot ?? defaultDataRoot, options.providerId)
    : legacyHome;
  const sessionsRoot = join(legacyHome, 'sessions');
  const presetRoot = join(dirname(options.adapterPath), 'deepseek-agent-presets');
  const sessionCompression = await resolveDeepSeekHarnessSessionCompression(sessionsRoot);
  const profileFiles = createDeepSeekHarnessProfileFiles({
    adapterPath: options.adapterPath,
    presetRoot,
    sessionCompression,
    reasoningEffort: 'max',
  });
  await mkdir(sessionsRoot, { recursive: true });
  const guardPatch = `- id: session-telemetry-otel
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- id: session-log-deepseek
  disabled: true
- id: session-persistence-jsonl
  config:
    root: !!js process.env.${ACP_EXTENSION_DSH_SESSION_ROOT_ENV}
    compression: ${sessionCompression}
- id: session-query-sqlite
  config:
    path: !!js process.env.${ACP_EXTENSION_DSH_QUERY_PATH_ENV}
    openAt: never
- id: acp-agent
  disabled: false
  name: ${JSON.stringify(options.adapterPath.startsWith('file:') ? options.adapterPath : pathToFileURL(options.adapterPath).href)}
`;
  const fingerprint = createHash('sha256')
    .update(profileFiles.cordisPatchYml)
    .update(guardPatch)
    .digest('hex')
    .slice(0, 16);
  const bundleName = `@universal-agent/dsh-host-${fingerprint}`;
  const profileName = DEEPSEEK_HARNESS_PROFILE_NAME;
  const profileDir = join(rootDir, 'profiles', profileName);
  const bundleDir = join(profileDir, 'node_modules', bundleName);
  await mkdir(bundleDir, { recursive: true });
  await Promise.all([
    publishFileAtomically(
      join(bundleDir, 'package.json'),
      JSON.stringify({
        name: bundleName,
        private: true,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }) + '\n'
    ),
    publishFileAtomically(join(bundleDir, 'cordis.patch.yml'), profileFiles.cordisPatchYml),
    publishFileAtomically(join(bundleDir, 'host.patch.yml'), guardPatch),
  ]);
  const manifest = JSON.parse(profileFiles.packageJson);
  manifest.dsh.profile.bundles.push(bundleName);
  await Promise.all([
    publishFileAtomically(
      join(profileDir, 'package.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    ),
    publishFileAtomically(join(profileDir, 'pnpm-workspace.yaml'), profileFiles.pnpmWorkspaceYaml),
    writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', { flag: 'wx', mode: 0o600 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      }
    ),
  ]);

  const dshNodeArgs = [
    '--input-type=module',
    '--eval',
    createDeepSeekHarnessBootstrapSource(),
    '--',
    '--profile',
    profileName,
    '--patch',
    join(bundleDir, 'host.patch.yml'),
    ...(options.extraArgs ?? []),
  ];
  const encodedArgs = encodeBase64(JSON.stringify(dshNodeArgs));

  return {
    command: 'npx',
    args: [
      '--prefer-offline',
      '-y',
      ...createDeepSeekHarnessNpxSpecifiers().flatMap((specifier) => ['--package', specifier]),
      'node',
      '-e',
      createDeepSeekHarnessNodeLauncherArg(),
    ],
    env: {
      [DEEPSEEK_HARNESS_HOME_ENV]: rootDir,
      [ACP_EXTENSION_DSH_SESSION_ROOT_ENV]: sessionsRoot,
      [ACP_EXTENSION_DSH_QUERY_PATH_ENV]: join(sessionsRoot, 'session-query.db'),
      [UA_DSH_NODE_EXECUTABLE_ENV]: process.execPath,
      [UA_DSH_NODE_ARGS_ENV]: encodedArgs,
      [LODY_DSH_NODE_EXECUTABLE_ENV]: process.execPath,
      [LODY_DSH_NODE_ARGS_ENV]: encodedArgs,
    },
  };
}
