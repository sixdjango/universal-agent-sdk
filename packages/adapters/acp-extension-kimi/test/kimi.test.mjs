import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveKimiExecutable } from '../dist/index.js';

test('resolveKimiExecutable finds explicit UA_KIMI_PATH or PATH binary', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ua-kimi-test-'));
  try {
    const binName = process.platform === 'win32' ? 'kimi.cmd' : 'kimi';
    const fakeBin = join(tempDir, binName);
    writeFileSync(fakeBin, '#!/bin/sh\necho ok\n');
    chmodSync(fakeBin, 0o755);

    assert.equal(resolveKimiExecutable({ UA_KIMI_PATH: fakeBin }), fakeBin);
    assert.equal(resolveKimiExecutable({ PATH: tempDir }), fakeBin);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
