import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { findGitRoot } from './git-worktree';

const execFileAsync = promisify(execFile);

/** Diffs larger than this are cut, with a note; the file list is always complete. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

export interface WorkingTreeSnapshot {
  readonly root: string;
  /** The directory the snapshot was taken for; changes are reported relative to it. */
  readonly dir: string;
  /** Git tree object holding the working tree (tracked + untracked, honouring .gitignore). */
  readonly tree: string;
}

export interface WorkspaceChanges {
  /** Unified diff from the snapshot taken before the step to the working tree after it. */
  readonly diff: string;
  readonly files: readonly { readonly path: string; readonly status: string }[];
  /** The repository trees compared, kept in its object store (what a fork replays). */
  readonly trees?: { readonly before: string; readonly after: string };
}

export async function git(root: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return stdout;
}

async function copyIndex(sourcePath: string, targetPath: string): Promise<void> {
  const source = await open(sourcePath, 'r').catch((error: NodeJS.ErrnoException) => {
    // An unborn repository need not have an index yet; git add will create ours.
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!source) return;
  try {
    // Read metadata and bytes from the same open file: Git may atomically replace
    // the index while we copy it. Never pair old contents with a newer timestamp.
    const { mtimeNs } = await source.stat({ bigint: true });
    await pipeline(source.createReadStream(), createWriteStream(targetPath, { flags: 'wx' }));
    // Git rechecks content when a file's mtime >= the index's mtime (racy Git).
    // A fresh copy timestamp hides equal-size edits whose cached stat still matches.
    // Round down to seconds so timestamp precision loss cannot advance this bound.
    const seconds = Number(mtimeNs / 1_000_000_000n);
    await utimes(targetPath, seconds, seconds);
  } finally {
    await source.close();
  }
}

/**
 * Records the working tree of `dir`'s repository as a git tree, through a temporary index
 * so the user's staging area is never touched. Returns null outside git repositories.
 */
export async function snapshotWorkingTree(
  dir: string,
  options: { exclude?: readonly string[] } = {}
): Promise<WorkingTreeSnapshot | null> {
  const root = await findGitRoot(dir);
  if (!root) return null;
  const tempIndex = join(tmpdir(), `ua-index-${randomBytes(6).toString('hex')}`);
  try {
    // Keep tracked/ignored entries and the user's staging state only in our copy.
    const indexPath = (await git(root, ['rev-parse', '--git-path', 'index'])).trim();
    await copyIndex(isAbsolute(indexPath) ? indexPath : join(root, indexPath), tempIndex);
    const env = { GIT_INDEX_FILE: tempIndex };
    await git(root, ['add', '--all', '--', '.'], env);
    if (options.exclude?.length) {
      await git(root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...options.exclude], env);
    }
    const tree = (await git(root, ['write-tree'], env)).trim();
    return { root, dir, tree };
  } catch {
    return null;
  } finally {
    await rm(tempIndex, { force: true });
  }
}

/** What changed in the working tree since `before`. */
export async function diffSinceSnapshot(before: WorkingTreeSnapshot): Promise<WorkspaceChanges | null> {
  const after = await snapshotWorkingTree(before.dir);
  if (!after) return null;
  return diffTrees(before.dir, before.tree, after.tree);
}

/** Changes between two trees, with paths relative to `dir` (and limited to it). */
export async function diffTrees(dir: string, from: string, to: string): Promise<WorkspaceChanges> {
  if (from === to) return { diff: '', files: [] };
  const nameStatus = await git(dir, ['diff', '--relative', '--name-status', '--no-renames', from, to]);
  const files = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status = '', ...path] = line.split('\t');
      return { path: path.join('\t'), status };
    });
  let diff = await git(dir, ['diff', '--relative', '--no-color', '--no-ext-diff', from, to]);
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    diff = `${Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString('utf8')}\n\n[diff truncated at ${MAX_DIFF_BYTES} bytes; ${files.length} files changed]\n`;
  }
  return { diff, files, trees: { before: from, after: to } };
}
