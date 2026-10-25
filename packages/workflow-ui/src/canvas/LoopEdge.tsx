import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath, type Node, useNodes } from '@xyflow/react';
import type { FlowEdgeData } from '../model/canvas';
import type { CycleLoopView } from '../model/cycle-view';
import { useCanvasActions } from './actions';

/** How far below the cards the way back round runs (clear of the activity under a card). */
const DROP = 96;

/** Lanes run this far left of a card (the middle of the layout's 120px column gap). */
const LANE = 60;
/** How far a lane path leaves and enters a card's bottom before turning. */
const STUB = 24;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const boxOf = (n: Node): Box => ({
  left: n.position.x,
  top: n.position.y,
  right: n.position.x + (n.measured?.width ?? 280),
  bottom: n.position.y + (n.measured?.height ?? 160),
});

/** A polyline through `points` with rounded corners. */
function roundedPath(points: readonly (readonly [number, number])[], radius = 14): string {
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!;
    const [x, y] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const r = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const inX = x - Math.sign(x - px) * r;
    const inY = y - Math.sign(y - py) * r;
    const outX = x + Math.sign(nx - x) * r;
    const outY = y + Math.sign(ny - y) * r;
    d += ` L ${inX} ${inY} Q ${x} ${y} ${outX} ${outY}`;
  }
  const [lx, ly] = points[points.length - 1]!;
  return `${d} L ${lx} ${ly}`;
}

/**
 * The middle of the widest stretch between `from` and `to` (top to bottom) that no card
 * crosses between `left` and `right`: where a line can run across between two rows.
 */
function clearRow(boxes: readonly Box[], left: number, right: number, from: number, to: number): number {
  const blocked = boxes
    .filter((b) => b.right > left && b.left < right && b.bottom > from && b.top < to)
    .map((b) => [Math.max(b.top, from), Math.min(b.bottom, to)] as const)
    .sort((a, b) => a[0] - b[0]);
  let best: [number, number] = [from, from];
  let cursor = from;
  for (const [top, bottom] of blocked) {
    if (top - cursor > best[1] - best[0]) best = [cursor, top];
    cursor = Math.max(cursor, bottom);
  }
  if (to - cursor > best[1] - best[0]) best = [cursor, to];
  return (best[0] + best[1]) / 2;
}

const ROUND_MARK: Record<string, string> = { NEEDS_FIX: '↻', PASS: '✓', FAIL: '×', BLOCKED: '×' };
const EXHAUSTED: Record<CycleLoopView['onExhausted'], string> = {
  fail: 'then fails',
  gate: 'then asks you',
  pass_with_findings: 'then carries on',
};

/**
 * The way back round inside a loop body: leaves the deciding step from below, runs under the
 * cards (or, when the round starts on an earlier row, up a column gap and across between the
 * rows) and comes up into where the next round starts, labelled with what sends it round.
 * In a run its label lists the rounds; clicking one shows that round's state on the cards.
 */
export function LoopEdge(props: EdgeProps) {
  const data = props.data as FlowEdgeData | undefined;
  const actions = useCanvasActions();
  const cycle = data?.cycle;
  const nodes = useNodes();
  const from = nodes.find((n) => n.id === props.source);
  const to = nodes.find((n) => n.id === props.target);
  const sourceBox = from && boxOf(from);
  const targetBox = to && boxOf(to);

  let path: string;
  let labelX: number;
  let labelY: number;
  if (sourceBox && targetBox && targetBox.bottom < sourceBox.top) {
    // The round starts on an earlier row (a wrapped flow): climb the column gap left of the
    // deciding step, cross between the rows where no card is, and come down left of the start.
    const laneS = sourceBox.left - LANE;
    const laneT = targetBox.left - LANE;
    const across = clearRow(nodes.map(boxOf), Math.min(laneS, laneT), Math.max(laneS, laneT), targetBox.bottom, sourceBox.top);
    path = roundedPath([
      [props.sourceX, props.sourceY],
      [props.sourceX, props.sourceY + STUB],
      [laneS, props.sourceY + STUB],
      [laneS, across],
      [laneT, across],
      [laneT, props.targetY + STUB],
      [props.targetX, props.targetY + STUB],
      [props.targetX, props.targetY],
    ]);
    labelX = (laneS + laneT) / 2;
    labelY = across;
  } else {
    [path, labelX] = getSmoothStepPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: props.targetPosition,
      offset: DROP,
      borderRadius: 18,
    });
    labelY = Math.max(props.sourceY, props.targetY) + DROP;
  }
  const { targetX: x, targetY: y } = props;
  // Enters once the deciding step's card has (`.card-wrap` staggers cards by their order).
  const order = (from?.data as { order?: number } | undefined)?.order ?? 0;
  // The line is dashed, so it draws in through a mask rather than its own dashes.
  const maskId = `loop-draw-${props.id.replace(/[^\w-]/g, '_')}`;

  return (
    <g className="loop-edge-group" style={{ ['--order' as string]: order }}>
      <mask id={maskId} maskUnits="userSpaceOnUse" x={-1e5} y={-1e5} width={2e5} height={2e5}>
        <path d={path} className="loop-edge-draw" pathLength={1} />
      </mask>
      <g mask={`url(#${maskId})`}>
        <BaseEdge
          id={props.id}
          path={path}
          className="loop-edge"
          data-tone={data?.tone ?? 'idle'}
          data-selected={data?.selected ? 'true' : 'false'}
          interactionWidth={16}
        />
      </g>
      {data?.tone === 'flowing' && <path d={path} className="flow-comet loop-comet" pathLength={1} />}
      <path className="loop-edge-arrow" data-tone={data?.tone ?? 'idle'} d={`M ${x - 5} ${y + 9} L ${x} ${y + 2} L ${x + 5} ${y + 9}`} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="loop-edge-label"
            style={{ ['--order' as string]: order, transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={cycle ? `At most ${cycle.maxRounds + cycle.extraRounds} rounds, ${EXHAUSTED[cycle.onExhausted]}` : undefined}
          >
            <span aria-hidden="true">↻</span> {data.label}
            {cycle && cycle.extraRounds > 0 ? ` +${cycle.extraRounds}` : ''}
            {cycle && cycle.rounds.length > 0 && (
              <span className="loop-edge-rounds" role="group" aria-label="Rounds">
                {cycle.rounds.map((round, index) => (
                  <button
                    key={round.scopeKey}
                    type="button"
                    className="loop-edge-round nodrag nopan"
                    aria-pressed={index === cycle.shownRound}
                    data-verdict={round.verdict ?? (round.status === 'RUNNING' ? 'running' : 'none')}
                    title={`Round ${index + 1}${round.verdict ? `: ${round.verdict}` : ` (${round.status.toLowerCase()})`}`}
                    onClick={() => actions.chooseLoopRound?.(cycle.loopId, index)}
                  >
                    {index + 1}
                    {round.verdict ? ` ${ROUND_MARK[round.verdict] ?? ''}` : ''}
                  </button>
                ))}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
