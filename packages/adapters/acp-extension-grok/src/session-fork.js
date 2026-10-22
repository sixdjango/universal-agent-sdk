import runtimeManifest from '../runtime-manifest.json' with { type: 'json' };

// Core's turn id is opaque to the host. Keep the native, zero-based prompt
// boundary in it so another adapter process can fork a persisted source.
const TURN_PREFIX = 'grok-prompt:';

function grokTurnId(index) {
  return Number.isSafeInteger(index) && index >= 0 ? `${TURN_PREFIX}${index}` : undefined;
}

function targetIndex(meta) {
  const fork = meta?.lody?.forkAtTurn;
  if (fork === undefined) return undefined;
  if (fork?.version !== 1) throw new Error('Unsupported forkAtTurn version');
  if (fork.turnId === undefined) return undefined;
  const index =
    typeof fork.turnId === 'string' ? Number(fork.turnId.slice(TURN_PREFIX.length)) : NaN;
  if (grokTurnId(index) !== fork.turnId) throw new Error('Invalid Grok fork turn id');
  return index;
}

function forkError(id, message, code = -32602) {
  return { toRuntime: [], toClient: [{ jsonrpc: '2.0', id, error: { code, message } }] };
}

export class GrokSessionForkBridge {
  constructor(request) {
    this.request = request;
    this.turnBySession = new Map();
  }

  start(message) {
    const params = message.params ?? {};
    let targetPromptIndex;
    try {
      targetPromptIndex = targetIndex(params._meta);
      if (
        typeof params.sessionId !== 'string' ||
        !params.sessionId ||
        typeof params.cwd !== 'string' ||
        !params.cwd
      ) {
        throw new Error('session/fork requires sessionId and cwd');
      }
    } catch (error) {
      return forkError(message.id, error.message);
    }
    const operation = { message, targetPromptIndex, cursors: new Set() };
    // A fork normally starts in a fresh adapter. The request cwd belongs to the
    // child, so never use it as the source namespace (worktree forks differ).
    return this.list(operation);
  }

  list(operation, cursor) {
    return {
      toRuntime: [this.request('fork-list', operation, 'session/list', cursor ? { cursor } : {})],
      toClient: [],
    };
  }

  copy(operation, sourceCwd) {
    const { params } = operation.message;
    return {
      toRuntime: [
        this.request(
          'fork-copy',
          operation,
          `_${runtimeManifest.privateWireContract.sessionForkRequest}`,
          {
            sourceSessionId: params.sessionId,
            sourceCwd,
            newCwd: params.cwd,
            ...(operation.targetPromptIndex === undefined
              ? {}
              : {
                  targetPromptIndex: operation.targetPromptIndex,
                }),
          }
        ),
      ],
      toClient: [],
    };
  }

  response(message, pending, resume) {
    const operation = pending.operation;
    const id = operation.message.id;
    if (message.error) return { toRuntime: [], toClient: [{ ...message, id }] };
    const result = message.result;
    if (pending.kind === 'fork-list') {
      if (!Array.isArray(result?.sessions))
        return forkError(id, 'Invalid Grok session list', -32603);
      const source = result.sessions.find(
        (row) => row?.sessionId === operation.message.params.sessionId
      );
      if (source && typeof source.cwd === 'string' && source.cwd) {
        return this.copy(operation, source.cwd);
      }
      const cursor = result.nextCursor;
      if (typeof cursor === 'string' && cursor && !operation.cursors.has(cursor)) {
        operation.cursors.add(cursor);
        return this.list(operation, cursor);
      }
      return forkError(id, 'Grok fork source session not found');
    }
    const child = result?.newSessionId;
    if (typeof child !== 'string' || !child || child === operation.message.params.sessionId) {
      return forkError(id, 'Invalid Grok fork response: missing new session identity', -32603);
    }
    // Resume attaches without replaying history: Lody already copied the visible
    // source prefix. Do not touch/cancel/reload the source session.
    return resume({
      ...operation.message,
      method: 'session/resume',
      params: { ...operation.message.params, sessionId: child },
    });
  }

  update(message) {
    if (message.method !== 'session/update') return message;
    const { sessionId, update } = message.params ?? {};
    if (!update) return message;
    if (update.sessionUpdate === 'user_message_chunk') {
      const turnId = grokTurnId(update._meta?.promptIndex);
      if (turnId) this.turnBySession.set(sessionId, turnId);
      if (message.params._meta?.isReplay !== true) {
        // Consume native echoes, but publish the boundary before any assistant
        // output, including turns which only produce tool calls.
        return turnId
          ? {
              ...message,
              params: {
                ...message.params,
                update: {
                  sessionUpdate: 'session_info_update',
                  _meta: { lody: { turnId } },
                },
              },
            }
          : undefined;
      }
    }
    const turnId = this.turnBySession.get(sessionId);
    if (
      !turnId ||
      ![
        'user_message_chunk',
        'agent_message_chunk',
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
        'plan',
        'plan_update',
      ].includes(update.sessionUpdate)
    )
      return message;
    return {
      ...message,
      params: {
        ...message.params,
        update: {
          ...update,
          _meta: { ...update._meta, lody: { ...update._meta?.lody, turnId } },
        },
      },
    };
  }
}
