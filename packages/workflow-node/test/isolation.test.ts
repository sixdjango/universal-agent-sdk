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
      .addParallel({
        id: 'each',
        name: 'Each',
        maxConcurrency: 4,
        itemBody: (b) =>
          b
            .addScript({
              id: 'write',
              name: 'Write',
              command: 'node',
              args: js(`const item = fs.readFileSync(process.env.UA_INPUT_ITEM, 'utf8'); fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/' + item + '.txt', item)`, 400),
              writeScopes: ['out'],
              inputs: [{ name: 'item', type: 'json', required: true }],
              producesAssessment: false,
            })
            .connectData({ fromNodeId: '$input', fromPort: 'item', toNodeId: 'write', toPort: 'item' }),
      })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'each', toPort: 'items' })
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

  it('fails the step whose changes no longer apply, keeping them on a branch', async () => {
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
      .addScript(edit('first', 'first wins', 50))
      // Declares a different scope (so the two run together) but edits the same file anyway.
      .addScript({ ...edit('second', 'second loses', 400), writeScopes: ['other'] })
      .buildDefinition();
    const done = await run(definition);
    expect(done.status).toBe('FAILED');
    expect(done.scopes.$root!.nodes.first!.status).toBe('SUCCEEDED');
    const second = done.scopes.$root!.nodes.second!;
    expect(second.status).toBe('FAILED');
    expect(second.error).toContain('shared.txt');
    const branch = /branch (\S+)/.exec(second.error!)![1]!;
    expect(git(repo, 'show', `${branch}:shared.txt`)).toContain('second loses');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toContain('first wins');
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
