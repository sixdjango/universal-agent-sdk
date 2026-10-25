/**
 * Demo: two agents edit one workspace at the same time. One renames `add` to `sum`, the other
 * writes a module that calls `add`. Their edits merge line by line, but not together: whichever
 * lands second fails the workspace's merge check and is done again on top of the other's work.
 *
 * Usage: node scripts/merge-demo-flow.mjs [server URL]   (default http://localhost:4317)
 * Creates a sandbox repository under ~/.universal-agent/workflow/demo/merge-demo, registers the
 * agent and the workspace, saves the workflow `test-merge-demo` and binds its slot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';

const server = process.argv[2] ?? 'http://localhost:4317';
const repo = join(homedir(), '.universal-agent', 'workflow', 'demo', 'merge-demo');

const FILES = {
  'src/math.mjs': 'export function add(a, b) {\n  return a + b;\n}\n',
  'src/report.mjs': "import { add } from './math.mjs';\n\nexport const report = (xs) => `total: ${xs.reduce((t, x) => add(t, x), 0)}`;\n",
  'check.mjs': `// Loads every module in src (an import of a missing export fails here), then checks behaviour.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const load = (file) => import(pathToFileURL(file).href);
for (const file of readdirSync('src')) await load('src/' + file);
const { report } = await load('src/report.mjs');
assert.equal(report([1, 2, 3]), 'total: 6');
if (existsSync('src/stats.mjs')) {
  const { mean } = await load('src/stats.mjs');
  assert.equal(mean([1, 2, 3, 6]), 3);
}
console.log('check passed:', readdirSync('src').join(', '));
`,
};

const script = (id, name, source, extra) => ({
  id,
  name,
  command: process.execPath,
  args: ['--input-type=module', '-e', source],
  writeScopes: [],
  producesAssessment: false,
  ...extra,
});

/** Marks the sandbox; resetting refuses to touch any other workspace. */
const MARKER = '.merge-demo';

// Puts the sandbox back to its starting point, so the workflow can run again and again.
const seed = script('seed', 'Reset sandbox', `
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(MARKER)})) throw new Error('This workspace is not the merge demo sandbox (no ${MARKER} file); bind the "merge-demo" workspace. Nothing was changed.');
rmSync('src', { recursive: true, force: true });
mkdirSync('src');
for (const [file, content] of Object.entries(${JSON.stringify(FILES)})) writeFileSync(file, content);
`, { writeScopes: ['src', 'check.mjs'] });

const verify = script('verify', 'Verify', `
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const checked = spawnSync(process.execPath, ['check.mjs'], { encoding: 'utf8' });
const math = readFileSync('src/math.mjs', 'utf8');
const stats = (() => { try { return readFileSync('src/stats.mjs', 'utf8'); } catch { return ''; } })();
const problems = [
  checked.status !== 0 && 'check.mjs failed: ' + (checked.stderr || checked.stdout).trim().split('\\n').slice(-3).join(' '),
  !/export function sum\\b/.test(math) && 'src/math.mjs does not export sum',
  /\\badd\\b/.test(math) && 'src/math.mjs still mentions add',
  !stats && 'src/stats.mjs is missing',
  stats && !/\\bsum\\b/.test(stats) && 'src/stats.mjs does not use sum',
].filter(Boolean);
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({
  outputs: {},
  assessment: problems.length
    ? { verdict: 'FAIL', summary: problems.join('; ') }
    : { verdict: 'PASS', summary: 'Rename and the new module both landed, and work together: ' + checked.stdout.trim() },
}));
`, { producesAssessment: true });

const AGENT = {
  id: 'merge-demo-dev',
  version: '1',
  name: 'Demo developer',
  charter: 'Makes small, careful code changes in the repository it works in.',
  instructions: [
    'Do not delegate to another agent.',
    'Work only in the current directory. Keep changes minimal.',
    'Before finishing, run `node check.mjs` and make sure it passes.',
  ],
  skills: [],
  runtime: { adapter: 'acp', agentType: 'deepseek' },
};
const agentRef = `${AGENT.id}@${AGENT.version}`;

const definition = createWorkflowBuilder('test-merge-demo', 'Demo · Concurrent edits in one workspace')
  .addWorkspace({
    name: 'main',
    description: 'Sandbox repository both agents edit at the same time',
    mergeCheck: { command: process.execPath, args: ['check.mjs'], timeoutMs: 60_000 },
  })
  .addScript(seed)
  .addAgent({
    id: 'rename',
    name: 'Rename add → sum',
    role: 'developer',
    agentRef,
    goal: 'Rename the function `add` exported from src/math.mjs to `sum`, and update every file under src/ that uses it. Do not create new files.',
    acceptanceCriteria: ['src/math.mjs exports sum and no longer mentions add', 'every caller under src/ uses sum', '`node check.mjs` passes'],
    writeScopes: ['src/math.mjs', 'src/report.mjs'],
  })
  .addAgent({
    id: 'stats',
    name: 'Add mean()',
    role: 'developer',
    agentRef,
    goal: 'Create src/stats.mjs exporting `mean(xs)`, the average of an array of numbers. Compute the total with the addition function src/math.mjs exports (import it; do not write your own addition). Only create src/stats.mjs.',
    acceptanceCriteria: ['src/stats.mjs exports mean', 'it adds up values with the function from src/math.mjs', '`node check.mjs` passes'],
    writeScopes: ['src/stats.mjs'],
  })
  .addScript(verify)
  .connectControl('seed', 'rename')
  .connectControl('seed', 'stats')
  .connectControl('rename', 'verify')
  .connectControl('stats', 'verify')
  // The default chief (on the agents' engine) steps in when a step still clashes after its redo.
  .setChief({})
  .buildDefinition();
definition.description =
  'Two agents edit one repository at the same time, each in its own copy. Their edits merge line by line but break together; the workspace merge check catches whichever lands second, and that step is done again on top of the other.';

async function api(method, path, body) {
  const response = await fetch(server + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
if (!existsSync(join(repo, '.git'))) {
  mkdirSync(repo, { recursive: true });
  for (const [file, content] of Object.entries(FILES)) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  git('init', '-q', '-b', 'main');
}
if (!existsSync(join(repo, MARKER))) {
  writeFileSync(join(repo, MARKER), 'Sandbox for the test-merge-demo workflow; its first step resets src/ and check.mjs.\n');
  git('add', '.');
  git('-c', 'user.email=demo@universal-agent.local', '-c', 'user.name=demo', 'commit', '-qm', 'Merge demo sandbox');
}

await api('POST', '/api/agents', AGENT);
const { workspaces } = await api('GET', '/api/workspaces');
const workspace = workspaces.find((w) => w.path === repo) ?? (await api('POST', '/api/workspaces', { name: 'merge-demo', path: repo }));
const exists = (await api('GET', '/api/workflows')).workflows.some((w) => w.id === definition.id);
await api(exists ? 'PUT' : 'POST', exists ? `/api/workflows/${definition.id}` : '/api/workflows', { definition });
await api('PUT', `/api/workflows/${definition.id}/workspace-bindings`, { main: workspace.id });
const saved = await api('GET', `/api/workflows/${definition.id}`);
console.log(`Saved ${definition.id}; sandbox ${repo} (${workspace.id})`);
console.log('mergeCheck kept:', JSON.stringify(saved.definition?.workspaces?.[0]?.mergeCheck ?? null));
