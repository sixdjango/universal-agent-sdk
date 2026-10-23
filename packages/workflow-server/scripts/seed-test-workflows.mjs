#!/usr/bin/env node
/**
 * Seeds a set of test workflows (and the agents they use) into the workflow database:
 *
 *   pnpm --filter @universal-agent/workflow-server run seed:test            # ~/.universal-agent
 *   pnpm --filter @universal-agent/workflow-server run seed:test -- --home /tmp/ua
 *
 * Safe to re-run: workflows and agents are upserted by id (a changed definition becomes a new
 * version). Every agent step is read-only (no write scopes), so real runs never edit files.
 */
import { parseArgs } from 'node:util';
import { SqliteAgentRegistry } from '@universal-agent/workflow-agents';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import {
  openWorkflowDatabase,
  resolveUniversalAgentHome,
  resolveWorkflowStoragePaths,
  WorkflowLibrary,
} from '@universal-agent/workflow-node';

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: { home: { type: 'string' }, engine: { type: 'string', default: 'deepseek' } },
});
const engine = values.engine === 'dsh' ? 'deepseek' : values.engine;

const AGENTS = [
  {
    id: 'writer',
    name: 'Writer',
    charter: 'Writes clear, concise answers and drafts for the task at hand.',
    instructions: ['Answer in the language of the request.', 'Prefer short paragraphs and concrete examples.'],
    runtime: { adapter: 'acp', agentType: engine },
  },
  {
    id: 'critic',
    name: 'Critic',
    charter: 'Independently checks work against its acceptance criteria and gives a verdict.',
    instructions: [
      'Check every acceptance criterion one by one and cite the ones that fail.',
      'Return NEEDS_FIX with concrete findings when something can be fixed, PASS only when all criteria hold.',
    ],
    runtime: { adapter: 'acp', agentType: engine },
  },
  {
    id: 'lead',
    name: 'Lead',
    charter: 'Keeps workflow runs moving: adds guidance when work stalls and asks the owner when unsure.',
    runtime: { adapter: 'acp', agentType: engine },
  },
];

const readOnly = { writeScopes: [] };

/** 1. One agent, one answer: the cheapest end-to-end smoke test. */
const quickAnswer = createWorkflowBuilder('test-quick-answer', 'Test · Quick answer')
  .setDescription('One read-only agent answers a question')
  .addWorkflowInput({ name: 'question', type: 'string', required: true })
  .addWorkflowOutput({ name: 'answer', type: 'artifact', required: true })
  .addAgent({
    id: 'answer',
    name: 'Answer the question',
    role: 'writer',
    agentRef: 'writer',
    goal: 'Answer the question in at most 120 words',
    acceptanceCriteria: ['Directly answers the question', 'At most 120 words'],
    inputs: [{ name: 'question', type: 'string', required: true }],
    outputs: [{ name: 'answer', type: 'artifact', required: true }],
    ...readOnly,
  })
  .connectData({ fromNodeId: '$input', fromPort: 'question', toNodeId: 'answer', toPort: 'question' })
  .connectData({ fromNodeId: 'answer', fromPort: 'answer', toNodeId: '$output', toPort: 'answer' })
  .buildDefinition();

/** 2. Scripts only: instant and free; shows a PASS path, a NEEDS_FIX path and a skipped branch. */
const node = (code) => ['-e', code];
const scriptsOnly = createWorkflowBuilder('test-scripts-only', 'Test · Scripts only (no agents)')
  .setDescription('Deterministic scripts with a pass/fix branch; no agents, no tokens')
  .addScript({ id: 'version', name: 'Node version', command: 'node', args: ['--version'], outputs: [{ name: 'report', type: 'json', required: true }] })
  .addScript({
    id: 'check_ok',
    name: 'Check that passes',
    command: 'node',
    args: node("console.log('all checks green')"),
    outputs: [{ name: 'report', type: 'json', required: true }],
  })
  .addScript({
    id: 'check_fail',
    name: 'Check that fails',
    command: 'node',
    args: node("console.error('intentional failure: 1 of 3 checks failed'); process.exit(1)"),
    outputs: [{ name: 'report', type: 'json', required: true }],
  })
  .addScript({ id: 'ship', name: 'Ship (only on PASS)', command: 'node', args: node("console.log('shipped')") })
  .addScript({ id: 'ticket', name: 'Open a ticket (on NEEDS_FIX)', command: 'node', args: node("console.log('ticket opened')") })
  .connectControl('version', 'check_ok')
  .connectControl('version', 'check_fail')
  .connectControl('check_fail', 'ship', { kind: 'verdict_is', verdict: 'PASS' })
  .connectControl('check_fail', 'ticket', { kind: 'verdict_is', verdict: 'NEEDS_FIX' })
  .buildDefinition();

