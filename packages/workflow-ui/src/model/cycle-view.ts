import {
  analyzeLoopBacks,
  type LoopBackInfo,
  type WorkflowDefinition,
  type WorkflowGraph,
} from '@universal-agent/workflow-contract';
import {
  computeScopeReadyNodeIds,
  resolveCompiledScopeByKey,
  type WorkflowRunState,
} from '@universal-agent/workflow-runtime';
import { compilePlan } from './canvas';
import { containerInstanceKeys } from './loop';

/** A loop drawn as a cycle, as the canvas shows it: its steps, limit and (in a run) rounds. */
export interface CycleLoopView {
  readonly loopId: string;
  /** The step whose result sends the flow round again (the way back leaves it). */
  readonly deciderId: string;
  readonly headId: string;
  readonly backEdgeId: string;
  readonly memberIds: readonly string[];
  readonly maxRounds: number;
  /** Rounds the chief added. */
  readonly extraRounds: number;
  readonly onExhausted: 'fail' | 'gate' | 'pass_with_findings';
  /** Run only: how each round went, oldest first. */
  readonly rounds: readonly { readonly scopeKey: string; readonly status: string; readonly verdict?: string }[];
  /** Run only: the round the canvas shows (index into `rounds`). */
  readonly shownRound?: number;
}

/** Whether a graph draws loops as cycles (and so must be shown as drawn, not as compiled). */
export function drawsCycles(graph: WorkflowGraph): boolean {
  return graph.controlEdges.some((e) => e.loop);
}

function loopView(loop: LoopBackInfo): Omit<CycleLoopView, 'rounds' | 'extraRounds'> {
  return {
    loopId: loop.loopId,
    deciderId: loop.deciderId,
    headId: loop.headId,
    backEdgeId: loop.edge.id,
    memberIds: loop.bodyIds,
    maxRounds: loop.edge.loop?.maxRounds ?? 3,
    onExhausted: loop.edge.loop?.onExhausted ?? 'fail',
  };
}

/** The loops of a graph as drawn, outermost first. */
export function cycleLoops(graph: WorkflowGraph): CycleLoopView[] {
  return analyzeLoopBacks(graph).loops.map((loop) => ({ ...loopView(loop), extraRounds: 0, rounds: [] }));
}

/**
 * Runs execute a drawn loop in per-round scopes (`<scope>/<loopId>:round_<n>`). This folds the
 * shown round of every loop (the latest, unless `roundChoice` picks one) back into the
 * graph's own scope, so the canvas can show the flat graph with live state:
 *
 * - the scope's nodes include the steps of the shown rounds (nested loops too);
 * - attempts and questions of all rounds are re-keyed to the scope (card history spans rounds);
 * - `running` lists steps that are ready to run in the shown rounds.
 */
export function foldCycleRounds(
  run: WorkflowRunState,
  definition: WorkflowDefinition,
  graph: WorkflowGraph,
  scopeKey: string,
  roundChoice: Readonly<Record<string, number>> = {}
): { run: WorkflowRunState; loops: CycleLoopView[]; running: Set<string> } {
  const analysis = analyzeLoopBacks(graph);
  const plan = compilePlan(run.definition ?? definition);
  const base = run.scopes[scopeKey];
  const nodes = { ...(base?.nodes ?? {}) };
  const running = new Set<string>();
  const views: CycleLoopView[] = [];
  const roundPrefixes: string[] = [];

  const fold = (loops: readonly LoopBackInfo[], parentKey: string) => {
    for (const loop of loops) {
      const prefix = `${parentKey}/${loop.loopId}`;
      roundPrefixes.push(`${prefix}:round_`);
      const keys = containerInstanceKeys(run, prefix);
      const choice = roundChoice[loop.loopId];
      const shown = keys.length === 0 ? undefined : Math.min(choice ?? keys.length - 1, keys.length - 1);
      const roundKey = shown !== undefined ? keys[shown] : undefined;
      views.push({
        ...loopView(loop),
        extraRounds: run.chief.loopExtensions[prefix] ?? 0,
        rounds: keys.map((key) => {
          const scope = run.scopes[key]!;
          const verdict = scope.nodes[loop.deciderId]?.latestVerdict;
          return { scopeKey: key, status: scope.status, ...(verdict ? { verdict } : {}) };
        }),
        ...(shown !== undefined ? { shownRound: shown } : {}),
      });
      delete nodes[loop.loopId];
      const roundScope = roundKey ? run.scopes[roundKey] : undefined;
      if (roundScope) {
        for (const [id, state] of Object.entries(roundScope.nodes)) if (!id.endsWith('__loop')) nodes[id] = state;
        if (roundScope.status === 'RUNNING') {
          try {
            const compiled = resolveCompiledScopeByKey(plan, roundKey!);
            for (const id of computeScopeReadyNodeIds(compiled, roundScope)) running.add(id);
          } catch {
            // the round's shape is unknown (definition changed); show it without live markers
          }
        }
      }
      // Loops directly inside this one live in the shown round's scope.
      const inner = analysis.loops.filter(
        (other) =>
          other !== loop &&
          other.bodyIds.every((id) => loop.bodyIds.includes(id)) &&
          !analysis.loops.some(
            (mid) => mid !== loop && mid !== other && mid.bodyIds.every((id) => loop.bodyIds.includes(id)) && other.bodyIds.every((id) => mid.bodyIds.includes(id))
          )
      );
      if (roundKey) fold(inner, roundKey);
      else for (const l of inner) views.push({ ...loopView(l), extraRounds: 0, rounds: [] });
    }
  };
  const outermost = analysis.loops.filter(
    (loop) => !analysis.loops.some((other) => other !== loop && loop.bodyIds.every((id) => other.bodyIds.includes(id)))
  );
  fold(outermost, scopeKey);

  const inRounds = (key: string) => roundPrefixes.some((prefix) => key.startsWith(prefix));
  const attempts = Object.fromEntries(
    Object.entries(run.attempts).map(([id, a]) => [id, inRounds(a.scopeKey) ? { ...a, scopeKey } : a])
  );
  const waitRequests = Object.fromEntries(
    Object.entries(run.waitRequests).map(([id, w]) => [id, inRounds(w.scopeKey) ? { ...w, scopeKey } : w])
  );
  return {
    run: {
      ...run,
      scopes: { ...run.scopes, ...(base ? { [scopeKey]: { ...base, nodes } } : {}) },
      attempts,
      waitRequests,
    },
    loops: views,
    running,
  };
}
