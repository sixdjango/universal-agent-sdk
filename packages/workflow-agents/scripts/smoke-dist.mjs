#!/usr/bin/env node
/**
 * Loads the four workflow packages from their built `dist/` with plain Node (no bundler, no
 * vitest) and runs a small agent + chief workflow on SQLite, the way an npm consumer would.
 * Run after `pnpm run build:workflow`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime } from '@universal-agent/workflow-runtime';
import {
  openWorkflowDatabase,
  resolveWorkflowStoragePaths,
  SqliteArtifactStore,
  SqliteRuntimeStore,
} from '@universal-agent/workflow-node';
import { SqliteAgentRegistry } from '@universal-agent/workflow-agents';

// Browser-safe packages must not pull in Node built-ins.
for (const name of ['@universal-agent/workflow-contract', '@universal-agent/workflow-runtime']) {
  const entry = fileURLToPath(import.meta.resolve(name));
  assert.ok(entry.endsWith(join('dist', 'index.js')), `${name} does not resolve to its bundle`);
  assert.ok(!/from\s+['"]node:/.test(readFileSync(entry, 'utf8')), `${name} dist imports node: built-ins`);
}

const home = mkdtempSync(join(tmpdir(), 'ua-wf-smoke-'));
const paths = resolveWorkflowStoragePaths(home);
const db = openWorkflowDatabase(paths.databasePath);
try {
  const registry = new SqliteAgentRegistry({ db });
  registry.register({ id: 'junior', name: 'Junior', charter: 'Learning.' });
  registry.register({ id: 'senior', name: 'Senior', charter: 'Experienced.' });

  const runtime = createWorkflowRuntime({
    store: new SqliteRuntimeStore({ db }),
    artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
    agentRegistry: registry,
    chief: {
      async review({ trigger }) {
        return trigger.kind === 'node.failed'
          ? {
              rationale: 'hand over to senior',
              commands: [
                { kind: 'swap_agent', nodeId: 'worker', agentRef: 'senior' },
                { kind: 'retry_node', scopeKey: '$root', nodeId: 'worker' },
              ],
            }
          : { rationale: '', commands: [] };
      },
    },
    executor: {
      async executeAgent(req) {
        if (req.agent?.agentId === 'junior') throw new Error('junior got stuck');
        return { status: 'COMPLETED', artifacts: { result: { content: `# Done\nby ${req.agent?.agentId}` } } };
      },
      async executeScript() {
        throw new Error('unused');
      },
    },
  });

  const definition = createWorkflowBuilder('smoke')
    .addWorkflowOutput({ name: 'result', type: 'artifact', required: true })
    .addAgent({
      id: 'worker',
      name: 'Worker',
      role: 'worker',
      agentRef: 'junior',
      goal: 'Do the task',
      outputs: [{ name: 'result', type: 'artifact', required: true }],
    })
    .connectData({ fromNodeId: 'worker', fromPort: 'result', toNodeId: '$output', toPort: 'result' })
    .setChief({})
    .buildDefinition();

  const started = await runtime.start({ definition });
  const done = await runtime.runUntilSettled(started.runId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.match(String(done.outputs.result), /by senior/);

  const tables = db.$client
    .prepare("select name from sqlite_master where type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of ['run_log', 'node_attempts', 'chief_interventions', 'agents', 'agent_versions']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  console.log('workflow dist smoke test passed');
} finally {
  db.$client.close();
  rmSync(home, { recursive: true, force: true });
}
