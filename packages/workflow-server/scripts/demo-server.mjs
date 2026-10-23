#!/usr/bin/env node
/**
 * UI development server: the real workflow server and web canvas, but agents are mocked
 * (with delays so running states are visible). Never runs a real agent or touches files.
 *
 *   pnpm --filter @universal-agent/workflow-server run demo       ->  http://127.0.0.1:4318
 *   pnpm --filter @universal-agent/workflow-server run dev:demo   (same, restarts on changes)
 *
 * Inputs containing "fail" make the reviewer answer without a verdict (a failed review);
 * inputs containing "fix" make reviewers ask for fixes twice, then pass (loops go 3 rounds).
 * The chief is mocked too: it reports progress when you write to it, and "rerun <step>"
 * (or "重跑 <step>") re-runs that step.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SqliteAgentRegistry } from '@universal-agent/workflow-agents';
import {
  AgentRuntimeCatalog,
  openWorkflowDatabase,
  resolveWorkflowStoragePaths,
  SqliteArtifactStore,
  SqliteRuntimeStore,
} from '@universal-agent/workflow-node';
import { createWorkflowRuntime } from '@universal-agent/workflow-runtime';
import { webDistDir } from '@universal-agent/workflow-web';
import { createWorkflowServer } from '@universal-agent/workflow-server';

// `pnpm run <script> -- --flag` forwards the `--` itself; drop it.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    port: { type: 'string', default: '4318' },
    delay: { type: 'string', default: '1500' },
    home: { type: 'string' },
  },
});
const delayMs = Number(values.delay);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fixed location so the data survives `dev:demo` restarts; never the real ~/.universal-agent.
const home = values.home ?? join(tmpdir(), 'universal-agent-workflow-demo');
const paths = resolveWorkflowStoragePaths(home);
const db = openWorkflowDatabase(paths.databasePath);
const registry = new SqliteAgentRegistry({ db });

/** Names of every step, nested ones included. */
function stepNames(nodes, into = new Map()) {
  for (const n of nodes) {
    into.set(n.id, n.name);
    if (n.kind === 'loop') stepNames(n.bodyGraph.nodes, into);
    if (n.kind === 'parallel') stepNames(n.itemGraph.nodes, into);
  }
  return into;
}

/** A rule-based stand-in for the LLM chief, so the chat can be tried without tokens. */
const mockChief = {
  async review({ state, trigger }) {
    await sleep(Math.min(delayMs, 1200));
    const names = stepNames(state.definition.graph.nodes);
    if (trigger.kind !== 'user.message') {
      return trigger.kind === 'node.failed'
        ? { rationale: `${names.get(trigger.nodeId) ?? trigger.nodeId} failed: ${trigger.detail}. Leaving it for you to decide.`, commands: [] }
        : { rationale: '', commands: [] };
    }
    const root = state.scopes.$root;
    const byStatus = (status) =>
      Object.values(root?.nodes ?? {})
        .filter((n) => n.status === status)
        .map((n) => names.get(n.nodeId) ?? n.nodeId);
    const done = byStatus('SUCCEEDED');
    const failed = byStatus('FAILED');
    const waiting = byStatus('WAITING');
    const text = trigger.detail.toLowerCase();
    const target = [...names].find(([id, name]) => text.includes(id.toLowerCase()) || text.includes(name.toLowerCase()));
    if (target && /rerun|re-run|redo|重跑|重新/.test(text) && root?.nodes[target[0]]) {
      return {
        rationale: 'The human asked for a rerun',
        reply: `Re-running “${target[1]}” and everything after it.`,
        commands: [{ kind: 'rerun_from_node', scopeKey: '$root', nodeId: target[0] }],
      };
    }
    const parts = [`The run is ${state.status.toLowerCase()}.`];
    if (done.length) parts.push(`Done: ${done.join(', ')}.`);
    if (waiting.length) parts.push(`Waiting for you: ${waiting.join(', ')}.`);
    if (failed.length) parts.push(`Failed: ${failed.join(', ')}.`);
    parts.push('Ask me to "rerun <step>" if you want a step done again.');
    return { rationale: 'Status question', reply: parts.join(' '), commands: [] };
  },
};

const runtime = createWorkflowRuntime({
  chief: mockChief,
  store: new SqliteRuntimeStore({ db }),
  artifacts: new SqliteArtifactStore({ db, blobsDir: paths.blobsDir }),
  agentRegistry: registry,
  executor: {
    async executeAgent(req) {
      await sleep(delayMs);
      const request = String(req.inputs.request ?? req.inputs.topic ?? '');
      if (req.node.producesAssessment && request.includes('fix')) {
        // Loops: ask for fixes in the first two rounds, then pass.
        const round = Number(/:round_(\d+)/.exec(req.scopeKey)?.[1] ?? 0);
        return round < 2
          ? {
              status: 'COMPLETED',
              assessment: {
                verdict: 'NEEDS_FIX',
                summary: `Round ${round + 1}: not there yet`,
                findings: [{ id: `r${round}`, severity: 'major', message: 'Line 2 has 8 syllables; it needs 7' }],
              },
            }
          : { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'All criteria met' } };
      }
      if (req.node.id === 'review') {
        if (request.includes('fail')) return { status: 'COMPLETED', outputs: { notes: 'Looks fine to me.' } };
        return {
          status: 'COMPLETED',
          assessment: { verdict: 'PASS', summary: 'Behaviour matches the request; tests cover it.' },
        };
      }
      const port = req.node.outputs[0]?.name ?? 'output';
      return {
        status: 'COMPLETED',
        artifacts: {
          [port]: {
            content: `# ${req.node.name}\n\nRequest: ${request || '(none)'}\n\n- Added the feature\n- Added tests\n`,
            summary: req.node.name,
          },
        },
      };
    },
    async executeScript() {
      await sleep(delayMs);
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: delayMs };
    },
  },
});

// Real installed-client detection and static model / effort lists; the demo never starts
// real clients, so refreshing from a live client is disabled.
const catalog = new AgentRuntimeCatalog({ workdir: home });
const runtimeCatalog = {
  list: () => catalog.list(),
  async refresh() {
    throw new Error('The demo server uses mock agents and cannot probe clients');
  },
};
const server = await createWorkflowServer({
  runtime,
  db,
  registry,
  runtimeCatalog,
  webDir: webDistDir,
  worktreesDir: paths.worktreesDir,
  logger: { level: 'warn' },
});
const address = await server.app.listen({ port: Number(values.port), host: '127.0.0.1' });
process.stdout.write(`Workflow demo (mock agents, data in ${home}): ${address}\n`);
