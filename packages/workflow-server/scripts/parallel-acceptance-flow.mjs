import { createHash } from 'node:crypto';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { buildAcceptanceFlows } from './acceptance-flow.mjs';

const port = (name, type) => ({ name, type, required: true });
const parallel = itemsPort => ({ itemsPort, maxConcurrency: 2, failurePolicy: 'settle_all' });
const script = (id, source, extra) => ({ kind: 'script', id, name: id, command: process.execPath, args: ['--input-type=module', '-e', source], writeScopes: [], maxTechnicalRetries: 0, timeoutMs: 60_000, producesAssessment: false, ...extra });

/** Real-engine rehearsal of all three node properties. Only alpha needs Chief repair;
 * beta must keep its successful attempt while alpha and its downstream checks are redone. */
export function buildParallelAcceptanceFlows(options) {
  const { child, agents, parent: previous } = buildAcceptanceFlows(options);
  const worker = agents[0], chief = agents[1];
  worker.instructions = ['Do not delegate.', 'Only write src/alpha.mjs or src/beta.mjs, exactly as selected by this invocation’s case input. Never modify protected.txt or tests.', 'Return exactly the requested ua-workflow-result block.'];
  chief.instructions = [
    'Do not delegate or edit files. Read the implementation and diagnostic artifacts with the ua-workflow MCP tool.',
    'For loop.round_needs_fix, find the latest non-stale NEEDS_FIX verify assessment and its exact attempt scopeKey. Inject guidance for implement in that EXACT scopeKey, then rerun_from_node implement in the same scope. Tell it to replace subtraction with addition in the case-specific src file.',
    'Only alpha is intentionally broken. Do not rerun beta, a whole sub-flow, the verifier alone, or change acceptance criteria. Never omit scopeKey from a repair command.',
    'The SDK supports rerun_from_node in an earlier loop round: it discards later rounds, reopens ancestors and revalidates downstream consumers. Use the supplied run snapshot and MCP artifact tools only; do not inspect repository code, the filesystem, or previous acceptance runs.',
  ];
  for (const agent of agents) { agent.version = '1'; agent.version = createHash('sha256').update(JSON.stringify(agent)).digest('hex').slice(0, 12); }
  child.name = 'Acceptance · Per-item repair sub-flow';
  child.inputs.push(port('case', 'string'));
  const implement = child.graph.nodes.find(n => n.id === 'implement');
  implement.agentRef = `${worker.id}@${worker.version}`;
  implement.isolation = 'auto';
  implement.inputs.push(port('case', 'string'));
  implement.goal = [
    'This is a controlled integration rehearsal. Read the spec artifact using ua-workflow read_artifact. Read the case input (alpha or beta). Your ONLY writable target is src/<case>.mjs, e.g. src/alpha.mjs for alpha.',
    'On alpha with NO Chief Guidance, intentionally write: export const add = (a, b) => a - b; . This initial defect is a test fixture and must reach independent verification.',
    'On beta, or on alpha WITH Chief Guidance, write: export const add = (a, b) => a + b; . Do not touch the other case’s file, protected.txt, tests or criteria.',
    'Use native file tools, request tool-level write approval if needed, read the exact file back, and publish its contents as implementation (mediaType text/javascript).',
    'Return a ua-workflow-result JSON block: {"artifacts":{"implementation":{"content":"<exact file contents>","mediaType":"text/javascript"}}}.',
  ].join('\n');
  const verify = child.graph.nodes.find(n => n.id === 'verify');
  verify.inputs.push(port('case', 'string'));
  verify.args[2] = verify.args[2]
    .replace("const code =", "const caseName = readFileSync(process.env.UA_INPUT_CASE, 'utf8');\nconst target = 'src/' + caseName + '.mjs';\nconst code =")
    .replaceAll("'src/add.mjs'", 'target')
    .replace('const report = { passed,', 'const report = { case: caseName, passed,');
  for (const target of ['implement', 'verify']) child.graph.dataEdges.push({ id: `case-to-${target}`, fromNodeId: '$input', fromPort: 'case', toNodeId: target, toPort: 'case', required: true, delivery: 'auto' });

  const probe = previous.graph.nodes.find(n => n.id === 'permission_probe');
  probe.agentRef = `${worker.id}@${worker.version}`;
  probe.parallel = parallel('case');
  probe.inputs = [port('case', 'string')];
  const prepare = script('prepare', String.raw`
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('src', {recursive:true});
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({outputs:{cases:['alpha','beta']},artifacts:{spec:{content:'Each case exports add(a,b) returning a+b in src/<case>.mjs. Tests: (2,3)=5, (-2,3)=1, (0,0)=0, (1.5,2.5)=4. Alpha initially subtracts to exercise Chief repair. Beta must pass immediately. Never change protected.txt or test criteria.',mediaType:'text/plain'}}}));
`, { writeScopes: ['src'], inputs: [], outputs: [port('cases', 'array'), port('spec', 'artifact')] });
  const audit = script('audit', String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.env.UA_INPUT_REPORT, 'utf8'));
