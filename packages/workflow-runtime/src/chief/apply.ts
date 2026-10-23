import {
  CHIEF_COMMAND_LEVEL,
  CHIEF_LEVEL_RANK,
  type ChiefCommand,
  type ChiefDecision,
  type ChiefPolicy,
  type CompiledGraphScope,
  type CompiledWorkflowPlan,
  parseAgentRef,
  type WaitRequest,
  type WorkflowEvent,
} from '@universal-agent/workflow-contract';
import type { PinnedAgent, RunSnapshotState, WorkflowRunState } from '../ports';
import {
  invalidateSubgraphForRerun,
  reduceScopeTransitions,
  resolveCompiledScopeByKey,
  reviveAncestorScopes,
} from '../scheduler/graph-reducer';
import {
  CHIEF_WAIT_NODE_ID,
  deriveRunStatus,
  resolveWaitRequestInState,
} from '../scheduler/wait-resolution';
import type { ChiefTrigger } from './triggers';

export interface ApplyChiefDecisionInput {
  readonly plan: CompiledWorkflowPlan;
  readonly state: WorkflowRunState;
  readonly policy: ChiefPolicy;
  readonly trigger: ChiefTrigger;
  readonly decision: ChiefDecision;
  /** Event cursor to persist: every event before it has been examined. */
  readonly processedEventCount: number;
  readonly chiefAgent?: PinnedAgent;
  /** Profiles for `swap_agent` targets, resolved by the caller beforehand. */
  readonly resolvedAgents: Readonly<Record<string, PinnedAgent>>;
  readonly nowMs: number;
  readonly newId: (prefix: string) => string;
}

export interface AppliedChiefDecision {
  readonly nextState: RunSnapshotState;
  readonly applied: readonly ChiefCommand[];
  readonly rejected: readonly { readonly command: ChiefCommand; readonly reason: string }[];
}

class CommandRejection extends Error {}

function hasAgentNode(scope: CompiledGraphScope, nodeId: string): boolean {
  if (scope.nodesById[nodeId]?.kind === 'agent') return true;
  return Object.values(scope.childScopes).some((child) => hasAgentNode(child, nodeId));
}

function requireScope(state: RunSnapshotState, scopeKey: string) {
  const scope = state.scopes[scopeKey];
  if (!scope) throw new CommandRejection(`scope "${scopeKey}" does not exist in this run`);
  return scope;
}

/** Re-opens `nodeId` in `scopeKey` and every enclosing scope so the scheduler picks it up. */
function reopenNode(
  plan: CompiledWorkflowPlan,
  state: RunSnapshotState,
  scopeKey: string,
  nodeId: string
): RunSnapshotState {
  const scope = requireScope(state, scopeKey);
  const compiled = resolveCompiledScopeByKey(plan, scopeKey);
  const reduced = reduceScopeTransitions(compiled, {
    ...scope,
    status: 'RUNNING',
    nodes: {
      ...scope.nodes,
      [nodeId]: {
        ...scope.nodes[nodeId]!,
        status: 'PENDING',
        retryCount: 0,
        error: undefined,
        activeWaitRequestId: undefined,
      },
    },
  });
  return {
    ...state,
    scopes: reviveAncestorScopes({ ...state.scopes, [scopeKey]: reduced }, scopeKey),
  };
}

