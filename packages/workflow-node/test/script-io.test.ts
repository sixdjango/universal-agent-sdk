import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptNode } from '@universal-agent/workflow-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeScriptExecutor, scriptInputEnvName } from '../src/index';

const script = (code: string, extra: Partial<ScriptNode> = {}): ScriptNode => ({
  kind: 'script',
  id: 'check',
  name: 'Check',
  command: 'node',
  args: ['-e', code],
  inputs: [],
  outputs: [],
  writeScopes: [],
  maxTechnicalRetries: 0,
  timeoutMs: 10_000,
  producesAssessment: true,
  ...extra,
});

const base = { runId: 'r', scopeKey: '$root', attemptId: 'a', invocationId: 'i' };

describe('NodeScriptExecutor inputs, outputs and changes', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ua-script-io-')));
    dirs.push(dir);
    return dir;
  };

  it('hands inputs over as files and reads results from UA_OUTPUTS_FILE', async () => {
    const executor = new NodeScriptExecutor({ defaultWorkdir: tempDir() });
    const code = `
      const fs = require('node:fs');
      const all = JSON.parse(fs.readFileSync(process.env.UA_INPUTS_FILE, 'utf8'));
      const draft = fs.readFileSync(process.env.${scriptInputEnvName('draft')}, 'utf8');
      const words = draft.split(/\\s+/).filter(Boolean).length;
      fs.writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({
        outputs: { words, limit: all.limits.max },
        artifacts: { report: { content: '# Report\\n' + words + ' words', summary: 'word count' } },
        assessment: { verdict: words <= all.limits.max ? 'PASS' : 'NEEDS_FIX', summary: words + ' words',
          findings: [{ id: 'len', severity: 'minor', message: 'too long' }] },
      }));`;
    const result = await executor.executeScript({
      ...base,
      node: script(code),
      inputs: { draft: 'one two three four', limits: { max: 3 } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual({ words: 4, limit: 3 });
    expect(result.artifacts?.report).toEqual({ content: '# Report\n4 words', summary: 'word count' });
    expect(result.assessment).toMatchObject({ verdict: 'NEEDS_FIX', summary: '4 words' });
  });

  it('fails the attempt when the outputs file is malformed', async () => {
    const executor = new NodeScriptExecutor({ defaultWorkdir: tempDir() });
    const bad = (body: string) =>
      executor.executeScript({ ...base, node: script(`require('node:fs').writeFileSync(process.env.UA_OUTPUTS_FILE, ${JSON.stringify(body)})`), inputs: {} });
    await expect(bad('{nope')).rejects.toThrow('invalid JSON');
    await expect(bad(JSON.stringify({ assessment: { verdict: 'LGTM', summary: 'x' } }))).rejects.toThrow('assessment.verdict');
  });

  it.each([false, true])('records writing script changes without touching the index (racy timestamps: %s)', async racy => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'old\n');
    writeFileSync(join(repo, 'gone.txt'), 'bye\n');
    const timestamp = 1_700_000_000;
    if (racy) {
      execFileSync('git', ['-C', repo, 'config', 'core.trustctime', 'false']);
      utimesSync(join(repo, 'a.txt'), timestamp, timestamp);
    }
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    if (racy) utimesSync(join(repo, '.git', 'index'), timestamp, timestamp);
    writeFileSync(join(repo, 'dirty-before.txt'), 'already here\n');

    const executor = new NodeScriptExecutor({ defaultWorkdir: repo });
    const code = `const fs = require('node:fs'); fs.writeFileSync('a.txt', 'new\\n'); fs.writeFileSync('b.txt', 'added\\n'); fs.rmSync('gone.txt');
      ${racy ? `fs.utimesSync('a.txt', ${timestamp}, ${timestamp});` : ''}`;
    const result = await executor.executeScript({ ...base, node: script(code, { writeScopes: ['.'] }), inputs: {} });

    expect(result.changes?.files).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'b.txt', status: 'A' },
      { path: 'gone.txt', status: 'D' },
    ]);
    expect(result.changes?.diff).toContain('-old\n+new');
    // Pre-existing uncommitted files are not attributed to the step, and nothing got staged.
    expect(result.changes?.diff).not.toContain('dirty-before');
    expect(execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })).toBe('');

    const readOnly = await executor.executeScript({ ...base, node: script('1'), inputs: {} });
    expect(readOnly.changes).toBeUndefined();
  });
});
