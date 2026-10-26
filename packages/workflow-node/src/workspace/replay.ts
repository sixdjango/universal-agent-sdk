import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { git, snapshotWorkingTree } from './change-capture';
import { findGitRoot } from './git-worktree';

/** Commits made for replays carry this identity, so replaying works without a configured git user. */
const REPLAY_IDENTITY = {
  GIT_AUTHOR_NAME: 'universal-agent',
  GIT_AUTHOR_EMAIL: 'workflow@universal-agent.local',
  GIT_COMMITTER_NAME: 'universal-agent',
  GIT_COMMITTER_EMAIL: 'workflow@universal-agent.local',
};

/** One step's change to lay onto a workspace, oldest first. */
export interface ReplayableChange {
  /** Who made it, for error messages (e.g. the step id). */
  readonly label: string;
  /** Repository trees before and after the change, when recorded. */
  readonly trees?: { readonly before: string; readonly after: string };
  /** Reads the change's unified diff (paths relative to the workspace); used when the trees are gone. */
  readonly readDiff: () => Promise<string>;
}

export class ChangeReplayError extends Error {
  readonly label: string;
  readonly files: readonly string[];

  constructor(label: string, message: string, files: readonly string[] = []) {
    super(message);
    this.name = 'ChangeReplayError';
    this.label = label;
    this.files = files;
  }
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cwd: string, args: readonly string[], input = '', env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function hasTree(root: string, tree: string): Promise<boolean> {
  return (await run(root, ['cat-file', '-e', `${tree}^{tree}`])).code === 0;
}

/**
 * Lays `changes` onto the working tree of `dir` (a git repository or a directory in one), in
 * order: each change is merged three-way into what the earlier ones left, so it lands even
 * where the repository moved on since it was made, binary files included. Changes whose trees
 * were not recorded or are no longer in the object store fall back to applying their diff.
 * Nothing is written unless every change lands; a change that does not throws
 * `ChangeReplayError` naming it and the files in the way.
 */
export async function replayWorkspaceChanges(dir: string, changes: readonly ReplayableChange[]): Promise<{ files: readonly string[] }> {
  if (changes.length === 0) return { files: [] };
  const root = await findGitRoot(dir);
  if (!root) throw new ChangeReplayError(changes[0]!.label, `"${dir}" is not in a git repository, so earlier changes cannot be replayed into it`);
  const initial = (await snapshotWorkingTree(root))?.tree;
  if (!initial) throw new ChangeReplayError(changes[0]!.label, `Could not read the working tree of "${root}"`);

  const commit = async (tree: string, parent?: string) =>
    (await git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'universal-agent: replayed workflow step change'], REPLAY_IDENTITY)).trim();
  const prefix = relative(root, dir);
  let current = initial;
  for (const change of changes) {
    const trees = change.trees && (await hasTree(root, change.trees.before)) && (await hasTree(root, change.trees.after)) ? change.trees : undefined;
    if (trees) {
      if (trees.before === trees.after) continue;
      if (current === trees.before) {
        current = trees.after;
        continue;
      }
      // Both sides grow from the tree the change started at, so merge-tree takes it as the base.
      const base = await commit(trees.before);
      const [ours, theirs] = await Promise.all([commit(current, base), commit(trees.after, base)]);
      const merged = await run(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]);
      if (merged.code > 1) throw new ChangeReplayError(change.label, `git merge-tree failed (git 2.38 or newer is needed): ${merged.stderr.trim()}`);
      const [tree = '', ...files] = merged.stdout.split('\n').filter(Boolean);
      if (merged.code === 1) {
        const clashing = [...new Set(files)];
        throw new ChangeReplayError(change.label, `Changes of "${change.label}" do not merge onto the current code (${clashing.join(', ')})`, clashing);
      }
      current = tree;
      continue;
    }
    current = await applyDiffToTree(root, prefix, current, change);
  }
  if (current === initial) return { files: [] };
  const patch = await git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', initial, current]);
  const applied = await run(root, ['apply', '--whitespace=nowarn'], patch);
  if (applied.code !== 0) throw new ChangeReplayError(changes[changes.length - 1]!.label, `Could not write the replayed changes: ${applied.stderr.trim()}`);
  const files = (await git(root, ['diff', '--name-only', '--no-renames', initial, current])).split('\n').filter(Boolean);
  return { files };
}

/** Applies a change's recorded diff to `tree` through a scratch index; returns the new tree. */
async function applyDiffToTree(root: string, prefix: string, tree: string, change: ReplayableChange): Promise<string> {
  const diff = await change.readDiff();
  if (/\n\[diff truncated at \d+ bytes;/.test(diff)) {
    throw new ChangeReplayError(change.label, `Changes of "${change.label}" were recorded only in part (the diff was too large) and cannot be replayed`);
  }
  if (!diff.trim()) return tree;
  const binary = [...diff.matchAll(/^Binary files (?:a\/)?(.+?) and (?:b\/)?(.+?) differ$/gm)].map((m) => (m[2] === '/dev/null' ? m[1]! : m[2]!));
  if (binary.length > 0) {
    throw new ChangeReplayError(change.label, `Changes of "${change.label}" include binary files recorded without their contents (${binary.join(', ')}) and cannot be replayed`, binary);
  }
  const env = { GIT_INDEX_FILE: join(tmpdir(), `ua-replay-index-${randomBytes(6).toString('hex')}`) };
  try {
    await git(root, ['read-tree', tree], env);
    const applied = await run(root, ['apply', '--cached', '--whitespace=nowarn', ...(prefix ? [`--directory=${prefix}`] : [])], diff, env);
    if (applied.code !== 0) {
      throw new ChangeReplayError(change.label, `Changes of "${change.label}" do not apply onto the current code: ${applied.stderr.trim()}`);
    }
    return (await git(root, ['write-tree'], env)).trim();
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
}
