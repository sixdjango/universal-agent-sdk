/**
 * Demo: fork a finished run from its last step. The run scaffolds a module and a binary logo, has
 * an agent implement a function (checked in a loop), and publishes release notes. Fork it from
 * "Publish" after the repository moved on and the workflow changed: the scaffold and the agent's
 * work are taken over (their file changes merged onto the new HEAD, the logo byte for byte), and
 * only "Publish" runs again, with the new definition.
 *
 * Usage: node scripts/fork-demo-flow.mjs [--label <release label>] [server URL]
 *   (default label v1, server http://localhost:4317)
 * Creates a sandbox repository under ~/.universal-agent/workflow/demo/fork-demo, registers the
 * agent and the workspace (git-worktree: every run gets its own worktree at the current HEAD),
 * saves the workflow `test-fork-demo` and binds its slot. Run it again with `--label v2` to change
 * what "Publish" writes before forking.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { label: { type: 'string', default: 'v1' } } });
const server = positionals[0] ?? 'http://localhost:4317';
const repo = join(homedir(), '.universal-agent', 'workflow', 'demo', 'fork-demo');

/** A 1×1 PNG: binary content a text diff cannot carry. */
const LOGO_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const FILES = {
  'src/greet.mjs': 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n',
  'check.mjs': `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const greet = await import(pathToFileURL('src/greet.mjs').href);
assert.equal(greet.greet('Ada'), 'Hello, Ada!');
assert.equal(typeof greet.farewell, 'function', 'src/greet.mjs must export farewell(name)');
assert.equal(greet.farewell('Ada'), 'Goodbye, Ada.');
console.log('check passed');
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

// Files the worktree does not have yet (HEAD holds only the README): a change worth replaying.
const scaffold = script('scaffold', 'Scaffold', `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('src', { recursive: true });
mkdirSync('assets', { recursive: true });
for (const [file, content] of Object.entries(${JSON.stringify(FILES)})) writeFileSync(file, content);
writeFileSync('assets/logo.png', Buffer.from(${JSON.stringify(LOGO_BASE64)}, 'base64'));
`, { writeScopes: ['src', 'assets', 'check.mjs'] });

// Exit code 0 is PASS, anything else NEEDS_FIX (back to the agent).
const check = script('check', 'Check', `
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['check.mjs'], { encoding: 'utf8' });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
`, { producesAssessment: true });

const publish = script('publish', 'Publish', `
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { greet, farewell } = await import(pathToFileURL('src/greet.mjs').href);
const logo = readFileSync('assets/logo.png');
const intact = logo.equals(Buffer.from(${JSON.stringify(LOGO_BASE64)}, 'base64'));
const readme = readFileSync('README.md', 'utf8').trim().split('\\n');
const notes = [
  '# Release ${values.label}',
  '',
  '- ' + greet('Ada') + ' / ' + farewell('Ada'),
  '- assets/logo.png: ' + logo.length + ' bytes, sha256 ' + createHash('sha256').update(logo).digest('hex').slice(0, 12) + (intact ? ' (intact)' : ' (CORRUPTED)'),
  '- README.md, last line: ' + readme[readme.length - 1],
].join('\\n');
writeFileSync('RELEASE.md', notes + '\\n');
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { release: notes } }));
`, { writeScopes: ['RELEASE.md'], outputs: [{ name: 'release', type: 'string', required: true }] });

const AGENT = {
  id: 'fork-demo-dev',
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

const definition = createWorkflowBuilder('test-fork-demo', 'Demo · Fork a run from a step')
  .addWorkflowOutput({ name: 'release', type: 'string', required: true })
  .addWorkspace({ name: 'main', description: 'Sandbox repository; every run works in its own worktree at the current HEAD' })
  .addScript(scaffold)
  .addAgent({
    id: 'implement',
    name: 'Implement farewell()',
    role: 'developer',
    agentRef: `${AGENT.id}@${AGENT.version}`,
    goal: 'Add and export `farewell(name)` from src/greet.mjs, returning `Goodbye, <name>.` (e.g. farewell("Ada") is "Goodbye, Ada."). Change only src/greet.mjs.',
    acceptanceCriteria: ['src/greet.mjs exports farewell', '`node check.mjs` passes'],
    writeScopes: ['src/greet.mjs'],
  })
  .addScript(check)
  .addScript(publish)
  .connectControl('scaffold', 'implement')
  .connectControl('implement', 'check')
  .loopBack('check', 'implement', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 3 })
  .connectControl('check', 'publish')
  .connectData({ fromNodeId: 'publish', fromPort: 'release', toNodeId: '$output', toPort: 'release' })
  .buildDefinition();
definition.description = `Scaffold → agent implements (checked in a loop) → publish release notes (label ${values.label}). Fork a finished run from "Publish": the earlier steps are taken over, their file changes merged onto the current HEAD, and only "Publish" runs again.`;

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

const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=demo@universal-agent.local', '-c', 'user.name=demo', ...args], { stdio: 'ignore' });
if (!existsSync(join(repo, '.git'))) {
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Fork demo sandbox\n\nRuns of test-fork-demo work in worktrees of this repository.\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'Fork demo sandbox');
}

await api('POST', '/api/agents', AGENT);
const { workspaces } = await api('GET', '/api/workspaces');
const workspace = workspaces.find((w) => w.path === repo) ?? (await api('POST', '/api/workspaces', { name: 'fork-demo', path: repo, isolation: 'git-worktree' }));
const exists = (await api('GET', '/api/workflows')).workflows.some((w) => w.id === definition.id);
await api(exists ? 'PUT' : 'POST', exists ? `/api/workflows/${definition.id}` : '/api/workflows', { definition });
await api('PUT', `/api/workflows/${definition.id}/workspace-bindings`, { main: workspace.id });
console.log(`Saved ${definition.id} (release label ${values.label}); sandbox ${repo} (${workspace.id}, ${workspace.isolation})`);
