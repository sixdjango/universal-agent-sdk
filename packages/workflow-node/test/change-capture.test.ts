import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffSinceSnapshot, diffTrees, snapshotWorkingTree } from '../src/workspace/change-capture';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const commit = (dir: string) => git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
// Fix the timestamps instead of racing the wall clock. Ignoring ctime models a
// same-stat rewrite on a coarse filesystem while keeping Git's real racy check.
const RACY_TIME = 1_700_000_000;

describe('working tree snapshots', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repository() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ua-snapshot-')));
    dirs.push(home);
    const repo = join(home, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'core.fsmonitor', 'false');
    return { home, repo };
  }

  it.each([
    { kind: 'repository', timestamp: RACY_TIME },
    { kind: 'repository with fractional timestamps', timestamp: RACY_TIME + 0.123456 },
    { kind: 'linked worktree', timestamp: RACY_TIME },
  ])('detects equal-size, equal-mtime edits in a $kind without changing its index', async ({ kind, timestamp }) => {
    const initial = repository();
    git(initial.repo, 'config', 'core.trustctime', 'false');
    writeFileSync(join(initial.repo, 'a.txt'), 'old\n');
    git(initial.repo, 'add', '.');
    commit(initial.repo);
    let repo = initial.repo;
    if (kind === 'linked worktree') {
      repo = join(initial.home, 'linked');
      git(initial.repo, 'worktree', 'add', '-q', '--detach', repo, 'HEAD');
    }
    const file = join(repo, 'a.txt');
    const index = resolve(repo, git(repo, 'rev-parse', '--git-path', 'index').trim());
    utimesSync(file, timestamp, timestamp);
    git(repo, 'add', 'a.txt');
    // In real use these timestamps coincide when a file is staged then edited
    // quickly. Moving only the copied index forward loses Git's content check.
    utimesSync(index, timestamp, timestamp);
    const indexBytes = readFileSync(index);
    const indexMtime = statSync(index, { bigint: true }).mtimeNs;
    const before = await snapshotWorkingTree(repo);
    expect(before).not.toBeNull();
    expect(git(repo, 'show', `${before!.tree}:a.txt`)).toBe('old\n');

    writeFileSync(file, 'new\n');
    utimesSync(file, timestamp, timestamp);
    // The untouched real index knows this is racy and detects the new content.
    expect(git(repo, 'diff-files', '--name-only')).toBe('a.txt\n');
    const [first, second] = await Promise.all([diffSinceSnapshot(before!), diffSinceSnapshot(before!)]);
    expect(first?.files).toEqual([{ path: 'a.txt', status: 'M' }]);
    expect(first?.diff).toContain('-old\n+new');
    expect(second).toEqual(first);
    expect(readFileSync(index)).toEqual(indexBytes);
    expect(statSync(index, { bigint: true }).mtimeNs).toBe(indexMtime);
  });

  it('preserves staged work, dirty baselines, ignored tracked files and explicit exclusions', async () => {
    const { repo } = repository();
    writeFileSync(join(repo, '.gitignore'), '*.log\ngenerated/\n');
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
    writeFileSync(join(repo, 'gone.txt'), 'gone\n');
    writeFileSync(join(repo, 'kept.log'), 'tracked despite ignore\n');
    git(repo, 'add', '.');
    git(repo, 'add', '-f', 'kept.log');
    commit(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
    git(repo, 'add', 'tracked.txt');
    writeFileSync(join(repo, 'tracked.txt'), 'unstaged before\n');
    writeFileSync(join(repo, 'dirty-before.txt'), 'pre-existing untracked\n');
    writeFileSync(join(repo, 'ignored.log'), 'ignored before\n');
    mkdirSync(join(repo, 'excluded'));
    writeFileSync(join(repo, 'excluded', 'cache.txt'), 'before\n');
    const index = resolve(repo, git(repo, 'rev-parse', '--git-path', 'index').trim());
    const indexBytes = readFileSync(index);
    const indexMtime = statSync(index, { bigint: true }).mtimeNs;
    const options = { exclude: ['excluded'] };
    const before = await snapshotWorkingTree(repo, options);
    expect(before).not.toBeNull();

    writeFileSync(join(repo, 'tracked.txt'), 'unstaged after is longer\n');
    writeFileSync(join(repo, 'kept.log'), 'updated tracked log\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    writeFileSync(join(repo, 'ignored.log'), 'ignored after\n');
    writeFileSync(join(repo, 'excluded', 'cache.txt'), 'after\n');
    rmSync(join(repo, 'gone.txt'));
    const after = await snapshotWorkingTree(repo, options);
    expect(after).not.toBeNull();
    const changes = await diffTrees(repo, before!.tree, after!.tree);
    expect(changes.files).toEqual([
      { path: 'gone.txt', status: 'D' }, { path: 'kept.log', status: 'M' },
      { path: 'new.txt', status: 'A' }, { path: 'tracked.txt', status: 'M' },
    ]);
    expect(changes.diff).toContain('-unstaged before\n+unstaged after is longer');
    expect(git(repo, 'ls-tree', '-r', '--name-only', after!.tree)).not.toMatch(/ignored\.log|excluded/);
    expect(git(repo, 'show', ':tracked.txt')).toBe('staged\n');
    expect(readFileSync(index)).toEqual(indexBytes);
    expect(statSync(index, { bigint: true }).mtimeNs).toBe(indexMtime);
  });

  it('snapshots an unborn repository without creating a real index', async () => {
    const { repo } = repository();
    writeFileSync(join(repo, 'first.txt'), 'first\n');
    const before = await snapshotWorkingTree(repo);
    expect(before).not.toBeNull();
    writeFileSync(join(repo, 'first.txt'), 'next\n');
    const changes = await diffSinceSnapshot(before!);
    expect(changes?.files).toEqual([{ path: 'first.txt', status: 'M' }]);
    expect(changes?.diff).toContain('-first\n+next');
    expect(() => statSync(join(repo, '.git', 'index'))).toThrow();
  });
});
