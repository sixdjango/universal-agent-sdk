import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import type { FlowEdgeData } from '../model/canvas';

/** How far below the cards the way back round runs (clear of the activity under a card). */
const DROP = 96;

/**
 * The way back round inside a loop body: leaves the deciding step from below, runs under the
 * cards and comes up into where the next round starts, labelled with what sends it round.
 */
export function LoopEdge(props: EdgeProps) {
  const data = props.data as FlowEdgeData | undefined;
  const [path, labelX] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    offset: DROP,
    borderRadius: 18,
  });
  const bottom = Math.max(props.sourceY, props.targetY) + DROP;
  const { targetX: x, targetY: y } = props;

  return (
    <>
      <BaseEdge id={props.id} path={path} className="loop-edge" data-tone={data?.tone ?? 'idle'} interactionWidth={0} />
      <path className="loop-edge-arrow" data-tone={data?.tone ?? 'idle'} d={`M ${x - 5} ${y + 9} L ${x} ${y + 2} L ${x + 5} ${y + 9}`} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div className="loop-edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${bottom}px)` }}>
            <span aria-hidden="true">↻</span> {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
