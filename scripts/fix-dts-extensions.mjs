#!/usr/bin/env node
/**
 * `tsc` keeps relative specifiers in emitted declarations bare (`./ports`), which consumers
 * using `moduleResolution: NodeNext` cannot resolve, so they silently lose the types.
 * This rewrites them to the explicit `./ports.js` / `./dir/index.js` form, based on the
 * declaration files that actually exist.
 *
 * CLI: node scripts/fix-dts-extensions.mjs <distDir>
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function* walkDeclarations(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkDeclarations(full);
    else if (full.endsWith('.d.ts')) yield full;
  }
}

const RELATIVE_SPECIFIER = /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

/** Returns how many declaration files were rewritten. */
export function fixDeclarationExtensions(distDir) {
  let rewritten = 0;
  for (const file of walkDeclarations(distDir)) {
    const source = readFileSync(file, 'utf8');
    const next = source.replace(RELATIVE_SPECIFIER, (match, prefix, quote, specifier) => {
      if (/\.(js|mjs|cjs|json)$/.test(specifier)) return match;
      const target = resolve(dirname(file), specifier);
      if (existsSync(`${target}.d.ts`)) return `${prefix}${quote}${specifier}.js${quote}`;
      if (existsSync(join(target, 'index.d.ts'))) return `${prefix}${quote}${specifier}/index.js${quote}`;
      throw new Error(`Cannot resolve declaration import "${specifier}" in ${file}`);
    });
    if (next !== source) {
      writeFileSync(file, next);
      rewritten += 1;
    }
  }
  return rewritten;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = process.argv[2];
  if (!distDir) {
    console.error('Usage: node scripts/fix-dts-extensions.mjs <distDir>');
    process.exit(1);
  }
  const rewritten = fixDeclarationExtensions(resolve(distDir));
  console.log(`Rewrote relative specifiers in ${rewritten} declaration file(s) under ${distDir}`);
}
