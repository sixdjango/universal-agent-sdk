#!/usr/bin/env node
/**
 * After `vite build` and `tsc`: inlines the `@import`s of `src/styles/index.css` into one
 * `dist/styles.css`, and makes relative specifiers in the emitted declarations explicit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixDeclarationExtensions } from '../../../scripts/fix-dts-extensions.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));

function inline(file) {
  return readFileSync(file, 'utf8').replace(/^@import\s+'([^']+)';\s*$/gm, (_, spec) => {
    const target = spec.startsWith('.') ? resolve(dirname(file), spec) : require.resolve(spec);
    return inline(target);
  });
}

writeFileSync(resolve(root, 'dist/styles.css'), inline(resolve(root, 'src/styles/index.css')));
const rewritten = fixDeclarationExtensions(resolve(root, 'dist'));
console.log(`Built @universal-agent/workflow-ui: dist/index.js, dist/styles.css + declarations (${rewritten} rewritten)`);
