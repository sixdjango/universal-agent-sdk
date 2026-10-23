import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptNode } from '@universal-agent/workflow-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeScriptExecutor } from '../src/index';

const node = (cwd?: string): ScriptNode => ({
  kind: 'script',
  id: 'where',
  name: 'Where',
  command: 'node',
  args: ['-e', 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), root: process.env.UA_WORKSPACE_DIR, slot: process.env.UA_WORKSPACE_SLOT }))'],
  ...(cwd ? { cwd } : {}),
  inputs: [],
  outputs: [],
  writeScopes: [],
  maxTechnicalRetries: 0,
  timeoutMs: 10_000,
  producesAssessment: false,
});

describe('NodeScriptExecutor workspaces', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('runs in the bound workspace, with cwd relative to it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-ws-')));
    dirs.push(root);
    mkdirSync(join(root, 'packages', 'ui'), { recursive: true });
    const executor = new NodeScriptExecutor({ defaultWorkdir: tmpdir() });
    const base = { runId: 'r', scopeKey: '$root', attemptId: 'a', invocationId: 'i', inputs: {} };
    const workspace = { slot: 'app', path: root };

    const atRoot = JSON.parse((await executor.executeScript({ ...base, node: node(), workspace })).stdout);
    expect(atRoot).toEqual({ cwd: root, root, slot: 'app' });

    const nested = JSON.parse((await executor.executeScript({ ...base, node: node('packages/ui'), workspace })).stdout);
    expect(nested.cwd).toBe(join(root, 'packages', 'ui'));
  });
});
