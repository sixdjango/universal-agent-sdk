#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAgentWorkflowRuntime } from '@universal-agent/workflow-agents';
import { validateWorkflowDefinition } from '@universal-agent/workflow-contract';
import {
  ArtifactToolHost, listWorkflowConversations, openWorkflowDatabase, resolveUniversalAgentHome,
  resolveWorkflowStoragePaths, SqliteConversationStore, UniversalAgentExecutor, WorkflowHost,
} from '@universal-agent/workflow-node';
import { buildAcceptanceFlows } from './acceptance-flow.mjs';
import { buildParallelAcceptanceFlows } from './parallel-acceptance-flow.mjs';

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    parallel: { type: 'boolean', default: false }, home: { type: 'string' }, engine: { type: 'string', default: 'deepseek' }, model: { type: 'string' },
    mode: { type: 'string', default: 'read-only' }, id: { type: 'string', default: 'test-full-acceptance' },
    'server-url': { type: 'string', default: 'http://127.0.0.1:4317' },
    'timeout-ms': { type: 'string', default: '900000' },
  },
});
const timeoutMs = Number(values['timeout-ms']);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, '--timeout-ms must be a positive integer');
const definitions = (values.parallel ? buildParallelAcceptanceFlows : buildAcceptanceFlows)({ id: values.parallel && values.id === 'test-full-acceptance' ? 'test-parallel-acceptance' : values.id, engine: values.engine, modelId: values.model, modeId: values.mode });
for (const definition of [definitions.child, definitions.parent]) {
  const valid = validateWorkflowDefinition(definition);
  assert.ok(valid.ok, JSON.stringify(valid.issues));
}
const homeDir = resolveUniversalAgentHome({ homeDir: values.home });
const paths = resolveWorkflowStoragePaths(homeDir);
const root = join(paths.rootDir, 'acceptance');
await mkdir(root, { recursive: true });
const workdir = await mkdtemp(join(root, 'full-'));
await writeFile(join(workdir, 'protected.txt'), 'DO NOT CHANGE\n');
execFileSync('git', ['init', '-q', '-b', 'main', workdir]);
execFileSync('git', ['-C', workdir, 'add', 'protected.txt']);
execFileSync('git', ['-C', workdir, '-c', 'user.name=Workflow Acceptance', '-c', 'user.email=acceptance@localhost', 'commit', '-q', '-m', 'Acceptance fixture']);
const db = openWorkflowDatabase(paths.databasePath);
const conversations = new SqliteConversationStore({ db });
const tools = new ArtifactToolHost();
let host;
let runId;
const faultScopes = new Set();
let lastProgress = '';
const live = new UniversalAgentExecutor({
  workdir, conversationStore: conversations, artifactTools: tools,
});
// One real ACP process exits before initialization. The normal Executor must record the
// failed Conversation; the existing Flow technical-retry loop then calls the live engine.
// This is a host-injected fault, never a fake successful Agent, tool call or Chief decision.
const brokenStartup = new UniversalAgentExecutor({
  workdir, conversationStore: conversations, artifactTools: false,
  roleBindings: { implement: { target: {
    cliType: 'custom', agentType: 'acceptance-startup-fault', command: process.execPath,
    args: ['-e', 'process.stderr.write("INJECTED_ACCEPTANCE_STARTUP_FAILURE\\n"); process.exit(75)'],
  } } },
});
try {
  const { runtime } = createAgentWorkflowRuntime({
    db, workdir, agents: definitions.agents, artifactTools: tools, conversationStore: conversations,
    adapters: { acp: { executeAgent(request) {
      if (request.node.id === 'implement' && !faultScopes.has(request.scopeKey)) {
        faultScopes.add(request.scopeKey);
        console.log(JSON.stringify({ event: 'inject_startup_failure', attemptId: request.attemptId, retryIndex: request.retryIndex }));
        return brokenStartup.executeAgent(request);
      }
      return live.executeAgent(request);
    } } },
    chiefOptions: { allowedCommands: ['report', 'inject_guidance', 'rerun_from_node', 'retry_node', 'escalate'] },
  });
  host = await WorkflowHost.open({ runtime, db, workdir, worktreesDir: paths.worktreesDir });
  for (const definition of [definitions.child, definitions.parent]) host.library.save(definition, { mode: 'upsert' });
  const started = await host.startRun({ workflowId: definitions.parent.id, workspaces: { test: host.defaultWorkspace.id } });
  runId = started.runId;
  const url = `${values['server-url']}/#/w/${definitions.parent.id}?run=${runId}`;
  await writeFile(join(workdir, 'invocation.json'), JSON.stringify({ runId, url, workdir, engine: values.engine }, null, 2));
  console.log(JSON.stringify({ event: 'started', runId, url, workdir }));
  const deadline = Date.now() + timeoutMs;
  let done;
  let eventIndex = 0;
  while (Date.now() < deadline) {
    const state = await host.runs.get(runId);
    for (const event of state.events.slice(eventIndex)) {
      if (['node.completed', 'chief.intervened', 'loop.round.advanced', 'run.completed'].includes(event.type)) console.log(JSON.stringify(event));
    }
    eventIndex = state.events.length;
    const progress = runtime.getLiveProgress(runId).map(p => ({ nodeId: p.nodeId, scopeKey: p.scopeKey, steps: p.steps.filter(s => s.status === 'running').map(s => s.label) }));
    const key = JSON.stringify(progress);
    if (key !== lastProgress) { console.log(JSON.stringify({ event: 'progress', items: progress })); lastProgress = key; }
    if (!host.runs.isActive(runId)) { done = state; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!done) throw new Error(`Run ${runId} did not settle in ${timeoutMs} ms`);
  await writeFile(join(workdir, 'run.json'), JSON.stringify(done, null, 2));
  const records = await listWorkflowConversations(conversations, { runId, limit: 1000 });
  const histories = [];
  for (const record of records) {
    const turns = (await conversations.listTurns(record.id, { limit: 1000 })).items;
    const events = [];
    let after;
    do {
      const page = await conversations.readEvents(record.id, { after, limit: 1000 });
      events.push(...page.items);
      after = page.nextCursor;
    } while (after !== undefined);
    histories.push({ record, turns, events });
  }
  await writeFile(join(workdir, 'conversations.json'), JSON.stringify(histories, null, 2));
  const workers = histories.filter(h => h.record.source.identifiers.nodeId === 'implement');
  const chief = histories.filter(h => h.record.source.identifiers.nodeId === '$chief');
  const updates = histories.flatMap(h => h.events.filter(e => e.data.type === 'acp.update').map(e => e.data.notification.update));
  const permissions = histories.flatMap(h => h.turns.flatMap(t => t.permissions));
  const permissionKind = p => p.response?.outcome.outcome === 'selected'
    ? p.request.options.find(o => o.optionId === p.response.outcome.optionId)?.kind : undefined;
  const permissionDecisions = histories.flatMap(h => h.turns.flatMap(t => t.permissions.map(p => ({
    nodeId: h.record.source.identifiers.nodeId, scopeKey: h.record.source.identifiers.scopeKey, toolCallId: p.request.toolCall.toolCallId,
    kind: p.request.toolCall.kind, title: p.request.toolCall.title, decision: permissionKind(p),
  }))));
  const interventions = done.events.filter(e => e.type === 'chief.intervened');
  const applied = interventions.flatMap(e => e.applied);
  const assessments = Object.values(done.assessments).filter(a => a.nodeId === 'verify');
  const attempts = Object.values(done.attempts).filter(a => a.nodeId === 'implement');
  const report = {
    runId, url, workdir, engine: values.engine, status: done.status, outputs: done.outputs,
    checks: {
      succeeded: done.status === 'SUCCEEDED' && done.outputs.report?.passed === true,
      subflow: done.definition.graph.nodes.some(n => n.id === 'repair' && n.snapshot?.workflowId === definitions.child.id),
      failedConversation: workers.some(h => h.record.source.identifiers.retryIndex === '0' && h.turns.some(t => t.status === 'failed')),
      technicalRetry: workers.some(h => h.record.source.identifiers.retryIndex === '1' && h.turns.some(t => t.status === 'completed')),
      realAgentSessions: workers.filter(h => h.record.nativeSessionId && h.turns.some(t => t.status === 'completed')).length >= 2,
      tools: updates.some(u => u.sessionUpdate === 'tool_call') && updates.some(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed'),
      permissionAllowed: permissions.some(p => permissionKind(p) === 'allow_once'),
      permissionDenied: permissionDecisions.some(p => p.nodeId === 'permission_probe' && p.decision === 'reject_once'),
      protectedFile: await readFile(join(workdir, 'protected.txt'), 'utf8') === 'DO NOT CHANGE\n',
      conditionBranches: done.events.some(e => e.type === 'loop.round.advanced' && e.roundIndex > 0)
        && Object.values(done.scopes).some(s => s.nodes.verify?.latestVerdict === 'PASS'),
      chiefSession: chief.some(h => h.record.nativeSessionId && h.turns.some(t => t.status === 'completed')),
      chiefReadArtifact: done.readReceipts.some(r => Object.values(done.manifests).some(m => m.nodeId === '$chief' && m.attemptId === r.attemptId)),
      chiefGuidance: applied.some(c => c.kind === 'inject_guidance' && c.nodeId === 'implement'),
      chiefRerun: applied.some(c => c.kind === 'rerun_from_node' && c.nodeId === 'implement'),
      repairedSameNode: values.parallel
        ? attempts.filter(a => a.scopeKey.includes('/repair[0]/')).length === 2 && attempts.filter(a => a.scopeKey.includes('/repair[1]/')).length === 1
        : attempts.length >= 2 && attempts.every(a => a.scopeKey === attempts[0].scopeKey),
      reverified: assessments.some(a => a.verdict === 'NEEDS_FIX' && a.stale) && assessments.some(a => a.verdict === 'PASS' && !a.stale),
      cleanCommands: interventions.every(e => e.rejected.length === 0),
      ...(values.parallel ? {
        allThreeProperties: ['permission_probe', 'repair', 'audit'].every(id => done.definition.graph.nodes.find(n => n.id === id)?.parallel) && !done.definition.graph.nodes.some(n => n.kind === 'parallel'),
        bothItemsRetried: [0,1].every(i => workers.some(h => h.record.source.identifiers.scopeKey.includes('/repair['+i+']/') && h.record.source.identifiers.retryIndex === '0' && h.turns.some(t => t.status === 'failed')) && workers.some(h => h.record.source.identifiers.scopeKey.includes('/repair['+i+']/') && h.record.source.identifiers.retryIndex === '1' && h.turns.some(t => t.status === 'completed'))),
        itemPermissions: [0,1].every(i => permissionDecisions.some(p => p.scopeKey === '$root/permission_probe['+i+']' && p.decision === 'reject_once') && permissionDecisions.some(p => p.scopeKey.includes('/repair['+i+']/') && p.decision === 'allow_once')),
        completeOutputs: JSON.stringify(done.scopes.$root.nodes.audit.outputs) === JSON.stringify({ label: { value: ['alpha','beta'] }, checked: { value: [true,true] } }),
        scopedChiefRepair: applied.filter(c => ['inject_guidance','rerun_from_node'].includes(c.kind)).length >= 2 && applied.filter(c => ['inject_guidance','rerun_from_node'].includes(c.kind)).every(c => c.scopeKey?.includes('/repair[0]/')),
        siblingPreserved: attempts.filter(a => a.scopeKey.includes('/repair[1]/')).length === 1,
        aggregateCondition: done.scopes.$root.nodes.audit.latestVerdict === 'PASS' && done.scopes.$root.nodes.finish.status === 'SUCCEEDED',
        allItemsSuccessful: ['permission_probe', 'repair', 'audit'].every(id => done.scopes.$root.nodes[id].parallelItems?.length === 2 && done.scopes.$root.nodes[id].parallelItems.every(i => i.status === 'SUCCEEDED')),
      } : {}),
    },
    conversations: histories.map(h => ({ id: h.record.id, source: h.record.source.identifiers, sessionId: h.record.nativeSessionId, turns: h.turns.map(t => ({ status: t.status, error: t.error, permissions: t.permissions.length })) })),
    permissionDecisions,
    interventions,
    assessments,
    readReceipts: done.readReceipts.length,
    attempts: attempts.map(a => ({ attemptId: a.attemptId, retryIndex: a.retryIndex, scopeKey: a.scopeKey, status: a.status })),
  };
  await writeFile(join(workdir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: 'acceptance', runId, checks: report.checks, report: join(workdir, 'result.json') }));
  const failed = Object.entries(report.checks).filter(([, passed]) => !passed).map(([name]) => name);
  assert.deepEqual(failed, [], `Acceptance checks failed: ${failed.join(', ')}`);
} catch (error) {
  console.error(JSON.stringify({ event: 'acceptance_failed', runId, workdir, message: error.message }));
  process.exitCode = 1;
} finally {
  await host?.close();
  await tools.close();
  db.$client.close();
}
