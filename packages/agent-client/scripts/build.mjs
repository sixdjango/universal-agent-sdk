import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const distDir = resolve(pkgRoot, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const entryPoints = {
  index: resolve(pkgRoot, 'src/index.ts'),
  'claude-acp': resolve(pkgRoot, 'src/entries/claude-acp-entry.ts'),
  'codex-acp': resolve(pkgRoot, 'src/entries/codex-acp-entry.ts'),
  'kimi-acp': resolve(pkgRoot, 'src/entries/kimi-acp-entry.ts'),
  'deepseek-acp': resolve(pkgRoot, 'src/entries/deepseek-acp-entry.ts'),
  'grok-acp': resolve(pkgRoot, 'src/entries/grok-acp-entry.ts'),
  'devin-acp': resolve(pkgRoot, 'src/entries/devin-acp-entry.ts'),
  'pi-acp': resolve(pkgRoot, 'src/entries/pi-acp-entry.ts'),
};

const externalPackages = [
  '@agentclientprotocol/sdk',
  '@anthropic-ai/claude-agent-sdk',
  '@earendil-works/pi-coding-agent',
  '@modelcontextprotocol/sdk',
  '@openai/codex',
  'cross-spawn',
  'diff',
  'open',
  'vscode-jsonrpc',
  'zod',
  'fsevents',
];

const external = externalPackages.map(
  (pkg) => new RegExp(`^${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\/.*)?$`),
);

await Promise.all(
  Object.entries(entryPoints).map(([entryKey, inputPath]) =>
    build({
      input: inputPath,
      platform: 'node',
      external,
      output: {
        file: resolve(distDir, `${entryKey}.js`),
        format: 'esm',
        sourcemap: true,
        codeSplitting: false,
      },
    }),
  ),
);

// Copy DeepSeek Harness agent presets into dist/deepseek-agent-presets
const dshPresetsSrc = resolve(pkgRoot, '../adapters/acp-extension-dsh/presets');
const dshPresetsDest = resolve(distDir, 'deepseek-agent-presets');
if (existsSync(dshPresetsSrc)) {
  cpSync(dshPresetsSrc, dshPresetsDest, { recursive: true });
}

// Copy Pi ACP extension into dist/extension.js so pi-acp.js can resolve it locally
const piExtensionSrc = resolve(pkgRoot, '../adapters/acp-extension-pi/dist/extension.js');
const piExtensionDest = resolve(distDir, 'extension.js');
if (existsSync(piExtensionSrc)) {
  cpSync(piExtensionSrc, piExtensionDest);
}

// Post-build verification: ensure all flat adapter entry files exist in dist/ root
for (const entryKey of Object.keys(entryPoints)) {
  const expectedPath = resolve(distDir, `${entryKey}.js`);
  if (!existsSync(expectedPath)) {
    console.error(`Build verification failed: missing expected output ${expectedPath}`);
    process.exit(1);
  }
}

if (existsSync(resolve(distDir, 'chunks'))) {
  console.error('Build verification failed: unexpected chunks/ directory in dist/');
  process.exit(1);
}

console.log('Build completed successfully with flat adapter entries.');
