#!/usr/bin/env node
/**
 * Publishes the @universal-agent/* packages to npm in dependency order.
 *
 *   node scripts/publish-packages.mjs [--dry-run] [--tag <dist-tag>] [--provenance] [--otp <code>]
 *   node scripts/publish-packages.mjs --pack <dir>   # tarballs to install and try before publishing
 *
 * - Versions already on npm are skipped, so a failed release can simply be run again.
 * - Each package is published with its `workspace:*` dependencies pinned to the release
 *   version (and workspace-only devDependencies dropped); its package.json is restored
 *   afterwards, even when publishing fails.
 * - Build first (`pnpm build`); a package without its build output is refused.
 * - Locally this needs `npm login`; in CI it runs with npm's OIDC trusted publishing
 *   (`--provenance`, see docs/releasing.md).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every published package, each after the packages it depends on. */
export const PACKAGES = [
  { dir: 'packages/acp-extension-core', built: 'dist/index.js' },
  { dir: 'packages/agent-client', built: 'dist/index.js' },
  { dir: 'packages/workflow-contract', built: 'dist/index.js' },
  { dir: 'packages/workflow-runtime', built: 'dist/index.js' },
  { dir: 'packages/workflow-node', built: 'dist/index.js' },
  { dir: 'packages/workflow-agents', built: 'dist/index.js' },
  { dir: 'packages/workflow-ui', built: 'dist/index.js' },
  { dir: 'packages/workflow-web', built: 'dist/index.html' },
  { dir: 'packages/workflow-server', built: 'dist/cli.js' },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const provenance = args.includes('--provenance') || args.includes('--provenance=true');
const tagAt = args.indexOf('--tag');
const tag = tagAt >= 0 ? args[tagAt + 1] : 'latest';
const otpAt = args.indexOf('--otp');
/** One-time password for accounts with 2FA on writes; a rerun with a fresh code continues where it stopped. */
const otp = otpAt >= 0 ? args[otpAt + 1] : undefined;
const packAt = args.indexOf('--pack');
const packDir = packAt >= 0 ? resolve(process.cwd(), args[packAt + 1] ?? '.') : undefined;

/** The manifest npm should see: workspace dependencies pinned to the release version. */
function publishManifest(pkg) {
  const next = structuredClone(pkg);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(next[field] ?? {})) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) next[field][name] = pkg.version;
    }
  }
  for (const [name, spec] of Object.entries(next.devDependencies ?? {})) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) delete next.devDependencies[name];
  }
  return next;
}

function published(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === version;
}

if (packDir) mkdirSync(packDir, { recursive: true });
const results = [];
/** Puts back the package.json being published when the run is interrupted. */
let restoreCurrent = () => {};
process.on('SIGINT', () => {
  restoreCurrent();
  process.exit(130);
});
for (const { dir, built } of PACKAGES) {
  const manifestPath = join(root, dir, 'package.json');
  const original = readFileSync(manifestPath, 'utf8');
  const pkg = JSON.parse(original);
  const id = `${pkg.name}@${pkg.version}`;
  if (!packDir && published(pkg.name, pkg.version)) {
    console.log(`- ${id}: already on npm, skipped`);
    results.push([id, 'skipped']);
    continue;
  }
  if (!existsSync(join(root, dir, built))) {
    console.error(`✗ ${id}: ${built} is missing; run \`pnpm build\` first`);
    process.exit(1);
  }
  const restore = () => writeFileSync(manifestPath, original);
  restoreCurrent = restore;
  try {
    writeFileSync(manifestPath, `${JSON.stringify(publishManifest(pkg), null, 2)}\n`);
    const npmArgs = packDir
      ? ['pack', '--pack-destination', packDir]
      : ['publish', '--access', 'public', '--tag', tag, ...(provenance ? ['--provenance'] : []), ...(dryRun ? ['--dry-run'] : []), ...(otp ? [`--otp=${otp}`] : [])];
    console.log(`→ ${id}: npm ${npmArgs.map((a) => (a.startsWith('--otp=') ? '--otp=******' : a)).join(' ')}`);
    execFileSync('npm', npmArgs, { cwd: join(root, dir), stdio: 'inherit' });
    results.push([id, packDir ? 'packed' : dryRun ? 'dry run' : 'published']);
  } catch (err) {
    console.error(`✗ ${id}: publish failed (${err instanceof Error ? err.message : String(err)})`);
    restore();
    process.exit(1);
  } finally {
    restore();
    restoreCurrent = () => {};
  }
}

console.log('\nSummary');
for (const [id, outcome] of results) console.log(`  ${outcome.padEnd(10)} ${id}`);
