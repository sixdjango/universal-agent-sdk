import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath, getSmoothStepPath, Position } from '@xyflow/react';
import { useState } from 'react';
import type { FlowEdgeData } from '../model/canvas';

/** Where execution points sit below a card's top (`.react-flow__handle.ctrl` in canvas.css). */
const HANDLE_TOP = 28;
/** Half the gap the layout leaves between wrapped rows (`layeredLayout` rowGap). */
const ROW_GAP_MIDDLE = 80;
/** How far a U-turn between snaking rows bulges out past the cards. */
const TURN = 70;

/**
 * Bezier edge that draws itself in, carries a glowing comet while work flows through it,
 * turns red into failed nodes and dashed into skipped ones. Its label only shows when it
 * matters (a branch condition, a problem, a selected card) or while hovered.
 */
export function FlowEdge(props: EdgeProps) {
  const data = props.data as FlowEdgeData | undefined;
  const tone = data?.tone ?? 'idle';
  const kind = data?.control ? 'Execution' : 'Parameter';
  const label = data?.label ?? (data?.control ? 'After success' : '');
  const title = `${kind}: ${label}`;
  const [hovered, setHovered] = useState(false);
  const showLabel = !!label && (hovered || !!data?.pinned || !!data?.focused || !!data?.selected || !!data?.issue);
  const ends = {
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  };
  const outward = props.sourcePosition === Position.Left ? -1 : 1;
  const { sourceX: sx, sourceY: sy, targetX: x, targetY: y } = props;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (props.sourcePosition === props.targetPosition) {
    // Leaving and entering on the same side: the U-turn from one snaking row into the next.
    path = `M ${sx} ${sy} C ${sx + outward * TURN} ${sy}, ${x + outward * TURN} ${y}, ${x} ${y}`;
    labelX = (sx + x) / 2 + outward * TURN * 0.75;
    labelY = (sy + y) / 2;
  } else if ((x - sx) * outward < -40) {
    // Running back against its direction (a row that wraps without snaking): step through the
    // gap above the target's row (execution points sit HANDLE_TOP below a card's top).
    [path, labelX, labelY] = getSmoothStepPath({
      ...ends,
      borderRadius: 16,
      offset: 28,
      ...(y > sy ? { centerY: y - HANDLE_TOP - ROW_GAP_MIDDLE } : {}),
    });
  } else {
    [path, labelX, labelY] = getBezierPath({ ...ends, curvature: 0.4 });
  }
  // The arrowhead points into the card from the side the edge enters.
  const into = props.targetPosition === Position.Right ? -1 : 1;
  const arrowPath = `M ${x - into * 7} ${y - 4.25} L ${x - into * 0.5} ${y} L ${x - into * 7} ${y + 4.25}`;

  return (
    <g
      data-muted={data?.muted ? 'true' : 'false'}
      className="connection-visual"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <title>{data?.issue ?? title}</title>
      <BaseEdge
        id={props.id}
        path={path}
        className="flow-edge"
        data-tone={tone}
        data-control={data?.control ? 'true' : 'false'}
        data-selected={data?.selected ? 'true' : 'false'}
        data-invalid={data?.issue ? 'true' : 'false'}
        aria-label={title}
        // Parameter dashes use pixel lengths. Normalizing their path to 1 would
        // stretch a "5 4" dash pattern beyond the whole line, making it look solid.
        pathLength={data?.control && tone !== 'skipped' ? 1 : undefined}
        interactionWidth={18}
      />
      <path
        d={arrowPath}
        className="flow-edge-arrow"
        data-control={data?.control ? 'true' : 'false'}
        data-tone={tone}
        data-selected={data?.selected ? 'true' : 'false'}
        data-invalid={data?.issue ? 'true' : 'false'}
      />
      {(tone === 'flowing' || tone === 'failed') && (
        <path d={path} className="flow-comet" data-tone={tone} pathLength={1} />
      )}
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            data-tone={data?.issue ? 'failed' : tone}
            data-selected={data?.selected ? 'true' : 'false'}
            data-control={data?.control ? 'true' : 'false'}
            data-muted={data?.muted ? 'true' : 'false'}
            title={data?.issue ?? title}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <span className="edge-caption">{label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
