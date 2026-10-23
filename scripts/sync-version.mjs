import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const rawInput =
  process.argv[2]?.trim() ||
  process.env.RELEASE_VERSION?.trim() ||
  (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME?.trim() : '');

const packageJsonPaths = [
  resolve(repoRoot, 'package.json'),
  resolve(repoRoot, 'packages/acp-extension-core/package.json'),
  resolve(repoRoot, 'packages/agent-client/package.json'),
];

const rootPkg = JSON.parse(readFileSync(packageJsonPaths[0], 'utf8'));
const normalizedVersion = rawInput ? rawInput.replace(/^v/i, '') : rootPkg.version;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
  console.error(`Invalid semver version: "${normalizedVersion}"`);
  process.exit(1);
}

for (const pkgPath of packageJsonPaths) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = normalizedVersion;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`Synced ${pkg.name} -> ${normalizedVersion}`);
}