/** 3. Loop: writer and critic iterate until the haiku passes; the chief may add guidance. */
const haikuLoop = createWorkflowBuilder('test-haiku-loop', 'Test · Haiku fix loop')
  .setDescription('Writer drafts, critic reviews, repeat until PASS (max 3 rounds)')
  .addWorkflowInput({ name: 'topic', type: 'string', required: true })
  .addWorkflowOutput({ name: 'haiku', type: 'artifact', required: true })
  .addLoop({
    id: 'fix_loop',
    name: 'Write until it passes',
    maxRounds: 3,
    onExhausted: 'gate',
    continueWhen: { kind: 'verdict_is', verdict: 'NEEDS_FIX', sourceNodeId: 'review' },
    inputs: [{ name: 'topic', type: 'string', required: true }],
    outputs: [{ name: 'haiku', type: 'artifact', required: true }],
    body: (b) =>
      b
        .addAgent({
          id: 'draft',
          name: 'Write the haiku',
          role: 'writer',
          agentRef: 'writer',
          goal: 'Write a haiku about the topic; if there is feedback from a previous round, fix exactly that',
          acceptanceCriteria: ['Exactly three lines', 'Syllables 5 / 7 / 5', 'Clearly about the topic'],
          inputs: [{ name: 'topic', type: 'string', required: true }],
          outputs: [{ name: 'haiku', type: 'artifact', required: true }],
          ...readOnly,
        })
        .addAgent({
          id: 'review',
          name: 'Review the haiku',
          role: 'reviewer',
          agentRef: 'critic',
          goal: 'Count the syllables of every line and check the haiku against the criteria',
          acceptanceCriteria: ['Exactly three lines', 'Syllables 5 / 7 / 5', 'Clearly about the topic'],
          producesAssessment: true,
          inputs: [
            { name: 'topic', type: 'string', required: true },
            { name: 'haiku', type: 'artifact', required: true },
          ],
          ...readOnly,
        })
        .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'draft', toPort: 'topic' })
        .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'review', toPort: 'topic' })
        .connectData({ fromNodeId: 'draft', fromPort: 'haiku', toNodeId: 'review', toPort: 'haiku', withControl: true })
        .connectData({ fromNodeId: 'draft', fromPort: 'haiku', toNodeId: '$output', toPort: 'haiku' }),
  })
  .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'fix_loop', toPort: 'topic' })
  .connectData({ fromNodeId: 'fix_loop', fromPort: 'haiku', toNodeId: '$output', toPort: 'haiku' })
  .setChief({ agentRef: 'lead', maxLevel: 'advise', maxInterventionsPerRun: 5 })
  .buildDefinition();

