import {
  canonicalizeJsonValue,
  type CompiledWorkflowPlan,
  type WaitRequest,
  type WorkflowEvent,
  type WorkflowRunStatus,
} from '@universal-agent/workflow-contract';
import type {
  ChiefRunState,
  GraphScopeState,
  NodeRuntimeState,
  RunSnapshotState,
  WorkflowRunState,
} from '../ports';
import {
  reduceScopeTransitions,
  resolveCompiledScopeByKey,
  reviveAncestorScopes,
} from './graph-reducer';

/** Pseudo node id for WaitRequests raised by the chief's `escalate` command. */
export const CHIEF_WAIT_NODE_ID = '$chief';

/**
 * Run status implied by the root scope. An open chief escalation holds the run at WAITING,
 * even over a failed root, because the human's answer may still revive it.
 */
export function deriveRunStatus(
  rootScope: GraphScopeState,
  chief: ChiefRunState
): WorkflowRunStatus {
  if (chief.pendingEscalationId) {
    return 'WAITING';
  }
  if (rootScope.status === 'SUCCEEDED' || rootScope.status === 'FAILED') {
    return rootScope.status;
  }
  return rootScope.status === 'WAITING' ? 'WAITING' : 'RUNNING';
}

/**
 * Pure transition for answering a WaitRequest (gate decision, agent question, or chief
 * escalation). Returns `null` when it was already resolved with the same answer.
 */
export function resolveWaitRequestInState(
  plan: CompiledWorkflowPlan,
  current: WorkflowRunState,
  input: {
    readonly requestId: string;
    readonly answer: string | Record<string, unknown>;
    readonly responderId: string;
    readonly nowMs: number;
  }
): RunSnapshotState | null {
  const waitReq = current.waitRequests[input.requestId];
  if (!waitReq) {
    throw new Error(`WaitRequest "${input.requestId}" not found in run "${current.runId}"`);
  }

  // Idempotent convergence if already resolved with the same answer (canonical key-order independent)
  if (waitReq.status === 'RESOLVED') {
    if (canonicalizeJsonValue(waitReq.response?.answer) === canonicalizeJsonValue(input.answer)) {
      return null;
    }
    throw new Error(
      `WaitRequest "${input.requestId}" has already been resolved with a different answer`
    );
  }

  const resolvedWait: WaitRequest = {
    ...waitReq,
    status: 'RESOLVED',
    response: {
      answer: input.answer,
      responderId: input.responderId,
      respondedAtMs: input.nowMs,
    },
  };
  const waitRequests = { ...current.waitRequests, [input.requestId]: resolvedWait };

  if (waitReq.nodeId === CHIEF_WAIT_NODE_ID) {
    const chief: ChiefRunState = { ...current.chief, pendingEscalationId: undefined };
    return {
      ...current,
      status: deriveRunStatus(current.scopes.$root!, chief),
      chief,
      waitRequests,
      events: [
        ...current.events,
        {
          type: 'chief.escalation_resolved',
          runId: current.runId,
          requestId: input.requestId,
          answer: input.answer,
          responderId: input.responderId,
          timestampMs: input.nowMs,
        },
      ],
    };
  }

  const scopeState = current.scopes[waitReq.scopeKey];
  if (!scopeState) {
    throw new Error(`Scope "${waitReq.scopeKey}" not found`);
  }
  const nodeState = scopeState.nodes[waitReq.nodeId];
  if (!nodeState) {
    throw new Error(`Node "${waitReq.nodeId}" not found in scope "${waitReq.scopeKey}"`);
  }

  const compiledScope = resolveCompiledScopeByKey(plan, waitReq.scopeKey);
  const nodeDef = compiledScope.nodesById[waitReq.nodeId];

  // If this was a GateNode, resolving the WaitRequest completes the GateNode and binds its output port
  let updatedNodeState: NodeRuntimeState;
  let attempts = current.attempts;
  const events: WorkflowEvent[] = [...current.events];

  if (nodeDef?.kind === 'gate') {
    const outputPortName = nodeDef.outputs[0]?.name ?? 'decision';
    updatedNodeState = {
      ...nodeState,
      status: 'SUCCEEDED',
      activeWaitRequestId: undefined,
      outputs: {
        ...nodeState.outputs,
        [outputPortName]: { value: input.answer },
      },
    };
    const attempt = current.attempts[waitReq.attemptId];
    if (attempt) {
      attempts = {
        ...attempts,
        [waitReq.attemptId]: {
          ...attempt,
          phase: 'publish',
          status: 'SUCCEEDED',
          completedAtMs: input.nowMs,
        },
      };
    }
    events.push({
      type: 'node.completed',
      runId: current.runId,
      scopeKey: waitReq.scopeKey,
      nodeId: waitReq.nodeId,
      attemptId: waitReq.attemptId,
      status: 'SUCCEEDED',
      timestampMs: input.nowMs,
    });
  } else {
    // AgentNode (mid-turn wait) or LoopNode (`onExhausted: 'gate'`): mark node PENDING so it resumes
    updatedNodeState = {
      ...nodeState,
      status: 'PENDING',
    };
  }

  const updatedScope = reduceScopeTransitions(compiledScope, {
    ...scopeState,
    status: 'RUNNING',
    nodes: {
      ...scopeState.nodes,
      [waitReq.nodeId]: updatedNodeState,
    },
  });

  // Wake up any ancestor container scopes (`LoopNode` / `ParallelNode`) if `waitReq.scopeKey` is a nested scope
  const scopes = reviveAncestorScopes(
    {
      ...current.scopes,
      [waitReq.scopeKey]: updatedScope,
    },
    waitReq.scopeKey
  );

  const status = deriveRunStatus(scopes.$root!, current.chief);
  if (status === 'SUCCEEDED') {
    events.push({
      type: 'run.finished',
      runId: current.runId,
      status: 'SUCCEEDED',
      timestampMs: input.nowMs,
    });
  }

  return { ...current, status, scopes, attempts, waitRequests, events };
}
