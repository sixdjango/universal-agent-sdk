import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowBuilder, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime, type WorkflowRunState } from '@universal-agent/workflow-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diffSinceSnapshot,
  openWorkflowDatabase,
  resolveWorkflowStoragePaths,
  snapshotWorkingTree,
  SqliteArtifactStore,
  SqliteRuntimeStore,
  type WorkflowDatabase,
  WorkflowHost,
  WorkflowHostError,
} from '../src/index';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00, 0xfe]);

/** plan → write → ship, all in the `app` slot. */
function flow(shipGoal = 'ship it'): WorkflowDefinition {
  const step = (id: string, goal = `do ${id}`) => ({ id, name: id, role: 'worker', goal });
  return createWorkflowBuilder('forkable')
    .addWorkspace({ name: 'app' })
    .addAgent(step('plan'))
    .addAgent(step('write'))
    .addAgent(step('ship', shipGoal))
    .connectControl('plan', 'write')
    .connectControl('write', 'ship')
    .buildDefinition();
}

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });

describe('forking a run on the host', () => {
  const cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function open(options: { withoutTrees?: boolean } = {}) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ua-fork-')));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const paths = resolveWorkflowStoragePaths(home);
    const db: WorkflowDatabase = openWorkflowDatabase(paths.databasePath);
    cleanup.push(() => db.$client.close());
    const ran: { runId: string; nodeId: string; goal: string; files: Record<string, string | null> }[] = [];
    const runtime = createWorkflowRuntime({
      store: new SqliteRuntimeStore({ db }),
      artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
      executor: {
        async executeAgent(req) {
          const dir = req.workspace!.path;
          const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null);
          ran.push({ runId: req.runId, nodeId: req.node.id, goal: req.node.goal, files: { 'a.txt': read('a.txt'), 'b.txt': read('b.txt'), 'plan.md': read('plan.md') } });
          const before = (await snapshotWorkingTree(dir))!;
          if (req.node.id === 'plan') {
            writeFileSync(join(dir, 'plan.md'), 'the plan\n');
            // A text diff cannot carry binary contents: only runs that record trees write one.
            if (!options.withoutTrees) writeFileSync(join(dir, 'logo.png'), PNG);
          }
          if (req.node.id === 'write') writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
          const changes = (await diffSinceSnapshot(before))!;
          const { trees: _trees, ...withoutTrees } = changes;
          return { status: 'COMPLETED', changes: options.withoutTrees ? withoutTrees : changes };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const host = await WorkflowHost.open({ runtime, db, workdir: home, worktreesDir: paths.worktreesDir, logger: { error() {} } });
    cleanup.push(() => host.close());

    const repo = join(home, 'repo');
    mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'init');
    const workspace = await host.workspaces.create({ path: repo, isolation: 'git-worktree' });
    host.library.save(flow(), { mode: 'create' });

    const settled = async (runId: string): Promise<WorkflowRunState> => {
      for (let i = 0; i < 300; i++) {
        const run = await host.runs.get(runId);
        if (run.status !== 'RUNNING' && !host.runs.isActive(runId)) return run;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('run never settled');
    };
    const source = await settled((await host.startRun({ workflowId: 'forkable', workspaces: { app: workspace.id } })).runId);
    expect(source.status).toBe('SUCCEEDED');
    return { host, repo, ran, settled, source, worktreesDir: paths.worktreesDir };
  }

  /** Moves the repository's HEAD on: a new commit changing `file`. */
  const commit = (repo: string, file: string, content: string) => {
    writeFileSync(join(repo, file), content);
    gitIn(repo, 'commit', '-q', '-am', `change ${file}`);
  };

  it('runs the step again in a worktree at the current HEAD, with the earlier steps\' changes merged onto it', async () => {
    const { host, repo, ran, settled, source } = await open();
    commit(repo, 'b.txt', 'b from main\n');
    commit(repo, 'a.txt', 'one\ntwo\nthree\nfour\n');
    host.library.save(flow('ship it carefully'), { mode: 'update' });

    const fork = await settled((await host.forkRun({ sourceRunId: source.runId, nodeId: 'ship' })).runId);
    expect(fork.status).toBe('SUCCEEDED');
    const app = fork.workspaces.app!;
    expect(app.path).not.toBe(source.workspaces.app!.path);
    expect(ran.filter((r) => r.runId === fork.runId)).toEqual([
      // The saved definition, the new HEAD, and both earlier steps' changes (the writer's merged with main's).
      { runId: fork.runId, nodeId: 'ship', goal: 'ship it carefully', files: { 'a.txt': 'one\nTWO\nthree\nfour\n', 'b.txt': 'b from main\n', 'plan.md': 'the plan\n' } },
    ]);
    expect(readFileSync(join(app.path, 'logo.png')).equals(PNG)).toBe(true);
    expect(gitIn(app.path, 'rev-parse', 'HEAD')).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    // The source run's worktree is as it was.
    expect(readFileSync(join(source.workspaces.app!.path, 'b.txt'), 'utf8')).toBe('b\n');
  });

  it('fails the fork, leaving no worktree behind, when an earlier change no longer merges', async () => {
    const { host, repo, source, worktreesDir } = await open();
    commit(repo, 'a.txt', 'one\nzwei\nthree\n');
    const err = await host.forkRun({ sourceRunId: source.runId, nodeId: 'ship' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowHostError);
    expect((err as WorkflowHostError).code).toBe('conflict');
    expect((err as Error).message).toMatch(/Changes of "write" do not merge onto the current code \(a\.txt\)/);
    expect(gitIn(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(2);
    expect(host.runs.list().map((r) => r.runId)).toEqual([source.runId]);
    expect(existsSync(worktreesDir) ? execFileSync('ls', [worktreesDir], { encoding: 'utf8' }).trim().split('\n') : []).toHaveLength(1);
  });

  it('replays recorded diffs when the change trees are missing', async () => {
    const { host, repo, ran, settled, source } = await open({ withoutTrees: true });
    commit(repo, 'b.txt', 'b from main\n');
    const fork = await settled((await host.forkRun({ sourceRunId: source.runId, nodeId: 'ship' })).runId);
    expect(fork.status).toBe('SUCCEEDED');
    expect(ran.find((r) => r.runId === fork.runId)!.files).toEqual({ 'a.txt': 'one\nTWO\nthree\n', 'b.txt': 'b from main\n', 'plan.md': 'the plan\n' });
  });

  it('rejects forks from unknown steps or runs', async () => {
    const { host, source } = await open();
    await expect(host.forkRun({ sourceRunId: source.runId, nodeId: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(host.forkRun({ sourceRunId: 'run_missing', nodeId: 'ship' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
