import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const preparePublish = args.includes('--prepare-publish');
const versionArg = args.find((arg) => !arg.startsWith('--'));

const rawInput =
  versionArg?.trim() ||
  process.env.RELEASE_VERSION?.trim() ||
  (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME?.trim() : '');

const packageJsonPaths = [
  resolve(repoRoot, 'package.json'),
  resolve(repoRoot, 'packages/acp-extension-core/package.json'),
  resolve(repoRoot, 'packages/agent-client/package.json'),
  resolve(repoRoot, 'packages/workflow-contract/package.json'),
  resolve(repoRoot, 'packages/workflow-runtime/package.json'),
  resolve(repoRoot, 'packages/workflow-node/package.json'),
  resolve(repoRoot, 'packages/workflow-agents/package.json'),
  resolve(repoRoot, 'packages/workflow-ui/package.json'),
  resolve(repoRoot, 'packages/workflow-web/package.json'),
  resolve(repoRoot, 'packages/workflow-server/package.json'),
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

  if (preparePublish) {
    if (pkg.dependencies) {
      for (const [dep, spec] of Object.entries(pkg.dependencies)) {
        if (typeof spec === 'string' && spec.startsWith('workspace:')) {
          pkg.dependencies[dep] = normalizedVersion;
        }
      }
    }
    if (pkg.devDependencies) {
      for (const [dep, spec] of Object.entries(pkg.devDependencies)) {
        if (typeof spec === 'string' && spec.startsWith('workspace:')) {
          delete pkg.devDependencies[dep];
        }
      }
    }
  }

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(
    `Synced ${pkg.name} -> ${normalizedVersion}${preparePublish ? ' (publish-ready)' : ''}`
  );
}
