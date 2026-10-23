import type { AssessmentVerdict, LoopNode, ParallelNode, WorkflowNode } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';

/** How one loop round ended (or that it is still going). */
export type LoopRoundState = 'running' | 'passed' | 'again' | 'failed' | 'done';

export interface LoopRound {
  /** 1-based. */
  readonly number: number;
  readonly scopeKey: string;
  readonly state: LoopRoundState;
  readonly verdict?: AssessmentVerdict;
}

/** Everything needed to explain a loop at a glance: its rule, its limits and, in a run, its rounds. */
export interface LoopSummary {
  /** The step whose result decides whether another round runs. */
  readonly deciderId?: string;
  readonly deciderName?: string;
  /** e.g. `“Review” returns NEEDS_FIX` */
  readonly repeatWhen: string;
  /** How a round ends the loop, e.g. `PASS finishes · FAIL or BLOCKED stops it`. */
  readonly endsWhen?: string;
  /** Short form of the repeat rule for edge labels, e.g. `NEEDS_FIX`. */
  readonly repeatLabel: string;
  readonly maxRounds: number;
  /** Rounds the chief added on top of `maxRounds`. */
  readonly extraRounds: number;
  /** What happens when the last round still asks for another, e.g. `ask you`. */
  readonly whenOutOfRounds: string;
  /** Run only: rounds so far, oldest first. */
  readonly rounds: readonly LoopRound[];
}

const OUT_OF_ROUNDS: Record<LoopNode['onExhausted'], string> = {
  fail: 'fail',
  gate: 'ask you',
  pass_with_findings: 'continue with the open findings',
};

const VERDICTS: readonly AssessmentVerdict[] = ['PASS', 'NEEDS_FIX', 'FAIL', 'BLOCKED'];

/** Scope keys of a container's instances, in order (loop rounds or parallel items). */
export function containerInstanceKeys(run: WorkflowRunState, containerKey: string): string[] {
  const keys = Object.keys(run.scopes).filter((k) => k.startsWith(`${containerKey}:`) || k.startsWith(`${containerKey}[`));
  const index = (k: string) => Number(/(?::round_|\[)(\d+)\]?$/.exec(k)?.[1] ?? 0);
  return keys.filter((k) => !k.slice(containerKey.length + 1).includes('/')).sort((a, b) => index(a) - index(b));
}

/**
 * Explains `loop`: which step decides, on what result it repeats, how it ends, and what
 * happens when rounds run out. With a run, also how each round so far went.
 *
 * `bodyOrder` is the loop body's topological order; without an explicit `sourceNodeId` the
 * runtime lets the last step decide, and so does this description.
 */
export function describeLoop(
  loop: LoopNode,
  bodyOrder: readonly string[],
  options: { run?: WorkflowRunState | null; scopeKey?: string } = {}
): LoopSummary {
  const condition = loop.continueWhen;
  const deciderId = (condition.kind !== 'always' ? condition.sourceNodeId : undefined) ?? bodyOrder[bodyOrder.length - 1];
  const decider = loop.bodyGraph.nodes.find((n) => n.id === deciderId);
  const who = decider ? `“${decider.name}”` : 'the last step';

  let repeatWhen: string;
  let repeatLabel: string;
  let endsWhen: string | undefined;
  switch (condition.kind) {
    case 'always':
      repeatWhen = 'every round, until the limit';
      repeatLabel = 'always';
      break;
    case 'verdict_is':
    case 'verdict_in': {
      const again = condition.kind === 'verdict_is' ? [condition.verdict] : condition.verdicts;
      repeatWhen = `${who} returns ${again.join(' or ')}`;
      repeatLabel = again.join(' / ');
      const stops = VERDICTS.filter((v) => v !== 'PASS' && !again.includes(v));
      endsWhen = [
        again.includes('PASS') ? undefined : 'PASS finishes',
        stops.length > 0 ? `${stops.join(' or ')} stops it` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      break;
    }
    case 'port_equals':
      repeatWhen = `${who}'s ${condition.port} is ${JSON.stringify(condition.value)}`;
      repeatLabel = `${condition.port} = ${String(condition.value)}`;
      endsWhen = 'anything else finishes';
      break;
    case 'port_truthy':
      repeatWhen = `${who}'s ${condition.port} is set`;
      repeatLabel = condition.port;
      endsWhen = 'otherwise it finishes';
      break;
  }

  const rounds: LoopRound[] = [];
  const { run } = options;
  if (run) {
    const keys = containerInstanceKeys(run, `${options.scopeKey ?? '$root'}/${loop.id}`);
    keys.forEach((scopeKey, i) => {
      const scope = run.scopes[scopeKey];
      if (!scope) return;
      const verdict = deciderId ? scope.nodes[deciderId]?.latestVerdict : undefined;
      const state: LoopRoundState =
        scope.status === 'RUNNING' || scope.status === 'WAITING'
          ? 'running'
          : scope.status === 'FAILED' || verdict === 'FAIL' || verdict === 'BLOCKED'
            ? 'failed'
            : i < keys.length - 1 || verdict === 'NEEDS_FIX'
              ? 'again'
              : verdict === 'PASS'
                ? 'passed'
                : 'done';
      rounds.push({ number: i + 1, scopeKey, state, ...(verdict ? { verdict } : {}) });
    });
  }

  return {
    ...(deciderId ? { deciderId } : {}),
    ...(decider ? { deciderName: decider.name } : {}),
    repeatWhen,
    ...(endsWhen ? { endsWhen } : {}),
    repeatLabel,
    maxRounds: loop.maxRounds,
    extraRounds: run?.chief.loopExtensions[`${options.scopeKey ?? '$root'}/${loop.id}`] ?? 0,
    whenOutOfRounds: OUT_OF_ROUNDS[loop.onExhausted],
    rounds,
  };
}

/** One-paragraph explanation shown inside a loop body or a parallel item graph. */
export function describeContainerRule(container: LoopNode | ParallelNode, bodyOrder: readonly string[]): string {
  if (container.kind === 'parallel') {
    return `Runs these steps once for every entry of “${container.itemsPort}”, up to ${container.maxConcurrency} at a time. ${
      container.failurePolicy === 'fail_fast' ? 'The first failure stops all items.' : 'A failed item does not stop the others.'
    }`;
  }
  const loop = describeLoop(container, bodyOrder);
  return [
    `Repeats while ${loop.repeatWhen}, up to ${loop.maxRounds} round${loop.maxRounds === 1 ? '' : 's'}; then it will ${loop.whenOutOfRounds}.`,
    loop.endsWhen ? `${loop.endsWhen.replace(/^./, (c) => c.toUpperCase())}.` : '',
    'From round 2, every step also gets the previous round’s findings.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Whether `node` is the step that decides its loop's next round. */
export function isLoopDecider(container: WorkflowNode | null, nodeId: string, bodyOrder: readonly string[]): boolean {
  if (!container || container.kind !== 'loop') return false;
  const condition = container.continueWhen;
  const decider = (condition.kind !== 'always' ? condition.sourceNodeId : undefined) ?? bodyOrder[bodyOrder.length - 1];
  return decider === nodeId;
}
