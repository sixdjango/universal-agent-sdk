import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import type { FlowEdgeData } from '../model/canvas';

/**
 * Bezier edge that draws itself in, carries a glowing comet while work flows through it,
 * turns red into failed nodes and dashed into skipped ones.
 */
export function FlowEdge(props: EdgeProps) {
  const data = props.data as FlowEdgeData | undefined;
  const tone = data?.tone ?? 'idle';
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.4,
  });

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        className="flow-edge"
        data-tone={tone}
        data-control={data?.control ? 'true' : 'false'}
        data-selected={data?.selected ? 'true' : 'false'}
        data-invalid={data?.issue ? 'true' : 'false'}
        pathLength={1}
        interactionWidth={18}
      />
      {(tone === 'flowing' || tone === 'failed') && (
        <path d={path} className="flow-comet" data-tone={tone} pathLength={1} />
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            data-tone={data.issue ? 'failed' : tone}
            data-selected={data.selected ? 'true' : 'false'}
            title={data.issue}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