if (!report.passed || report.cases !== 4) throw new Error('Invalid per-item report');
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({outputs:{label:report.case,checked:report.passed},assessment:{verdict:'PASS',summary:'Item report independently checked'}}));
`, { producesAssessment: true, parallel: parallel('report'), inputs: [port('report', 'json')], outputs: [port('label', 'string'), port('checked', 'boolean')] });
  const finish = script('finish', String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const input = key => JSON.parse(readFileSync(process.env['UA_INPUT_'+key], 'utf8'));
const reports = input('REPORT'), labels = input('LABEL'), checked = input('CHECKED'), denied = input('PERMISSIONCHECKED');
assert.deepEqual(labels, ['alpha','beta']); assert.deepEqual(checked, [true,true]); assert.deepEqual(denied, [true,true]);
assert.equal(reports.length, 2); assert.ok(reports.every(r => r.passed && r.cases === 4));
assert.equal(readFileSync('protected.txt','utf8'), 'DO NOT CHANGE\n');
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({outputs:{report:{passed:true,cases:8,items:reports,labels,checked}},assessment:{verdict:'PASS',summary:'Both items passed, with complete ordered output aggregation'}}));
`, { producesAssessment: true, inputs: [port('report', 'array'), port('label', 'array'), port('checked', 'array'), port('permissionChecked', 'array')], outputs: [port('report', 'json')] });
  const parent = createWorkflowBuilder(options.id, 'Acceptance · Per-node parallel execution')
    .setDescription('Agent, Script and Sub-flow parallel attributes; per-item retries, permissions, Conversation, condition and scoped Chief repair.')
    .setChief({ agentRef: `${chief.id}@${chief.version}`, triggers: ['loop.round_needs_fix', 'node.failed'], maxLevel: 'operate', maxInterventionsPerRun: 3 })
    .addWorkspace({ name: 'test', description: 'Isolated parallel acceptance workspace' }).addWorkflowOutput(port('report', 'json'))
    .addNode(prepare).addNode(probe)
    .addSubflow({ id: 'repair', name: 'Repair each case', workflowId: child.id, parallel: parallel('case'), inputs: child.inputs, outputs: child.outputs })
    .addNode(audit).addNode(finish)
    .connectData({ fromNodeId: 'prepare', fromPort: 'cases', toNodeId: 'permission_probe', toPort: 'case', withControl: true })
    .connectControl('permission_probe', 'repair')
    .connectData({ fromNodeId: 'prepare', fromPort: 'cases', toNodeId: 'repair', toPort: 'case' })
    .connectData({ fromNodeId: 'prepare', fromPort: 'spec', toNodeId: 'repair', toPort: 'spec', delivery: 'artifact_ref' })
    .connectData({ fromNodeId: 'repair', fromPort: 'report', toNodeId: 'audit', toPort: 'report', withControl: true })
    .connectData({ fromNodeId: 'repair', fromPort: 'report', toNodeId: 'finish', toPort: 'report' })
    .connectControl('audit', 'finish', { kind: 'verdict_is', verdict: 'PASS' })
    .connectData({ fromNodeId: 'audit', fromPort: 'label', toNodeId: 'finish', toPort: 'label' })
    .connectData({ fromNodeId: 'audit', fromPort: 'checked', toNodeId: 'finish', toPort: 'checked' })
    .connectData({ fromNodeId: 'permission_probe', fromPort: 'checked', toNodeId: 'finish', toPort: 'permissionChecked' })
    .connectData({ fromNodeId: 'finish', fromPort: 'report', toNodeId: '$output', toPort: 'report' }).buildDefinition();
  return { parent, child, agents };
}
