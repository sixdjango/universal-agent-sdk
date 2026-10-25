import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeWorkflowRuntime } from '../src/index';

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

/** A node one-liner that waits a little, then runs `body` (so concurrent steps overlap). */
const js = (body: string, delayMs = 150) => ['-e', `setTimeout(() => { const fs = require('node:fs'); ${body} }, ${delayMs})`];

describe('concurrent writers work in their own copies', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ua-iso-repo-')));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ua-iso-home-')));
    dirs.push(repo, home);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'shared.txt'), 'line 1\nline 2\nline 3\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    // Ignored dependencies and an uncommitted edit must both be visible to the copies.
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.txt'), 'dependency');
    writeFileSync(join(repo, 'draft.txt'), 'uncommitted\n');
    const runtime = createNodeWorkflowRuntime({ workdir: repo, homeDir: home });
    const run = async (definition: WorkflowDefinition, inputs: Record<string, unknown> = {}) =>
      runtime.runUntilSettled((await runtime.start({ definition, inputs, workspaces: { main: repo } })).runId);
    return { repo, home, run };
  }

  it('runs sibling writers side by side, records only their own changes, and merges both', async () => {
    const { repo, run } = setup();
    const definition = createWorkflowBuilder('siblings')
      .addScript({
        id: 'ui',
        name: 'UI',
        command: 'node',
        args: js(`fs.mkdirSync('ui'); fs.writeFileSync('ui/a.txt', fs.readFileSync('node_modules/dep/index.txt', 'utf8') + ' + ' + fs.readFileSync('draft.txt', 'utf8'))`),
        writeScopes: ['ui'],
        producesAssessment: false,
      })
      .addScript({
        id: 'api',
        name: 'API',
        command: 'node',
        args: js(`fs.mkdirSync('api'); fs.writeFileSync('api/b.txt', 'api'); fs.writeFileSync('shared.txt', 'line 1\\nline 2 (api)\\nline 3\\n')`),
        writeScopes: ['api', 'shared.txt'],
        producesAssessment: false,
      })
      .addScript({ id: 'after', name: 'After', command: 'node', args: js(`fs.writeFileSync('both.txt', String(fs.existsSync('ui/a.txt') && fs.existsSync('api/b.txt')))`, 0), writeScopes: ['both.txt'], producesAssessment: false })
      .connectControl('ui', 'after')
      .connectControl('api', 'after')
      .buildDefinition();
    const started = Date.now();
    const done = await run(definition);
    expect(done.status).toBe('SUCCEEDED');
    const changes = (id: string) => done.attempts[done.scopes.$root!.nodes[id]!.latestAttemptId!]!.changes;
    expect(changes('ui')).toMatchObject({ isolated: true, files: [{ path: 'ui/a.txt', status: 'A' }] });
    expect(changes('api')).toMatchObject({ isolated: true, files: [{ path: 'api/b.txt', status: 'A' }, { path: 'shared.txt', status: 'M' }] });
    expect(changes('after')).toMatchObject({ files: [{ path: 'both.txt', status: 'A' }] });
    expect(changes('after')!.isolated).toBeUndefined();

    expect(readFileSync(join(repo, 'ui/a.txt'), 'utf8')).toBe('dependency + uncommitted\n');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toContain('line 2 (api)');
    expect(readFileSync(join(repo, 'both.txt'), 'utf8')).toBe('true');
    // Nothing staged, no worktrees or links left behind, and the steps really overlapped.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives each parallel item its own copy instead of queueing them on one write lock', async () => {
    const { repo, run } = setup();
    const definition = createWorkflowBuilder('items')
      .addWorkflowInput({ name: 'items', type: 'array', required: true })
      .addScript({
        id: 'write', name: 'Write', command: 'node',
        parallel: { itemsPort: 'item', maxConcurrency: 4, failurePolicy: 'settle_all' },
        args: js(`const item = fs.readFileSync(process.env.UA_INPUT_ITEM, 'utf8'); fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/' + item + '.txt', item)`, 400),
        writeScopes: ['out'], inputs: [{ name: 'item', type: 'json', required: true }], producesAssessment: false,
      })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'write', toPort: 'item' })
      .buildDefinition();
    const started = Date.now();
    const done = await run(definition, { items: ['a', 'b', 'c', 'd'] });
    const elapsed = Date.now() - started;
    expect(done.status).toBe('SUCCEEDED');
    for (const item of ['a', 'b', 'c', 'd']) expect(readFileSync(join(repo, 'out', `${item}.txt`), 'utf8')).toBe(item);
    const itemChanges = Object.values(done.attempts)
      .filter((a) => a.nodeId === 'write')
      .map((a) => a.changes!.files.map((f) => f.path));
    expect(itemChanges.sort()).toEqual([['out/a.txt'], ['out/b.txt'], ['out/c.txt'], ['out/d.txt']]);
    // Serialized on one lock this would take 4 x 400 ms.
    expect(elapsed).toBeLessThan(1_400);
  });

  it('does a step whose changes clash again on the workspace as it is now', async () => {
    const { repo, run } = setup();
    const edit = (id: string, text: string, delayMs: number) => ({
      id,
      name: id,
      command: 'node',
      args: js(`fs.writeFileSync('shared.txt', 'line 1\\n${text}\\nline 3\\n')`, delayMs),
      writeScopes: ['shared.txt'],
      isolation: 'worktree' as const,
      producesAssessment: false,
    });
    const definition = createWorkflowBuilder('clash')
      .addScript(edit('first', 'first', 50))
      // Declares a different scope (so the two run together) but edits the same line anyway.
      .addScript({ ...edit('second', 'second', 400), writeScopes: ['other'] })
      .buildDefinition();
    const done = await run(definition);
    expect(done.status).toBe('SUCCEEDED');
    // Done again on top of the first step's change, the second step's edit lands last.
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('line 1\nsecond\nline 3\n');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('fails a step that clashes again when done again, keeping its changes on a branch', async () => {
    const { repo, run } = setup();
    const step = (id: string, body: string, delayMs: number) => ({
      id,
      name: id,
      command: 'node',
      args: js(body, delayMs),
      writeScopes: [id],
      isolation: 'worktree' as const,
      producesAssessment: false,
    });
    const replace = (from: string, to: string) => `fs.writeFileSync('shared.txt', fs.readFileSync('shared.txt', 'utf8').replace('${from}', '${to}'))`;
    const definition = createWorkflowBuilder('clash-again')
      .addScript(step('first', replace('line 1', 'line 1 (first)'), 50))
      // Clashes with "first" on line 1; done again, it takes long enough for "third" to change
      // line 3 meanwhile, and clashes with that.
      .addScript(
        step(
          'second',
          `const redo = fs.readFileSync('shared.txt', 'utf8').includes('(first)'); setTimeout(() => fs.writeFileSync('shared.txt', 'line 1 (second)\\nline 2\\nline 3 (second)\\n'), redo ? 800 : 0)`,
          300
        )
      )
      .addScript(step('third', replace('line 3', 'line 3 (third)'), 700))
      .buildDefinition();
    const done = await run(definition);
    expect(done.status).toBe('FAILED');
    expect(done.scopes.$root!.nodes.first!.status).toBe('SUCCEEDED');
    expect(done.scopes.$root!.nodes.third!.status).toBe('SUCCEEDED');
    const second = done.scopes.$root!.nodes.second!;
    expect(second.status).toBe('FAILED');
    expect(second.error).toContain('shared.txt');
    const branch = /branch (\S+)/.exec(second.error!)![1]!;
    expect(git(repo, 'show', `${branch}:shared.txt`)).toContain('line 3 (second)');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('line 1 (first)\nline 2\nline 3 (third)\n');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('checks merged code before it lands, and does a step again when edits break each other', async () => {
    const { repo, run } = setup();
    writeFileSync(join(repo, 'lib.txt'), 'foo');
    // "use.txt" must call what "lib.txt" defines: a clean line merge can still break that.
    const check = `const fs = require('node:fs'); if (fs.existsSync('use.txt') && fs.readFileSync('use.txt', 'utf8') !== fs.readFileSync('lib.txt', 'utf8')) { console.error('use.txt calls ' + fs.readFileSync('use.txt', 'utf8') + ', which lib.txt does not define'); process.exit(1); }`;
    const definition = createWorkflowBuilder('semantic')
      .addWorkspace({ name: 'main', mergeCheck: { command: 'node', args: ['-e', check] } })
      .addScript({
        id: 'rename', name: 'Rename', command: 'node', args: js(`fs.writeFileSync('lib.txt', 'bar')`, 50),
        writeScopes: ['lib.txt'], producesAssessment: false,
      })
      .addScript({
        id: 'use', name: 'Use', command: 'node', args: js(`fs.writeFileSync('use.txt', fs.readFileSync('lib.txt', 'utf8'))`, 400),
        writeScopes: ['use.txt'], producesAssessment: false,
      })
      .buildDefinition();
    const done = await run(definition);
    expect(done.status).toBe('SUCCEEDED');
    // Without the check "use.txt" would land calling "foo"; done again it sees the rename.
    expect(readFileSync(join(repo, 'use.txt'), 'utf8')).toBe('bar');
    expect(readFileSync(join(repo, 'lib.txt'), 'utf8')).toBe('bar');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('merges edits to different lines of one file three ways', async () => {
    const { repo, run } = setup();
    // Neighbouring lines: each step's patch context covers the other's edit.
    const edit = (id: string, from: string, to: string, delayMs: number) => ({
      id,
      name: id,
      command: 'node',
      args: js(`fs.writeFileSync('shared.txt', fs.readFileSync('shared.txt', 'utf8').replace('${from}', '${to}'))`, delayMs),
      writeScopes: [id],
      isolation: 'worktree' as const,
      producesAssessment: false,
    });
    const definition = createWorkflowBuilder('neighbours')
      .addScript(edit('top', 'line 1', 'line 1 (top)', 50))
      .addScript(edit('bottom', 'line 3', 'line 3 (bottom)', 400))
      .buildDefinition();
    const done = await run(definition);
    expect(done.status).toBe('SUCCEEDED');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('line 1 (top)\nline 2\nline 3 (bottom)\n');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it.runIf(process.platform === 'darwin')('clones ignored build output instead of linking it, so building in a copy leaves the original alone', async () => {
    const { repo, run } = setup();
    const definition = createWorkflowBuilder('build')
      .addScript({
        id: 'build',
        name: 'Build',
        command: 'node',
        args: js(`fs.writeFileSync('node_modules/dep/index.txt', 'rebuilt'); fs.writeFileSync('out.txt', 'built')`, 0),
        writeScopes: ['out.txt'],
        isolation: 'worktree',
        producesAssessment: false,
      })
      .buildDefinition();
    const done = await run(definition);
    expect(done.status).toBe('SUCCEEDED');
    expect(readFileSync(join(repo, 'out.txt'), 'utf8')).toBe('built');
    expect(readFileSync(join(repo, 'node_modules', 'dep', 'index.txt'), 'utf8')).toBe('dependency');
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('reports writes outside the write scopes, and drops them when scopes are enforced', async () => {
    const { repo, run } = setup();
    const sneaky = (id: string, file: string, enforceWriteScopes: boolean) => ({
      id,
      name: id,
      command: 'node',
      args: js(`fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/${id}.txt', 'ok'); fs.writeFileSync('${file}', 'sneaky')`, 0),
      writeScopes: ['src'],
      isolation: 'worktree' as const,
      enforceWriteScopes,
      producesAssessment: false,
    });
    const done = await run(
      createWorkflowBuilder('scopes').addScript(sneaky('lax', 'lax.txt', false)).addScript(sneaky('strict', 'strict.txt', true)).buildDefinition()
    );
    const lax = done.attempts[done.scopes.$root!.nodes.lax!.latestAttemptId!]!;
    expect(lax.changes?.outOfScope).toEqual(['lax.txt']);
    expect(existsSync(join(repo, 'lax.txt'))).toBe(true);

    const strict = done.scopes.$root!.nodes.strict!;
    expect(strict.status).toBe('FAILED');
    expect(strict.error).toBe('Step "strict" changed files outside its write scopes: strict.txt');
    expect(existsSync(join(repo, 'strict.txt'))).toBe(false);
    expect(existsSync(join(repo, 'src/strict.txt'))).toBe(false);
  });
});
