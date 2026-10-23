import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openWorkflowDatabase, resolveWorkflowStoragePaths, SqliteArtifactStore } from '../src/index';

it('never exposes a partially written blob when the same large content is stored concurrently', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ua-blob-'));
  try {
    const paths = resolveWorkflowStoragePaths(home);
    const db = openWorkflowDatabase(paths.databasePath);
    const store = new SqliteArtifactStore({ db, blobsDir: paths.blobsDir, inlineBlobMaxBytes: 1024 });
    const content = 'x'.repeat(2 * 1024 * 1024);
    const put = () =>
      store.put({ content, producerRunId: 'r', producerNodeId: 'n', producerAttemptId: 'a', portName: 'p' });
    const first = await put();
    // Readers of the first artifact run while 20 writers store the same bytes again.
    const results = await Promise.all([
      ...Array.from({ length: 20 }, put),
      ...Array.from({ length: 20 }, () => store.readText(first.artifactId)),
    ]);
    for (const text of results.slice(20)) expect((text as string).length).toBe(content.length);
    const shard = readdirSync(join(paths.blobsDir, first.sha256.slice(0, 2)));
    expect(shard).toEqual([first.sha256]); // one blob, no temp files left behind
    db.$client.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
