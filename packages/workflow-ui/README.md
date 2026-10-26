# @universal-agent/workflow-ui

React components for Universal Agent workflows — the canvas editor, inspector, run trace, Chief dock, conversations and step data views — plus the view models behind them. They power the [web app](../workflow-web); use them to put workflows inside your own product.

```bash
npm install @universal-agent/workflow-ui @universal-agent/workflow-contract react react-dom @xyflow/react
```

Peer dependencies: `react` and `react-dom` 19, `@xyflow/react` 12.

```ts
import '@universal-agent/workflow-ui/styles.css'; // once, at your app's entry
```

## How it fits together

Everything is driven by plain data, so you own state and transport:

1. **Model**: `buildCanvasModel({ definition, run?, layout?, path?, liveProgress?, editable? })` turns a workflow definition — and, in a run, its `WorkflowRunState` — into cards and lines (statuses, verdicts, loop rounds, parallel items, issues).
2. **View**: `<WorkflowCanvas model={…} />` renders it; cards talk back through `CanvasActionsContext` (optional actions such as `fork` show their buttons only when provided).
3. **Editing**: pure functions return a new definition — `addNode`, `removeNode`, `connect`, `removeEdge`, `setEdgeCondition`, `addPort`, `removePort`, `addWorkspaceSlot`, `renameWorkspaceSlot`, `setSubflowWorkflow`, `expandLoopIntoCycle`, `createBlankWorkflow`, … — which you save however you like (e.g. `PUT /api/workflows/{id}`).

## A read-only viewer

```tsx
import { useMemo } from 'react';
import type { WorkflowDefinition } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';
import { buildCanvasModel, type CanvasActions, CanvasActionsContext, WorkflowCanvas } from '@universal-agent/workflow-ui';
import '@universal-agent/workflow-ui/styles.css';

const noop = async () => {};
const actions: CanvasActions = {
  agents: [], runtimes: [], editable: false, openPopover: null,
  setOpenPopover: () => {}, assignAgent: noop, refreshRuntime: noop, answer: noop, rerun: noop,
  openArtifact: () => {}, inspectNode: () => {}, openScope: () => {}, addPort: () => {},
};

export function FlowView({ definition, run }: { definition: WorkflowDefinition; run?: WorkflowRunState }) {
  const model = useMemo(() => buildCanvasModel({ definition, run: run ?? null }), [definition, run]);
  return (
    <div style={{ height: 600 }}>
      <CanvasActionsContext.Provider value={actions}>
        <WorkflowCanvas
          model={model}
          fitKey={definition.id}
          editable={false}
          onNodeClick={(nodeId) => console.log('clicked', nodeId)}
          onEdgeClick={() => {}}
          onBackgroundClick={() => {}}
          onLayoutChange={() => {}}   // a dragged layout, to persist if you like
          onConnect={() => {}}        // editable canvases: apply connect(definition, connection)
          onAddNode={() => {}}        // editable canvases: apply addNode(definition, kind)
        />
      </CanvasActionsContext.Provider>
    </div>
  );
}
```

For a full editor — inspector, scopes, loop rounds, run controls — follow the web app's [`App.tsx`](../workflow-web/src/App.tsx), which wires every component to the server API.

## Components

| Component | What it shows |
|---|---|
| `WorkflowCanvas` | The graph: flow lines (when steps run) and parameter lines (for the selected step), loop edges with their rounds, containers you open in place, snake layout for long flows, live motion on running steps |
| `Inspector` | Fields of the selected step, edge (conditions incl. `port_compare`, `all` / `any`, loop rounds and exhaustion), workflow (chief, workspaces) |
| `TraceView` | A run as a timeline: every step, loop round and parallel item with duration, tokens, cost, execution steps, conversation and data; "Rerun from here", and "Fork from here" when you pass `onFork` |
| `NodeExecutionDetails`, `ThinkingTrace` | One attempt's details; its execution steps (virtualized for long runs) |
| `NodeConversation`, `ConversationTranscriptView` | A recorded agent conversation (virtualized), messages, tools, permissions |
| `NodeData` | Data a step saved with `ua-workflow data` |
| `ChiefDock` | Chat with the run's Chief, its interventions, and chief settings |
| `WorkspacesPanel`, `RuntimeFields` | Workspace slots and bindings; engine / model / effort pickers |

## View models

`buildCanvasModel`, `buildTraceModel`, `buildChiefThread`, `buildNodeThinkingTrace`, `describeRun`, `describeCondition`, `describeLoop`, `layeredLayout` / `autoLayout`, `foldCycleRounds`, `readConversationTranscript`, `readNodeConversationCalls` — usable without the components (e.g. for a CLI, tests or another UI framework).

## Related

[`@universal-agent/workflow-contract`](../workflow-contract) · [`@universal-agent/workflow-web`](../workflow-web) · [`@universal-agent/workflow-server`](../workflow-server) · [workflow guide](../../docs/workflow-guide.md)

## License

MIT
