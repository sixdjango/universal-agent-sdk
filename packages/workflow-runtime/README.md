# @universal-agent/workflow-runtime

The scheduler and runtime of the Universal Agent workflow kit. It executes a workflow definition step by step — branches, review-driven loops, parallel items, human waits, Chief supervision — and records every change in an append-only run log. Storage, execution and workspaces are ports you can plug, so it runs anywhere: Node.js, browsers, tests. For a ready Node.js host (SQLite, real agents, git isolation) use [`@universal-agent/workflow-node`](../workflow-node).

```bash
npm install @universal-agent/workflow-runtime @universal-agent/workflow-contract
```

## Quick start

```ts
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createWorkflowRuntime } from '@universal-agent/workflow-runtime';

const runtime = createWorkflowRuntime({
  executor: {
    async executeAgent(req) {
      if (req.node.id === 'review') return { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'Good' } };
      return { status: 'COMPLETED', outputs: { draft: `About ${req.inputs.topic}` } };
    },
    async executeScript() {
      throw new Error('no scripts in this example');
    },
  },
});

const definition = createWorkflowBuilder('demo')
  .addWorkflowInput({ name: 'topic', type: 'string', required: true })
  .addAgent({ id: 'write', name: 'Write', role: 'writer', goal: 'Write', inputs: [{ name: 'topic', type: 'string', required: true }], outputs: [{ name: 'draft', type: 'string', required: true }] })
  .addAgent({ id: 'review', name: 'Review', role: 'reviewer', goal: 'Review', producesAssessment: true, inputs: [{ name: 'draft', type: 'string', required: true }] })
  .connectData({ fromNodeId: '$input', fromPort: 'topic', toNodeId: 'write', toPort: 'topic' })
  .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
  .loopBack('review', 'write', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2 })
  .buildDefinition();

const { runId } = await runtime.start({ definition, inputs: { topic: 'tides' } });
const done = await runtime.runUntilSettled(runId);
console.log(done.status); // SUCCEEDED
```

## What it does

- **Scheduling**: a step runs when all its control predecessors have settled and at least one incoming edge is active; steps whose edges are all inactive are skipped, downstream too. Independent steps run concurrently; steps with overlapping write scopes queue.
- **Context bundles**: each agent step gets a frozen manifest of its inputs (inline values or artifact references within a context budget), its goal, criteria, constraints, workspace, guidance and the previous loop round's feedback, rendered into a prompt with an output contract.
- **Loops and parallel items**: every loop round and parallel item runs in its own scope (`$root/review__loop:round_1`, `$root/pages[2]`) with its own attempts, retries and records; loop-carried values and verdict aggregation are handled for you.
- **Assessments**: reviewing steps must return a verdict (`PASS`, `NEEDS_FIX`, `FAIL`, `BLOCKED`); conditions and loops read it; reruns mark old ones stale.
- **Waits**: gates and agent questions pause the run (`WAITING`) until `respond()`.
- **Chief**: when the definition has a `chief` policy and you pass a `ChiefSupervisor`, triggers (node failed, loop round needs a fix, question, stall, budget, user message) wake it; its commands go through the policy filter and are logged.
- **Isolation hooks**: a `WorkspaceManager` can give concurrent writers their own copy (`isolate`) and merge it back; merge conflicts redo the step once on the current workspace.
- **Run log**: every transition is a mutation appended to the run's log; `foldRunLog` rebuilds the state, so runs replay exactly.

## `createWorkflowRuntime(options)`

| Option | Default | Purpose |
|---|---|---|
| `executor` | — (required) | `executeAgent(request)` and `executeScript(request)`; optional `cancel(attemptId)` |
| `adapters` | — | Extra agent adapters by name (`AgentProfile.runtime.adapter`) |
| `store` | in memory | `RuntimeStore`: the run log, snapshots and projections |
| `artifacts` | in memory | `ArtifactStore`: versioned artifact content |
| `nodeData` | in memory | `NodeDataStore`: step data and logged issues |
| `workspaces` | in memory | `WorkspaceManager`: write leases and isolated copies |
| `agentRegistry` | — | Resolves `agentRef`s (`InMemoryAgentRegistry` provided) |
| `chief`, `chiefOptions` | — | Supervisor and host controls for its commands and reads |
| `parallelOptions.maxConcurrency` | — | Host cap per parallel batch |
| `clock`, `idGenerator` | system | `DeterministicClock` / `SequentialIdGenerator` for tests |

An executor returns `{ status: 'COMPLETED', outputs?, artifacts?, assessment?, changes?, waitRequest? }` or throws. The request carries the node, its resolved inputs, the manifest and rendered prompt, the workspace binding, a scoped artifact reader and the step's `data` access.

## `WorkflowRuntime` methods

| Method | Does |
|---|---|
| `start({ definition, inputs?, workspaces?, runId? })` | Creates a run (validates and compiles the definition, binds workspace slots) |
| `runUntilSettled(runId, { signal? })` | Drives it until `SUCCEEDED`, `FAILED`, `CANCELLED` or `WAITING` |
| `resume(runId)` | Continues a run (e.g. after a restart) |
| `respond({ runId, requestId, answer, responderId })` | Answers a gate or question |
| `rerunFromNode({ runId, nodeId, scopeKey? })` | Reruns a step and everything downstream of it, in the same run |
| `planFork({ sourceRunId, nodeId, definition? })` | What forking a run from a step would take over and run again, and the workspace changes of the taken-over steps (`RunForkPlan`); throws `RunForkError` when a step it depends on did not finish |
| `forkRun({ sourceRunId, nodeId, definition?, inputs?, workspaces?, runId? })` | A new run that takes over the source run's results up to the step (outputs, verdicts, loop rounds, items) and runs it and everything downstream again; the source run is untouched. Replaying file changes is the host's job (`WorkflowHost.forkRun` in workflow-node) |
| `cancelRun({ runId })` | Stops the run for good; late results are dropped (`RunCancelledError`) |
| `postChiefMessage` / `answerChiefMessage` / `replyToChiefMessage` / `applyHeldChiefCommands` | Talk to the chief, also while steps execute |
| `getOpenFindings(runId)` | Problems still open: each review's latest findings plus issues steps logged |
| `getLiveProgress(runId)` | Steps of attempts still executing |
| `store.getRun(runId)` / `store.readLog(runId)` | The folded state / the raw log |

## Run state

`WorkflowRunState` holds `status`, `inputs`, `outputs`, `scopes` (per scope: status, node states with outputs and verdicts), `attempts`, `assessments`, `manifests`, `waitRequests`, `pinnedAgents`, `chief` and `events` (`run.started`, `node.completed`, `node.waiting`, `loop.round.advanced`, `chief.intervened`, `run.finished`, …). Run statuses: `PENDING`, `RUNNING`, `WAITING`, `SUCCEEDED`, `FAILED`, `CANCELLED`.

## Related

[`@universal-agent/workflow-contract`](../workflow-contract) (definitions) · [`@universal-agent/workflow-node`](../workflow-node) (Node.js host) · [workflow guide](../../docs/workflow-guide.md)

## License

MIT