function applyCommand(
  input: ApplyChiefDecisionInput,
  state: RunSnapshotState,
  command: ChiefCommand
): RunSnapshotState {
  const { plan, policy } = input;
  const level = CHIEF_COMMAND_LEVEL[command.kind];
  if (CHIEF_LEVEL_RANK[level] > CHIEF_LEVEL_RANK[policy.maxLevel]) {
    throw new CommandRejection(`requires level "${level}" but policy caps at "${policy.maxLevel}"`);
  }

  switch (command.kind) {
    case 'report':
      return state;

    case 'inject_guidance': {
      if (command.scopeKey !== undefined) {
        const compiled = resolveCompiledScopeByKey(plan, requireScope(state, command.scopeKey).scopeKey);
        if (compiled.nodesById[command.nodeId]?.kind !== 'agent') {
          throw new CommandRejection(`"${command.nodeId}" is not an AgentNode in "${command.scopeKey}"`);
        }
      } else if (!hasAgentNode(plan.rootScope, command.nodeId)) {
        throw new CommandRejection(`no AgentNode "${command.nodeId}" exists in this workflow`);
      }
      return {
        ...state,
        chief: {
          ...state.chief,
          guidance: [
            ...state.chief.guidance,
            {
              nodeId: command.nodeId,
              ...(command.scopeKey !== undefined ? { scopeKey: command.scopeKey } : {}),
              text: command.text,
              createdAtMs: input.nowMs,
            },
          ],
        },
      };
    }

    case 'retry_node': {
      const node = requireScope(state, command.scopeKey).nodes[command.nodeId];
      if (!node) throw new CommandRejection(`node "${command.nodeId}" is not in "${command.scopeKey}"`);
      if (node.status !== 'FAILED') {
        throw new CommandRejection(`node "${command.nodeId}" is ${node.status}, only FAILED nodes can be retried`);
      }
      return reopenNode(plan, state, command.scopeKey, command.nodeId);
    }

    case 'rerun_from_node': {
      requireScope(state, command.scopeKey);
      if (!resolveCompiledScopeByKey(plan, command.scopeKey).nodesById[command.nodeId]) {
        throw new CommandRejection(`node "${command.nodeId}" is not in "${command.scopeKey}"`);
      }
      return invalidateSubgraphForRerun(
        plan,
        { ...input.state, ...state },
        command.nodeId,
        command.scopeKey,
        input.nowMs
      ).nextState;
    }

    case 'swap_agent': {
      if (!parseAgentRef(command.agentRef)) {
        throw new CommandRejection(`malformed agent ref "${command.agentRef}"`);
      }
      const pinned = input.resolvedAgents[command.agentRef];
      if (!pinned) throw new CommandRejection(`agent "${command.agentRef}" could not be resolved`);
      if (!hasAgentNode(plan.rootScope, command.nodeId)) {
        throw new CommandRejection(`no AgentNode "${command.nodeId}" exists in this workflow`);
      }
      return {
        ...state,
        pinnedAgents: { ...state.pinnedAgents, [pinned.ref]: state.pinnedAgents[pinned.ref] ?? pinned },
        chief: {
          ...state.chief,
          agentOverrides: [
            ...state.chief.agentOverrides,
            {
              nodeId: command.nodeId,
              ...(command.scopeKey !== undefined ? { scopeKey: command.scopeKey } : {}),
              agentRef: command.agentRef,
            },
          ],
        },
      };
    }

    case 'answer_wait': {
      const wait = state.waitRequests[command.requestId];
      if (!wait || wait.status !== 'PENDING') {
        throw new CommandRejection(`no pending WaitRequest "${command.requestId}"`);
      }
      const nodeDef = resolveCompiledScopeByKey(plan, wait.scopeKey).nodesById[wait.nodeId];
      if (nodeDef?.kind !== 'agent') {
        throw new CommandRejection('only questions raised by AgentNodes may be answered by the chief');
      }
      const resolved = resolveWaitRequestInState(
        plan,
        { ...input.state, ...state },
        {
          requestId: command.requestId,
          answer: command.answer,
          responderId: `chief:${input.chiefAgent?.ref ?? 'supervisor'}`,
          nowMs: input.nowMs,
        }
      );
      return resolved ?? state;
    }

    case 'extend_loop': {
      const scope = requireScope(state, command.scopeKey);
      const nodeDef = resolveCompiledScopeByKey(plan, command.scopeKey).nodesById[command.nodeId];
      if (nodeDef?.kind !== 'loop') {
        throw new CommandRejection(`"${command.nodeId}" is not a LoopNode in "${command.scopeKey}"`);
      }
      const key = `${command.scopeKey}/${command.nodeId}`;
      const granted = (state.chief.loopExtensions[key] ?? 0) + command.extraRounds;
      if (granted > policy.maxLoopRoundExtension) {
        throw new CommandRejection(
          `would grant ${granted} extra rounds, above maxLoopRoundExtension ${policy.maxLoopRoundExtension}`
        );
      }
      const extended: RunSnapshotState = {
        ...state,
        chief: {
          ...state.chief,
          loopExtensions: { ...state.chief.loopExtensions, [key]: granted },
        },
      };
      // A loop that already failed on exhaustion resumes with the new limit.
      return scope.nodes[command.nodeId]?.status === 'FAILED'
        ? reopenNode(plan, extended, command.scopeKey, command.nodeId)
        : extended;
    }

    case 'escalate': {
      if (state.chief.pendingEscalationId) {
        throw new CommandRejection('an escalation is already waiting for a human');
      }
      const requestId = input.newId('wait');
      const waitRequest: WaitRequest = {
        requestId,
        runId: state.runId,
        scopeKey: '$root',
        nodeId: CHIEF_WAIT_NODE_ID,
        attemptId: CHIEF_WAIT_NODE_ID,
        prompt: command.prompt,
        options: command.options ?? [],
        status: 'PENDING',
        createdAtMs: input.nowMs,
      };
      return {
        ...state,
        waitRequests: { ...state.waitRequests, [requestId]: waitRequest },
        chief: { ...state.chief, pendingEscalationId: requestId },
        events: [
          ...state.events,
          {
            type: 'node.waiting',
            runId: state.runId,
            scopeKey: '$root',
            nodeId: CHIEF_WAIT_NODE_ID,
            attemptId: CHIEF_WAIT_NODE_ID,
            requestId,
            prompt: command.prompt,
            timestampMs: input.nowMs,
          },
        ],
      };
    }
  }
}

