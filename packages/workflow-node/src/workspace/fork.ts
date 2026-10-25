import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { WorkspaceMergeCheck } from '@universal-agent/workflow-contract';
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

/** The end of a failed merge check's output kept for the step (and its agent) to read. */
const CHECK_OUTPUT_TAIL = 4000;

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

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command that may fail, with its exit code and output (and `input` on stdin). */
function run(command: string, args: readonly string[], input = ''): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

/**
 * Clones each of `entries` from `from` into `to` with one clonefileat(2) call per entry: a
 * whole directory (`node_modules` included) is cloned copy-on-write by the kernel in well
 * under a second. Perl ships with macOS and is the only stock tool that clones directories
 * whole (`cp -c` and `ditto --clone` clone file by file, ten times slower).
 */
async function cloneEntries(from: string, to: string, entries: readonly string[]): Promise<boolean> {
  if (process.platform !== 'darwin' || entries.length === 0) return false;
  // 462 is SYS_clonefileat, -2 AT_FDCWD and 1 CLONE_NOFOLLOW.
  const script = 'for (my $i = 0; $i < @ARGV; $i += 2) { syscall(462, -2, $ARGV[$i], -2, $ARGV[$i + 1], 1) == 0 or die "$ARGV[$i]: $!\\n" }';
  const pairs = entries.flatMap((entry) => [join(from, entry), join(to, entry)]);
  const cloned = await run('perl', ['-e', script, ...pairs]).catch(() => null);
  return cloned?.code === 0;
}

/**
 * Three-way merges `theirs` into `ours` (trees, both grown from `baseCommit`). Returns the
 * merged tree, or the files changed on both sides in ways that do not merge.
 */
async function mergeTrees(
  root: string,
  commit: (tree: string) => Promise<string>,
  ours: string,
  theirs: string
): Promise<{ tree: string; conflicts: string[] } | null> {
  const [oursCommit, theirsCommit] = await Promise.all([commit(ours), commit(theirs)]);
  const merged = await run('git', ['-C', root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', oursCommit, theirsCommit]);
  // 0: merged, 1: conflicts, anything else: no merge-tree (git older than 2.38) or an error.
  if (merged.code > 1) return null;
  const [tree = '', ...files] = merged.stdout.split('\n').filter(Boolean);
  return { tree, conflicts: merged.code === 0 ? [] : [...new Set(files)] };
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

/** Runs a merge check in `cwd`: null when it passes, else the end of what it printed. */
function runMergeCheck(cwd: string, check: WorkspaceMergeCheck): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(check.command, check.args, { cwd, timeout: check.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(null);
      const output = `${stdout}${stderr}`.trim() || error.message;
      resolve(output.length > CHECK_OUTPUT_TAIL ? `…${output.slice(-CHECK_OUTPUT_TAIL)}` : output);
    });
  });
}

/**
 * Makes `forkPath` a worktree at `baseCommit` holding a copy-on-write clone of `root`'s
 * working tree. False, with nothing left behind, where the file system cannot clone.
 */
async function cloneWorkingTree(root: string, forkPath: string, baseCommit: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  // The fork must not clone itself when it lives inside the repository.
  const entries = (await readdir(root)).filter((entry) => entry !== '.git' && !`${forkPath}${sep}`.startsWith(join(root, entry) + sep));
  await git(root, ['worktree', 'add', '--detach', '--no-checkout', forkPath, baseCommit]);
  if (await cloneEntries(root, forkPath, entries)) {
    // Fill the index so git in the copy sees a clean tree.
    await git(forkPath, ['reset', '-q']);
    return true;
  }
  await rm(forkPath, { recursive: true, force: true });
  await git(root, ['worktree', 'prune']).catch(() => undefined);
  return false;
}