/** 4. Parallel: explain each topic concurrently, then combine into one digest. */
const parallelDigest = createWorkflowBuilder('test-parallel-digest', 'Test · Parallel digest')
  .setDescription('One agent per topic in parallel, then a combined digest')
  .addWorkflowInput({ name: 'topics', type: 'json', required: true, description: 'JSON array, e.g. ["SQLite WAL", "CRDTs", "Raft"]' })
  .addWorkflowOutput({ name: 'digest', type: 'artifact', required: true })
  .addParallel({
    id: 'explain_each',
    name: 'Explain each topic',
    maxConcurrency: 3,
    defaultAgentRef: 'writer',
    inputs: [{ name: 'items', type: 'array', required: true }],
    outputs: [{ name: 'results', type: 'array', required: true }],
    itemBody: (b) =>
      b
        .addAgent({
          id: 'explain',
          name: 'Explain one topic',
          role: 'writer',
          goal: 'Explain the topic in 3 sentences for an experienced engineer',
          acceptanceCriteria: ['Exactly 3 sentences', 'Includes one concrete example'],
          inputs: [{ name: 'item', type: 'json', required: true }],
          outputs: [{ name: 'summary', type: 'artifact', required: true }],
          ...readOnly,
        })
        .connectData({ fromNodeId: '$input', fromPort: 'item', toNodeId: 'explain', toPort: 'item' })
        .connectData({ fromNodeId: 'explain', fromPort: 'summary', toNodeId: '$output', toPort: 'results' }),
  })
  .addAgent({
    id: 'combine',
    name: 'Combine into a digest',
    role: 'writer',
    agentRef: 'writer',
    goal: 'Merge the explanations into one digest with a heading per topic',
    inputs: [{ name: 'results', type: 'array', required: true }],
    outputs: [{ name: 'digest', type: 'artifact', required: true }],
    ...readOnly,
  })
  .connectData({ fromNodeId: '$input', fromPort: 'topics', toNodeId: 'explain_each', toPort: 'items' })
  .connectData({ fromNodeId: 'explain_each', fromPort: 'results', toNodeId: 'combine', toPort: 'results', withControl: true })
  .connectData({ fromNodeId: 'combine', fromPort: 'digest', toNodeId: '$output', toPort: 'digest' })
  .buildDefinition();

/** 5. Human gate: approve to continue, reject to stop (the announcement stays unreached). */
const approvalGate = createWorkflowBuilder('test-approval-gate', 'Test · Plan then approve')
  .setDescription('Agent drafts a plan, you approve or reject, then it continues or stops')
  .addWorkflowInput({ name: 'idea', type: 'string', required: true })
  .addWorkflowOutput({ name: 'announcement', type: 'artifact', required: false })
  .addAgent({
    id: 'plan',
    name: 'Draft a plan',
    role: 'writer',
    agentRef: 'writer',
    goal: 'Write a 5-step plan for the idea',
    acceptanceCriteria: ['Exactly 5 numbered steps'],
    inputs: [{ name: 'idea', type: 'string', required: true }],
    outputs: [{ name: 'plan', type: 'artifact', required: true }],
    ...readOnly,
  })
  .addGate({
    id: 'approve',
    name: 'Go ahead?',
    prompt: 'Read the plan. Should we write the announcement?',
    options: [
      { value: 'approve', label: 'Approve', description: 'Write the announcement' },
      { value: 'reject', label: 'Reject', description: 'Stop here' },
    ],
    outputs: [{ name: 'decision', type: 'string', required: true }],
  })
  .addAgent({
    id: 'announce',
    name: 'Write the announcement',
    role: 'writer',
    agentRef: 'writer',
    goal: 'Write a 3-sentence announcement of the plan',
    inputs: [{ name: 'plan', type: 'artifact', required: true }],
    outputs: [{ name: 'announcement', type: 'artifact', required: true }],
    ...readOnly,
  })
  .connectData({ fromNodeId: '$input', fromPort: 'idea', toNodeId: 'plan', toPort: 'idea' })
  .connectControl('plan', 'approve')
  .connectControl('approve', 'announce', { kind: 'port_equals', port: 'decision', value: 'approve' })
  .connectData({ fromNodeId: 'plan', fromPort: 'plan', toNodeId: 'announce', toPort: 'plan' })
  .connectData({ fromNodeId: 'announce', fromPort: 'announcement', toNodeId: '$output', toPort: 'announcement' })
  .buildDefinition();

/**
 * 6. Two workspaces: scripts print where they ran, so you can check slot bindings (and the
 *    per-run worktree when a slot is bound to a git workspace) without spending tokens.
 */
