import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

/** Top-level directory of the git repository containing `path`, or null when it is not in one. */
export async function findGitRoot(path: string): Promise<string | null> {
  try {
    return await git(path, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/** Branch and directory names may only use characters git and file systems accept everywhere. */
function safeSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 64) || 'x';
}

export interface RunWorktree {
  readonly path: string;
  readonly branch: string;
  readonly sourcePath: string;
}

/** Last 8 characters of the run id: what the UI shows as the run's name. */
export function shortRunId(runId: string): string {
  return runId.slice(-8);
}

/**
 * Creates a git worktree for one run's workspace slot at the source repository's current
 * HEAD, on a new branch `ua/<short run id>/<slot>`, under `<worktreesDir>/<runId>/<slot>`.
 */
export async function createRunWorktree(input: {
  readonly repoPath: string;
  readonly worktreesDir: string;
  readonly runId: string;
  readonly slot: string;
}): Promise<RunWorktree> {
  const root = await findGitRoot(input.repoPath);
  if (!root) throw new Error(`"${input.repoPath}" is not inside a git repository`);
  const run = safeSegment(input.runId);
  const slot = safeSegment(input.slot);
  const path = join(input.worktreesDir, run, slot);
  const branch = `ua/${safeSegment(shortRunId(input.runId))}/${slot}`;
  await mkdir(dirname(path), { recursive: true });
  await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  return { path, branch, sourcePath: root };
}

/** Removes a worktree created by `createRunWorktree` (its branch is kept). */
export async function removeRunWorktree(worktree: Pick<RunWorktree, 'path' | 'sourcePath'>): Promise<void> {
  await git(worktree.sourcePath, ['worktree', 'remove', '--force', worktree.path]);
}
