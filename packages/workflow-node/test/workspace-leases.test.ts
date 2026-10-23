import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalWorkspaceManager, openWorkflowDatabase, workflowSchema } from '../src/index';

describe('workspace leases shared through the database', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('makes a second process wait for overlapping scopes, but not for others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ua-wsl-'));
    dirs.push(dir);
    const db = openWorkflowDatabase(join(dir, 'workflow.db'));
    const a = new LocalWorkspaceManager({ db });
    const b = new LocalWorkspaceManager({ db });
    const lease = (m: LocalWorkspaceManager, scopes: string[], workspace = '/repo') =>
      m.acquireLease({ runId: 'r', attemptId: 'x', writeScopes: scopes, workspace });

    const held = await lease(a, ['src']);
    let waited = false;
    const blocked = lease(b, ['src/ui']).then((l) => {
      waited = true;
      return l;
    });
    // Different scope, different workspace, and read-only steps go straight through.
    await lease(b, ['docs']);
    await lease(b, ['src'], '/other-repo');
    await lease(b, []);
    await new Promise((r) => setTimeout(r, 400));
    expect(waited).toBe(false);

    await a.releaseLease(held.leaseId);
    const got = await blocked;
    expect(waited).toBe(true);
    await b.releaseLease(got.leaseId);
    db.$client.close();
  });

  it('ignores leases left behind by a process that died', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ua-wsl-'));
    dirs.push(dir);
    const db = openWorkflowDatabase(join(dir, 'workflow.db'));
    db.insert(workflowSchema.workspaceLeases)
      .values({ leaseId: 'ghost', workspace: '/repo', writeScopes: ['*'], ownerId: 'dead', expiresAtMs: Date.now() - 1 })
      .run();
    const m = new LocalWorkspaceManager({ db });
    const lease = await m.acquireLease({ runId: 'r', attemptId: 'x', writeScopes: ['src'], workspace: '/repo' });
    expect(db.select().from(workflowSchema.workspaceLeases).all().map((r) => r.leaseId)).toEqual([lease.leaseId]);
    await m.releaseLease(lease.leaseId);
    expect(db.select().from(workflowSchema.workspaceLeases).all()).toEqual([]);
    db.$client.close();
  });
});
