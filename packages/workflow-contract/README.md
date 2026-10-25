# @universal-agent/workflow-contract

The workflow definition format for the Universal Agent workflow kit: a zod schema for workflows, a fluent builder, edge conditions, and a compiler that validates a definition and turns it into an executable plan. No Node.js APIs — it runs in browsers too.

```bash
npm install @universal-agent/workflow-contract
```

## Build a workflow

```ts
import { createWorkflowBuilder, validateWorkflowDefinition } from '@universal-agent/workflow-contract';

const definition = createWorkflowBuilder('write-and-review', 'Write and review')
  .addWorkflowInput({ name: 'topic', type: 'string', required: true })
  .addWorkflowOutput({ name: 'draft', type: 'artifact', required: true })
  .addAgent({
    id: 'write', name: 'Write', role: 'writer', agentRef: 'writer',
    goal: 'Write a short article about the topic.',
    acceptanceCriteria: ['under 500 words', 'cites at least one source'],
    inputs: [{ name: 'topic', type: 'string', required: true }, { name: 'previous', type: 'artifact', required: false }],
    outputs: [{ name: 'draft', type: 'artifact', required: true }],
  })
  .addAgent({
    id: 'review', name: 'Review', role: 'reviewer', agentRef: 'critic', producesAssessment: true,
    goal: 'Check the draft against the acceptance criteria.',
    inputs: [{ name: 'draft', type: 'artifact', required: true }],
  })
  .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'write', toPort: 'topic' })
  .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
  .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'write', toPort: 'previous' }) // last round's draft
  .loopBack('review', 'write', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 3, onExhausted: 'pass_with_findings' })
  .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: '$output', toPort: 'draft' })
  .setChief({})
  .buildDefinition();

const result = validateWorkflowDefinition(definition);
if (!result.ok) console.error(result.issues); // [{ code, message, nodeId?, edgeId?, scopePath }]
```

A definition is plain JSON (`WorkflowDefinition`); you can also generate it from any language and validate it with `WorkflowDefinitionSchema` / `validateWorkflowDefinition`.

## The definition

| Field | Meaning |
|---|---|
| `id`, `name`, `version`, `description` | Identity |
| `inputs`, `outputs` | Workflow ports (`{ name, type, required, description?, defaultValue? }`); types: `string`, `number`, `boolean`, `json`, `array`, `artifact`, `assessment` |
| `graph` | `{ nodes, controlEdges, dataEdges }`; `$input` / `$output` stand for the workflow's (or a container's) inputs and outputs |
| `workspaces` | Workspace slots bound to directories when a run starts: `{ name, description?, required?, mergeCheck? }` |
| `defaultWorkspace` | Slot for steps that name none (default: the first) |
| `chief` | Supervisor policy (`ChiefPolicySchema`); absent means no supervision |

### Steps

Every step has `id`, `name`, `inputs`, `outputs`, `writeScopes`, `maxTechnicalRetries`, and optionally `workspace`, `isolation` (`auto` / `shared` / `worktree`) and `enforceWriteScopes`.

| Builder | Kind | Key fields |
|---|---|---|
| `addAgent` | `agent` | `goal`, `acceptanceCriteria`, `constraints`, `agentRef` or `role`, per-step `agentType` / `modelId` / `modeId` / `effort`, `producesAssessment`, `parallel` |
| `addScript` | `script` | `command`, `args`, `cwd`, `env`, `timeoutMs` (60 s), `producesAssessment` (**default `true`**: exit 0 = PASS, otherwise NEEDS_FIX), `parallel` |
| `addGate` | `gate` | `prompt`, `options`; the answer becomes its first output (default `decision`) |
| `addParallel` | `parallel` | `itemsPort`, `maxConcurrency`, `failurePolicy`, `itemBody` (inline sub-flow run for each item) |
| `addLoop` | `loop` | `maxRounds`, `continueWhen`, `onExhausted`, `body` (usually generated from a way-back edge instead) |
| `addSubflow` | `subflow` | `workflowId` of another saved workflow, `parallel` |

Inside a parallel container `$input.<itemsPort>` is the current item and `$input.itemIndex` its position; on a step, `parallel: { itemsPort }` means the same port takes the list on the graph and one item per execution.

### Edges

- `connectData({ fromNodeId, fromPort, toNodeId, toPort, required?, delivery?, withControl? })` — passes a value; `delivery` is `auto`, `inline` or `artifact_ref`; `withControl: true` also orders the two steps. A data edge that closes a cycle carries the previous round's value.
- `connectControl(from, to, when?)` — the second step runs after the first, when the condition holds.
- `loopBack(from, to, when, { maxRounds, onExhausted })` — a way back from a deciding step; compiles into a loop. `onExhausted`: `fail`, `gate` or `pass_with_findings`.

### Conditions (`EdgeCondition`)

| `kind` | Holds when |
|---|---|
| `always` (or none) | the source step succeeded |
| `verdict_is` / `verdict_in` | its verdict is `verdict` / one of `verdicts` |
| `port_equals` / `port_truthy` | output `port` equals `value` / is truthy |
| `port_compare` | output `port` `op` (`==` `!=` `>` `>=` `<` `<=`) `value`; `measure: 'length'` compares a list or text length; ordering a non-number never holds |
| `all` / `any` | every / some of `conditions` hold (nestable) |
| `otherwise` | no other conditional edge leaving the same step holds |

Each leaf reads the edge's source step unless it names `sourceNodeId`.

## Compiling

- `validateWorkflowDefinition(input)` → `{ ok: true, plan }` or `{ ok: false, issues }` (unknown steps or ports, cycles without a way back, bad conditions, overlapping loops, unknown workspace slots…).
- `compileWorkflowDefinition(input)` → the plan, or throws `WorkflowCompilationError`.
- The plan's `rootScope` lists steps in topological order with their conditions, write policies (which steps work isolated) and nested scopes for loops and parallel items.
- `resolveSubflows(definition, load)` embeds the workflows sub-flow steps run (hosts call it when a run starts).

## Also exported

- Agent profiles: `AgentProfileSchema`, `parseAgentRef`, `formatAgentRef`, `computeAgentDigest`.
- Chief: `ChiefPolicySchema`, `ChiefCommandSchema`, `CHIEF_COMMAND_LEVEL`, `defaultChiefProfile`.
- Patterns: `createSingleTaskFlow`, `createAuthorReviewerFlow`, `createBoundedFixLoopFlow`, `createParallelFanOutFlow`, `createSerializedWriterReverifyFlow`, `createHumanDecisionGateFlow`.
- Helpers: `edgeConditionSources`, `nodeBoundaryPorts`, `analyzeLoopBacks`, `computeDefinitionDigest`, `toCanonicalJson`.

## Related

Run definitions with [`@universal-agent/workflow-runtime`](../workflow-runtime) (any environment) or [`@universal-agent/workflow-node`](../workflow-node) (Node.js). Concepts in depth: [workflow guide](../../docs/workflow-guide.md).

## License

MIT
