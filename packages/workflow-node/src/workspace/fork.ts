import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { type IsolatedWorkspace, WorkspaceMergeConflictError } from '@universal-agent/workflow-runtime';
import { diffTrees, git, snapshotWorkingTree } from './change-capture';

/** Commits made for forks carry this identity, so forking works without a configured git user. */
const FORK_IDENTITY = {
  GIT_AUTHOR_NAME: 'universal-agent',
  GIT_AUTHOR_EMAIL: 'workflow@universal-agent.local',
  GIT_COMMITTER_NAME: 'universal-agent',
  GIT_COMMITTER_EMAIL: 'workflow@universal-agent.local',
};

/** Ignored entries (dependencies, build caches) linked into a fork; more than this are skipped. */
const MAX_LINKED_IGNORED = 500;

/** Default merge lock: merges into one repository happen one at a time in this process. */
const mergeLocks = new Map<string, Promise<unknown>>();
async function withProcessMergeLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = mergeLocks.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  mergeLocks.set(root, next);
  try {
    return await next;
  } finally {
    if (mergeLocks.get(root) === next) mergeLocks.delete(root);
  }
}

function gitWithInput(root: string, args: readonly string[], input: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end(input);
  });
}

/** Files `git apply` complained about, from its error output. */
function conflictingFiles(stderr: string): string[] {
  const files = new Set<string>();
  for (const line of stderr.split('\n')) {
    const match =
      /^error: patch failed: (.+?):\d+$/.exec(line) ??
      /^error: (.+?): (?:already exists in working directory|does not exist in working directory|patch does not apply|does not match index)$/.exec(line);
    if (match) files.add(match[1]!);
  }
  return [...files];
}

export interface ForkWorkspaceInput {
  /** The workspace directory (may be a subdirectory of its repository). */
  readonly dir: string;
  /** Where the fork's worktree goes; must not exist yet. */
  readonly forkPath: string;
  /** Branch that keeps the fork's changes when they cannot be merged back. */
  readonly conflictBranch: string;
  /** Serializes merges into the workspace (default: one at a time per repository in this process). */
  readonly withMergeLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Copies `dir`'s repository, including uncommitted and untracked changes, into a detached git
 * worktree. Ignored entries such as `node_modules` are linked from the original so builds and
 * tests work in the copy. Returns null when `dir` is not in a git repository.
 *
 * `integrate()` applies the fork's changes to the original working tree (never its index),
 * one merge per repository at a time; changes that no longer apply raise
 * `WorkspaceMergeConflictError` and stay on `conflictBranch`.
 */
export async function forkWorkspace(input: ForkWorkspaceInput): Promise<IsolatedWorkspace | null> {
  const base = await snapshotWorkingTree(input.dir);
  if (!base) return null;
  const { root } = base;
  const head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
  const commitTree = async (tree: string, parent?: string, message = 'universal-agent: workflow step fork') =>
    (await git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], FORK_IDENTITY)).trim();
  const baseCommit = await commitTree(base.tree, head || undefined);

  await mkdir(dirname(input.forkPath), { recursive: true });
  await git(root, ['worktree', 'add', '--detach', input.forkPath, baseCommit]);

  // Ignored entries are not in the snapshot; link them so dependencies and caches resolve.
  const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']))
    .split('\0')
    .map((entry) => entry.replace(/\/$/, ''))
    .filter((entry) => entry && entry !== '.git' && !entry.startsWith('.git/'))
    .slice(0, MAX_LINKED_IGNORED);
  const linked: string[] = [];
  for (const entry of ignored) {
    const target = join(input.forkPath, entry);
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await symlink(join(root, entry), target).then(
      () => linked.push(entry),
      () => undefined
    );
  }

  const forkDir = join(input.forkPath, relative(root, input.dir));
  const snapshotFork = async () => {
    const after = await snapshotWorkingTree(input.forkPath, { exclude: linked });
    if (!after) throw new Error(`Could not read the workspace copy at ${input.forkPath}`);
    return after.tree;
  };
  let removed = false;
  const remove = async () => {
    if (removed) return;
    removed = true;
    await git(root, ['worktree', 'remove', '--force', input.forkPath]).catch(async () => {
      await rm(input.forkPath, { recursive: true, force: true });
      await git(root, ['worktree', 'prune']).catch(() => undefined);
    });
  };

  return {
    path: forkDir,
    async changes() {
      return diffTrees(forkDir, base.tree, await snapshotFork());
    },
    async integrate() {
      try {
        const after = await snapshotFork();
        const changes = await diffTrees(forkDir, base.tree, after);
        if (changes.files.length === 0) return changes;
        const patch = await git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', base.tree, after]);
        const apply = () => gitWithInput(root, ['apply', '--whitespace=nowarn'], patch);
        const applied = input.withMergeLock ? await input.withMergeLock(apply) : await withProcessMergeLock(root, apply);
        if (applied.code !== 0) {
          const kept = await commitTree(after, baseCommit, 'universal-agent: workflow step changes that did not merge');
          await git(root, ['branch', '--force', input.conflictBranch, kept]);
          throw new WorkspaceMergeConflictError(conflictingFiles(applied.stderr), input.conflictBranch);
        }
        return changes;
      } finally {
        await remove();
      }
    },
    discard: remove,
  };
}
