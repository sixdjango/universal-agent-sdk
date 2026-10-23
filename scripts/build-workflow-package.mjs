#!/usr/bin/env node
/**
 * Builds a workflow package:
 * 1. Rolldown bundles `src/index.ts` into a single ESM `dist/index.js`.
 * 2. `tsc -p tsconfig.build.json` emits declarations into `dist/`.
 * 3. `fixDeclarationExtensions` makes relative specifiers in those declarations explicit
 *    so consumers using `moduleResolution: NodeNext` resolve the types.
 *
 * Usage (from a package directory):
 *   node ../../scripts/build-workflow-package.mjs [--platform node|neutral] [--entries index,cli]
 * Each entry `<name>` bundles `src/<name>.ts` into `dist/<name>.js`.
 *
 * Every runtime/peer dependency stays external so workspace packages are never inlined
 * into each other; `node:` built-ins are always external.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'rolldown';
import { fixDeclarationExtensions } from './fix-dts-extensions.mjs';

const pkgRoot = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const platformFlag = process.argv.indexOf('--platform');
const platform = platformFlag === -1 ? 'node' : process.argv[platformFlag + 1];
if (platform !== 'node' && platform !== 'neutral') {
  console.error(`Unsupported --platform "${platform}" (expected node or neutral)`);
  process.exit(1);
}

const entriesFlag = process.argv.indexOf('--entries');
const entries = entriesFlag === -1 ? ['index'] : process.argv[entriesFlag + 1].split(',');

const distDir = resolve(pkgRoot, 'dist');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const externalPackages = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const external = [
  /^node:/,
  ...externalPackages.map((name) => new RegExp(`^${escape(name)}(\\/.*)?$`)),
];

for (const entry of entries) {
  await build({
    input: resolve(pkgRoot, `src/${entry}.ts`),
    platform,
    external,
    output: {
      file: resolve(distDir, `${entry}.js`),
      format: 'esm',
      sourcemap: true,
      codeSplitting: false,
    },
  });
  if (!existsSync(resolve(distDir, `${entry}.js`))) {
    console.error(`Build verification failed: ${pkg.name} produced no dist/${entry}.js`);
    process.exit(1);
  }
}
if (existsSync(resolve(distDir, 'chunks'))) {
  console.error(`Build verification failed: ${pkg.name} produced an unexpected chunks/ directory`);
  process.exit(1);
}

const tscBin = createRequire(resolve(pkgRoot, 'package.json')).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tscBin, '-p', resolve(pkgRoot, 'tsconfig.build.json')], {
  cwd: pkgRoot,
  stdio: 'inherit',
});

const rewritten = fixDeclarationExtensions(distDir);

console.log(
  `Built ${pkg.name}: ${entries.map((e) => `dist/${e}.js`).join(', ')} (${platform}) + declarations (${rewritten} rewritten)`
);