/**
 * Applies a chief decision command by command. Commands above the policy level or with
 * invalid targets are rejected individually; the outcome is logged as `chief.intervened`.
 */
export function applyChiefDecision(input: ApplyChiefDecisionInput): AppliedChiefDecision {
  let state: RunSnapshotState = input.state;
  const applied: ChiefCommand[] = [];
  const rejected: { command: ChiefCommand; reason: string }[] = [];

  for (const command of input.decision.commands) {
    try {
      state = applyCommand(input, state, command);
      applied.push(command);
    } catch (err) {
      // Validation failures and errors from the shared transitions (e.g. unknown node) both
      // reject just this command; the rest of the decision still applies.
      rejected.push({ command, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const event: WorkflowEvent = {
    type: 'chief.intervened',
    runId: state.runId,
    trigger: input.trigger.kind,
    ...(input.trigger.scopeKey ? { scopeKey: input.trigger.scopeKey } : {}),
    ...(input.trigger.nodeId ? { nodeId: input.trigger.nodeId } : {}),
    ...(input.trigger.messageId ? { inReplyTo: input.trigger.messageId } : {}),
    ...(input.decision.reply ? { reply: input.decision.reply } : {}),
    rationale: input.decision.rationale,
    applied,
    rejected,
    timestampMs: input.nowMs,
  };

  // Answering a human without acting does not use up the intervention budget.
  const intervened = input.trigger.kind !== 'user.message' || applied.length > 0;
  const chief = {
    ...state.chief,
    interventionCount: state.chief.interventionCount + (intervened ? 1 : 0),
    processedEventCount: Math.max(state.chief.processedEventCount, input.processedEventCount),
    budgetTriggered: state.chief.budgetTriggered || input.trigger.kind === 'budget.exceeded',
  };

  return {
    nextState: {
      ...state,
      status: deriveRunStatus(state.scopes.$root!, chief),
      chief,
      pinnedAgents:
        input.chiefAgent && !state.pinnedAgents[input.chiefAgent.ref]
          ? { ...state.pinnedAgents, [input.chiefAgent.ref]: input.chiefAgent }
          : state.pinnedAgents,
      events: [...state.events, event],
    },
    applied,
    rejected,
  };
}