const whereAmI = node(
  "const { execSync } = require('node:child_process');" +
    "let branch = '';" +
    "try { branch = execSync('git branch --show-current', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}" +
    "console.log(JSON.stringify({ slot: process.env.UA_WORKSPACE_SLOT, cwd: process.cwd(), branch }))"
);
const twoWorkspaces = createWorkflowBuilder('test-two-workspaces', 'Test · Two workspaces')
  .setDescription('Each step runs in its own workspace slot; no agents, no tokens')
  .addWorkspace({ name: 'app', description: 'Any directory' })
  .addWorkspace({ name: 'other', description: 'Try a git repo set to "new git worktree per run"' })
  .addScript({ id: 'in_app', name: 'Where am I (app)', command: 'node', args: whereAmI, producesAssessment: false })
  .addScript({ id: 'in_other', name: 'Where am I (other)', command: 'node', args: whereAmI, workspace: 'other', producesAssessment: false })
  .addScript({ id: 'listing', name: 'List files (other)', command: 'ls', args: ['-a'], workspace: 'other', producesAssessment: false })
  .connectControl('in_other', 'listing')
  .buildDefinition();

/**
 * 7. Script handoff: one script writes an artifact through UA_OUTPUTS_FILE, the next reads
 *    it from its input file and returns a verdict with findings. No agents, no tokens.
 */
const scriptHandoff = createWorkflowBuilder('test-script-handoff', 'Test · Script handoff (files)')
  .setDescription('Scripts pass an artifact through UA_OUTPUTS_FILE / UA_INPUT_<PORT>; the checker returns findings')
  .addScript({
    id: 'draft',
    name: 'Write a draft',
    command: 'node',
    args: node(
      "const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}: lorem ipsum`).join('\\n');" +
        "require('node:fs').writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ artifacts: { draft: { content: lines, summary: '2000 lines' } } }));"
    ),
    producesAssessment: false,
    outputs: [{ name: 'draft', type: 'artifact', required: true }],
  })
  .addScript({
    id: 'check',
    name: 'Check the draft',
    command: 'node',
    args: node(
      "const fs = require('node:fs'); const text = fs.readFileSync(process.env.UA_INPUT_DRAFT, 'utf8');" +
        "const count = text.split('\\n').length;" +
        "fs.writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { lines: count }, assessment: { verdict: count <= 1000 ? 'PASS' : 'NEEDS_FIX', summary: count + ' lines received', findings: count <= 1000 ? [] : [{ id: 'long', severity: 'minor', message: 'Draft has ' + count + ' lines; keep it under 1000' }] } }));"
    ),
    inputs: [{ name: 'draft', type: 'artifact', required: true }],
    outputs: [{ name: 'lines', type: 'number', required: true }],
  })
  .connectData({ fromNodeId: 'draft', fromPort: 'draft', toNodeId: 'check', toPort: 'draft', withControl: true })
  .buildDefinition();

const home = resolveUniversalAgentHome(values.home ? { homeDir: values.home } : {});
const db = openWorkflowDatabase(resolveWorkflowStoragePaths(home).databasePath);
try {
  const registry = new SqliteAgentRegistry({ db });
  for (const agent of AGENTS) {
    try {
      const { created } = registry.register(agent);
      process.stdout.write(`agent    ${agent.id.padEnd(22)} ${created ? 'registered' : 'unchanged'}\n`);
    } catch {
      const existingVersions = registry.listVersions(agent.id);
      const latestProfile = await registry.resolve(agent.id);
      if (latestProfile?.runtime?.agentType === agent.runtime.agentType) {
        process.stdout.write(`agent    ${agent.id.padEnd(22)} unchanged (${latestProfile.version})\n`);
      } else {
        const nextVersion = String(existingVersions.length + 1);
        registry.register({ ...agent, version: nextVersion });
        process.stdout.write(`agent    ${agent.id.padEnd(22)} updated -> v${nextVersion} (${agent.runtime.agentType})\n`);
      }
    }
  }
  const library = new WorkflowLibrary({ db });
  for (const definition of [quickAnswer, scriptsOnly, haikuLoop, parallelDigest, approvalGate, twoWorkspaces, scriptHandoff]) {
    const record = library.save(definition, { mode: 'upsert' });
    process.stdout.write(`workflow ${record.id.padEnd(22)} ${record.name} (${record.versions.length} version${record.versions.length === 1 ? '' : 's'})\n`);
  }
  process.stdout.write(`\nSeeded into ${home}\n`);
} finally {
  db.$client.close();
}
