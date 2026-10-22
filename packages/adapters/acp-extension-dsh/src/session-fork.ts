import { RequestError } from '@agentclientprotocol/sdk';
import type { LodySessionMeta } from 'acp-extension-core';

/** Native events are passed intact to Harness, including plugin-owned fields. */
export type ForkEvent = {
  type: string;
  seq: number;
  data: Record<string, unknown>;
};

export type ForkObservation = {
  header: { id: string; agentPreset?: string };
  events: readonly ForkEvent[];
  [Symbol.dispose](): void;
};

export type ForkSnapshot = {
  sourceId: string;
  seed: readonly ForkEvent[];
  agentPreset?: string;
  selection?: { provider: string; model: string; reasoningEffort?: string };
};

export function nativeTurnId(turn: number): string {
  return `dsh-turn:${turn}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse Core metadata strictly: malformed targets must never become full forks. */
export function forkTarget(meta: unknown): string | undefined {
  const lody = object(object(meta)?.lody);
  if (!lody || !Object.hasOwn(lody, 'forkAtTurn')) return undefined;
  const target = object(lody.forkAtTurn);
  if (
    !target ||
    target.version !== 1 ||
    (target.turnId !== undefined &&
      (typeof target.turnId !== 'string' ||
        !/^dsh-turn:(0|[1-9]\d*)$/.test(target.turnId) ||
        !Number.isSafeInteger(Number(target.turnId.slice('dsh-turn:'.length)))))
  )
    throw RequestError.invalidParams(undefined, 'invalid _meta.lody.forkAtTurn');
  return (target as LodySessionMeta['forkAtTurn'])?.turnId;
}

/** Capture a closed native prefix; unlike Harness UI anchors, targets never round. */
export function forkSnapshot(source: ForkObservation, target?: string): ForkSnapshot {
  const events = source.events;
  const end =
    target === undefined
      ? events.length - 1
      : events.findIndex(
          (event) =>
            event.type === 'turn/end' &&
            typeof event.data.turn === 'number' &&
            nativeTurnId(event.data.turn) === target
        );
  if (target !== undefined && end === -1)
    throw RequestError.invalidParams(undefined, 'fork turn is unknown or has not ended');
  const prefix = events.slice(0, end + 1);
  const lastTurn = [...prefix]
    .reverse()
    .find((event) => event.type === 'turn/start' || event.type === 'turn/end');
  if (lastTurn?.type === 'turn/start')
    throw RequestError.invalidParams(
      undefined,
      'cannot fork an unfinished turn; select an earlier completed turn'
    );
  let agentPreset = source.header.agentPreset;
  let selection: ForkSnapshot['selection'];
  for (const [index, event] of prefix.entries()) {
    if (event.seq !== index)
      throw RequestError.invalidParams(undefined, 'source session has a non-contiguous log');
    if (event.type === 'agent-preset/selected' && typeof event.data.agentPreset === 'string')
      agentPreset = event.data.agentPreset;
    if (event.type === 'request/header') {
      const config = object(object(event.data.header)?.config);
      if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string')
        throw RequestError.invalidParams(undefined, 'source request header has no model route');
      selection = {
        provider: config.provider,
        model: config.model,
        ...(typeof config.reasoningEffort === 'string'
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
      };
    }
  }
  // Observations can retain shared native buffers. Own the prefix before disposing them.
  return { sourceId: source.header.id, seed: structuredClone(prefix), agentPreset, selection };
}