export interface ForkWorkspaceInput {
  /** The workspace directory (may be a subdirectory of its repository). */
  readonly dir: string;
  /** Where the fork's worktree goes; must not exist yet. */
  readonly forkPath: string;
  /** Branch that keeps the fork's changes when they cannot be merged back. */
  readonly conflictBranch: string;
  /** Checks merged code in the copy before it lands, when others changed the workspace meanwhile. */
  readonly mergeCheck?: WorkspaceMergeCheck;
  /** Serializes merges into the workspace (default: one at a time per repository in this process). */
  readonly withMergeLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Copies `dir`'s repository, including uncommitted and untracked changes, into a detached git
 * worktree. Where the file system clones copy-on-write (APFS), the whole working tree is
 * cloned, ignored entries such as `node_modules` and `dist` included, so the copy builds and
 * resolves packages on its own. Elsewhere the worktree is checked out and ignored entries are
 * linked from the original. Returns null when `dir` is not in a git repository.
 *
 * `integrate()` merges the fork's changes three ways into the original working tree as it is
 * by then (never its index), one merge per repository at a time. When others changed it
 * meanwhile, `mergeCheck` first runs on the merged code in the copy. Changes that do not
 * merge, or fail the check, raise `WorkspaceMergeConflictError` and stay on `conflictBranch`.
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
  const linked: string[] = [];
  if (!(await cloneWorkingTree(root, input.forkPath, baseCommit))) {
    await git(root, ['worktree', 'add', '--detach', input.forkPath, baseCommit]);

    // Ignored entries are not in the snapshot; link them so dependencies and caches resolve.
    const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']))
      .split('\0')
      .map((entry) => entry.replace(/\/$/, ''))
      .filter((entry) => entry && entry !== '.git' && !entry.startsWith('.git/'))
      .slice(0, MAX_LINKED_IGNORED);
    for (const entry of ignored) {
      const target = join(input.forkPath, entry);
      if (existsSync(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(root, entry), target).then(
        () => linked.push(entry),
        () => undefined
      );
    }
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
    // Unregister the copy at once; deleting its files (a cloned node_modules is large) can
    // finish in the background.
    const trash = `${input.forkPath}.${Date.now()}.removed`;
    await rename(input.forkPath, trash).then(
      () => void rm(trash, { recursive: true, force: true }).catch(() => undefined),
      () => rm(input.forkPath, { recursive: true, force: true })
    );
    await git(root, ['worktree', 'prune']).catch(() => undefined);
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
        const diff = (from: string, to: string) => git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', from, to]);
        type Clash = { files: string[]; check?: { command: string; output: string } };
        const merge = async (): Promise<Clash | null> => {
          // Others may have changed the workspace since the fork: merge into it as it is now.
          const current = (await snapshotWorkingTree(root))?.tree ?? base.tree;
          const merged =
            current === base.tree
              ? { tree: after, conflicts: [] }
              : await mergeTrees(root, (tree) => commitTree(tree, baseCommit), current, after);
          const [from, to] = merged ? [current, merged.tree] : [base.tree, after];
          if (merged && merged.conflicts.length > 0) return { files: merged.conflicts };
          if (input.mergeCheck && current !== base.tree && merged) {
            // Edits can merge line by line and still break each other: check the merged code
            // in the copy before it lands.
            const catchUp = await diff(after, merged.tree);
            const caughtUp = !catchUp || (await run('git', ['-C', input.forkPath, 'apply', '--whitespace=nowarn'], catchUp)).code === 0;
            const output = caughtUp ? await runMergeCheck(forkDir, input.mergeCheck) : 'Could not bring the copy up to the merged code';
            if (output !== null) {
              return { files: [], check: { command: [input.mergeCheck.command, ...input.mergeCheck.args].join(' '), output } };
            }
          }
          const patch = await diff(from, to);
          if (!patch) return null;
          const applied = await run('git', ['-C', root, 'apply', '--whitespace=nowarn'], patch);
          return applied.code === 0 ? null : { files: conflictingFiles(applied.stderr) };
        };
        const clash = input.withMergeLock ? await input.withMergeLock(merge) : await withProcessMergeLock(root, merge);
        if (clash) {
          const kept = await commitTree(after, baseCommit, 'universal-agent: workflow step changes that did not merge');
          await git(root, ['branch', '--force', input.conflictBranch, kept]);
          throw new WorkspaceMergeConflictError(clash.files, input.conflictBranch, clash.check);
        }
        return changes;
      } finally {
        await remove();
      }
    },
    discard: remove,
  };
}
