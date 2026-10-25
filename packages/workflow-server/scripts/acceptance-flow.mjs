import { createHash } from 'node:crypto';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';

const port = (name, type) => ({ name, type, required: true });
const script = (id, name, source, extra = {}) => ({ id, name, command: process.execPath, args: ['--input-type=module', '-e', source], ...extra });

/** Current graph contract: a parent flow, a saved sub-flow, and a condition-driven repair loop. */
export function buildAcceptanceFlows({ id, engine, modelId, modeId = 'read-only' }) {
  const childId = `${id}-repair`;
  const workerId = `${id}-worker`;
  const chiefId = `${id}-chief`;
  const runtime = { adapter: 'acp', agentType: engine, modeId, ...(modelId ? { modelId } : {}) };
  const agents = [
    {
      id: workerId, version: '1', name: 'Acceptance worker', runtime,
      charter: 'Execute this explicitly staged integration rehearsal. Use real tools, respect denied permissions, and repair your own work when the Chief supplies guidance.',
      instructions: ['Do not delegate to another agent.', 'Only write src/add.mjs. Never change test criteria or protected.txt.', 'Return exactly the requested ua-workflow-result JSON block.'],
    },
    {
      id: chiefId, version: '1', name: 'Acceptance Chief', runtime,
      charter: 'Diagnose the failed acceptance check from recorded artifacts and guide the original implement node to repair it. Never edit files yourself.',
      instructions: [
        'Do not delegate to another agent. Use the ua-workflow MCP read_artifact tool to inspect the implementation and diagnostic artifacts before deciding.',
        'For loop.round_needs_fix: find the latest NEEDS_FIX verify assessment, and its exact attempt scope. Return inject_guidance for node implement (without scopeKey) explaining that add(a,b) must return a+b, followed by rerun_from_node for implement in that failed assessment scope. This reruns the original producer and its independent checks.',
        'Do not rerun the condition or verifier alone, do not extend the loop, and do not modify criteria or workspace files. The initial a-b implementation is a deliberate rehearsal fixture, not a changed requirement.',
      ],
    },
  ];
  for (const agent of agents) agent.version = createHash('sha256').update(JSON.stringify(agent)).digest('hex').slice(0,12);
  const child = createWorkflowBuilder(childId, 'Acceptance · Repair sub-flow')
    .setDescription('Real Agent → deterministic check → condition; Chief guides the original producer and rechecks it.')
    .addWorkflowInput(port('spec', 'artifact'))
    .addWorkflowOutput(port('report', 'json'))
    .addAgent({
      id: 'implement', name: 'Implement / repair add', role: 'author', agentRef: `${workerId}@${agents[0].version}`,
      writeScopes: ['src'], enforceWriteScopes: true, isolation: 'shared', maxTechnicalRetries: 1,
      inputs: [port('spec', 'artifact')], outputs: [port('implementation', 'artifact')],
      goal: [
        'This is a staged integration test in a disposable workspace. Read spec via the ua-workflow read_artifact MCP tool, even though it is short.',
        'If no Chief Guidance is present: create src/add.mjs containing exactly: export const add = (a, b) => a - b; . This deliberate initial defect exercises independent validation and Chief repair; do not correct it during the initial turn.',
        'If Chief Guidance is present: follow it and fix src/add.mjs so add(a,b) returns a+b. Never write or request a write to protected.txt; a separate read-only node checks that boundary.',
        'Use real file tools to write src/add.mjs, then read it back. Publish its exact contents as the implementation artifact, mediaType text/javascript.',
        'Respond with ```ua-workflow-result followed by JSON {"artifacts":{"implementation":{"content":"<exact file contents>","mediaType":"text/javascript"}}} and the closing fence. Do not fabricate tool results.',
      ].join('\n'),
      acceptanceCriteria: ['The final repaired implementation passes all independent addition tests.', 'protected.txt stays unchanged; every write is confined to src.'],
    })
    .addScript(script('verify', 'Independent addition tests', String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const code = readFileSync(process.env.UA_INPUT_IMPLEMENTATION, 'utf8');
const onDisk = readFileSync('src/add.mjs', 'utf8');
const cases = [[2,3,5],[-2,3,1],[0,0,0],[1.5,2.5,4]];
const findings = [];
if (code !== onDisk) findings.push('Published implementation differs from src/add.mjs');
try {
  const { add } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  for (const [a,b,expected] of cases) if (add(a,b) !== expected) findings.push('add('+a+','+b+') expected '+expected+', got '+add(a,b));
} catch (error) { findings.push(error.message); }
if (readFileSync('protected.txt','utf8') !== 'DO NOT CHANGE\n') findings.push('Protected fixture was modified');
const passed = findings.length === 0;
const report = { passed, cases: cases.length, findings };
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({
  outputs: { passed, report }, artifacts: { diagnostic: { content: JSON.stringify(report), mediaType: 'application/json' } },
  assessment: { verdict: passed ? 'PASS' : 'NEEDS_FIX', summary: passed ? 'All addition tests pass' : findings.join('; '),
    findings: findings.map((message, i) => ({ id: 'case-'+i, severity: 'major', message, filePath: 'src/add.mjs' })) }
}));
console.log(JSON.stringify(report));
`, { inputs: [port('implementation', 'artifact')], outputs: [port('passed', 'boolean'), port('report', 'json'), port('diagnostic', 'artifact')] }))
    .addScript(script('accepted', 'Return verified sub-flow result', String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.env.UA_INPUT_REPORT, 'utf8'));
if (!report.passed) throw new Error('Cannot accept a failed report');
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { report } }));
`, { producesAssessment: false, inputs: [port('report', 'json')], outputs: [port('report', 'json')] }))
    .connectData({ fromNodeId: '$input', fromPort: 'spec', toNodeId: 'implement', toPort: 'spec', delivery: 'artifact_ref' })
    .connectData({ fromNodeId: 'implement', fromPort: 'implementation', toNodeId: 'verify', toPort: 'implementation', withControl: true })
    .loopBack('verify', 'implement', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 3, onExhausted: 'fail' })
    .connectControl('verify', 'accepted', { kind: 'verdict_is', verdict: 'PASS' })
    .connectData({ fromNodeId: 'verify', fromPort: 'report', toNodeId: 'accepted', toPort: 'report' })
    .connectData({ fromNodeId: 'accepted', fromPort: 'report', toNodeId: '$output', toPort: 'report' })
    .buildDefinition();

  const parent = createWorkflowBuilder(id, 'Acceptance · Agent, permissions, retry & Chief')
    .setDescription('Live ACP integration rehearsal: startup failure/retry, real tool approvals, sub-flow, condition, Chief repair, and final independent validation.')
    .setChief({ agentRef: `${chiefId}@${agents[1].version}`, triggers: ['loop.round_needs_fix', 'node.failed'], maxLevel: 'operate', maxInterventionsPerRun: 3 })
    .addWorkspace({ name: 'test', description: 'Isolated acceptance workspace' })
    .addWorkflowOutput(port('report', 'json'))
    .addScript(script('prepare', 'Prepare controlled regression', String.raw`
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
mkdirSync('src', {recursive:true});
rmSync('src/add.mjs', {force:true});
const spec = 'Implement export const add = (a,b) => a+b in src/add.mjs. Independent cases: (2,3)=5; (-2,3)=1; (0,0)=0; (1.5,2.5)=4. Never modify protected.txt. Initial a-b is an intentional fixture for the Chief repair rehearsal.';
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({artifacts:{spec:{content:spec,mediaType:'text/plain'}}}));
`, { writeScopes: ['src'], producesAssessment: false, outputs: [port('spec', 'artifact')] }))
    .addAgent({
      id: 'permission_probe', name: 'Check SDK read-only permission', role: 'tester', agentRef: `${workerId}@${agents[0].version}`,
      writeScopes: [], outputs: [port('checked', 'boolean')],
      goal: [
        'This node has writeScopes: []. Verify the SDK refuses its file-write permission request in this disposable test workspace.',
        'Read protected.txt, then make ONE native write request to change it to CHANGED. For DeepSeek include sandbox_permissions="workspace-write" and justification="Verify the SDK rejects writes by this read-only node" in that first tool call, so it reaches the ACP callback. The SDK must reject it.',
        'Accept the rejection. Never retry, use a shell workaround, change the session mode, or modify any other file. Read protected.txt again to confirm it still contains DO NOT CHANGE.',
        'Only if the request was denied and the file stayed unchanged, return ```ua-workflow-result with {"outputs":{"checked":true}}. Otherwise return {"outputs":{"checked":false}} in that block.',
      ].join('\n'),
    })
    .addSubflow({ id: 'repair', name: 'Agent repair sub-flow', workflowId: childId, inputs: [port('spec', 'artifact')], outputs: [port('report', 'json')] })
    .addScript(script('finish', 'Verify parent receives the result', String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const report = JSON.parse(readFileSync(process.env.UA_INPUT_REPORT, 'utf8'));
assert.equal(report.passed, true);
assert.equal(report.cases, 4);
assert.equal(JSON.parse(readFileSync(process.env.UA_INPUT_PERMISSIONCHECKED, 'utf8')), true);
assert.equal(readFileSync('protected.txt','utf8'), 'DO NOT CHANGE\n');
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({outputs:{report}, assessment:{verdict:'PASS',summary:'Parent received the verified sub-flow result'}}));
`, { inputs: [port('report', 'json'), port('permissionChecked', 'boolean')], outputs: [port('report', 'json')] }))
    .connectControl('prepare', 'permission_probe')
    .connectControl('permission_probe', 'repair')
    .connectData({ fromNodeId: 'prepare', fromPort: 'spec', toNodeId: 'repair', toPort: 'spec' })
    .connectData({ fromNodeId: 'repair', fromPort: 'report', toNodeId: 'finish', toPort: 'report', withControl: true })
    .connectData({ fromNodeId: 'permission_probe', fromPort: 'checked', toNodeId: 'finish', toPort: 'permissionChecked' })
    .connectData({ fromNodeId: 'finish', fromPort: 'report', toNodeId: '$output', toPort: 'report' })
    .buildDefinition();
  return { parent, child, agents };
}
