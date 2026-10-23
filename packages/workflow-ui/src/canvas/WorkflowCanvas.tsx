import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasLayout } from '../types';
import { Menu } from '../components/Menu';
import type { CanvasModel } from '../model/canvas';
import { type CanvasConnection, isPlausibleConnection, type NewNodeKind } from '../model/editing';
import { FlowEdge } from './FlowEdge';
import { LoopEdge } from './LoopEdge';
import { NodeCard } from './NodeCard';

const nodeTypes = { card: NodeCard };
const edgeTypes = { flow: FlowEdge, loop: LoopEdge };

function ZoomControl() {
  const { zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  return (
    <div className="zoom">
      <button type="button" aria-label="Zoom out" onClick={() => void zoomOut({ duration: 200 })}>
        −
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in" onClick={() => void zoomIn({ duration: 200 })}>
        +
      </button>
    </div>
  );
}

const MIN_READABLE_ZOOM = 0.85;
const EDGE_PADDING = 56;

/**
 * Frames the graph once per `fitKey`, after React Flow has measured the cards. Wide graphs
 * are not shrunk below a readable zoom; they start from their left edge (the inputs) instead.
 */
function FitOnChange({ fitKey }: { fitKey: string }) {
  const { fitView, getNodes, getNodesBounds, setViewport } = useReactFlow();
  const initialized = useNodesInitialized();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized || !width || fitted.current === fitKey) return;
    fitted.current = fitKey;
    const bounds = getNodesBounds(getNodes());
    const fitZoom = Math.min(
      (width - EDGE_PADDING * 2) / bounds.width,
      (height - EDGE_PADDING * 2 - 80) / bounds.height,
      1.1
    );
    if (fitZoom >= MIN_READABLE_ZOOM) {
      void fitView({ padding: 0.16, maxZoom: 1.1, duration: 0 });
      return;
    }
    void setViewport({
      zoom: MIN_READABLE_ZOOM,
      x: EDGE_PADDING - bounds.x * MIN_READABLE_ZOOM,
      y: height / 2 - (bounds.y + bounds.height / 2) * MIN_READABLE_ZOOM,
    });
  }, [initialized, fitKey, fitView, getNodes, getNodesBounds, setViewport, width, height]);
  return null;
}

/** Glides to the node that just started running or waiting when it is off screen. */
function FollowActive({ nodeId }: { nodeId: string | null }) {
  const { getInternalNode, getViewport, setCenter } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    if (!nodeId) return;
    let attempts = 0;
    let timer = 0;
    const follow = () => {
      const node = getInternalNode(nodeId);
      // Freshly added nodes are measured a frame or two after they mount.
      if (!node?.measured.width || !node.measured.height) {
        if (attempts++ < 10) timer = window.setTimeout(follow, 50);
        return;
      }
      glide(node);
    };
    const glide = (node: NonNullable<ReturnType<typeof getInternalNode>>) => {
    const { x, y, zoom } = getViewport();
    const left = node.internals.positionAbsolute.x * zoom + x;
    const top = node.internals.positionAbsolute.y * zoom + y;
    const right = left + node.measured.width! * zoom;
    const bottom = top + node.measured.height! * zoom;
    if (left >= 24 && right <= width - 24 && top >= 90 && bottom <= height - 24) return;
    void setCenter(
      node.internals.positionAbsolute.x + node.measured.width! / 2,
      node.internals.positionAbsolute.y + node.measured.height! / 2,
      { zoom, duration: 600 }
    );
    };
    follow();
    return () => window.clearTimeout(timer);
  }, [nodeId, getInternalNode, getViewport, setCenter, width, height]);
  return null;
}

const NODE_CHOICES: { kind: NewNodeKind; title: string; desc: string }[] = [
  { kind: 'agent', title: 'Agent task', desc: 'An agent does the work; can also review with a verdict' },
  { kind: 'script', title: 'Script', desc: 'A command whose exit code decides pass or fix' },
  { kind: 'gate', title: 'Human decision', desc: 'Pause until someone picks an option' },
  { kind: 'loop', title: 'Loop', desc: 'Repeat steps until a review passes (starts with author + reviewer)' },
  { kind: 'parallel', title: 'Parallel', desc: 'Run steps once per item of a list, then collect the results' },
];

/**
 * Bottom-left "+" menu. New nodes land in the middle of the view, nudged right until they
 * don't cover a card; the current positions of all cards are frozen alongside so the
 * automatic layout cannot shift them onto the new one.
 */
function AddNodeButton({
  onAdd,
}: {
  onAdd(kind: NewNodeKind, position: { x: number; y: number }, layout: CanvasLayout): void;
}) {
  const [open, setOpen] = useState(false);
  const { screenToFlowPosition, getNodes } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  return (
    <div className="add-node">
      <button type="button" className="btn" aria-label="Add a step" onClick={() => setOpen(!open)}>
        + Add step
      </button>
      <Menu open={open} onClose={() => setOpen(false)} width={300} placement="above">
        <div className="menu-label">Add a step</div>
        {NODE_CHOICES.map((choice) => (
          <button
            key={choice.kind}
            type="button"
            className="option"
            onClick={() => {
              setOpen(false);
              const center = screenToFlowPosition({ x: width / 2, y: height / 2 });
              const nodes = getNodes();
              const layout: CanvasLayout = {};
              for (const n of nodes) layout[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
              const position = { x: Math.round(center.x - 144), y: Math.round(center.y - 60) };
              const covers = (n: (typeof nodes)[number]) =>
                position.x < n.position.x + (n.measured?.width ?? 288) + 40 &&
                n.position.x < position.x + 288 + 40 &&
                position.y < n.position.y + (n.measured?.height ?? 200) + 40 &&
                n.position.y < position.y + 200 + 40;
              while (nodes.some(covers)) position.x += 120;
              onAdd(choice.kind, position, layout);
            }}
          >
            <span>
              <div className="option-title">{choice.title}</div>
              <div className="option-desc">{choice.desc}</div>
            </span>
          </button>
        ))}
      </Menu>
    </div>
  );
}

/**
 * React Flow canvas. Positions are owned locally so dragging stays smooth while run updates
 * stream in; finished drags are reported through `onLayoutChange` for persistence.
 */
function Canvas(props: {
  model: CanvasModel;
  fitKey: string;
  editable: boolean;
  onLayoutChange(layout: CanvasLayout): void;
  onBackgroundClick(): void;
  onConnect(connection: CanvasConnection): void;
  onNodeClick(nodeId: string): void;
  onEdgeClick(edgeId: string): void;
  onAddNode(kind: NewNodeKind, position: { x: number; y: number }, layout: CanvasLayout): void;
  /** A node to bring into view (e.g. one just added). */
  focusNodeId?: string | null;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const dragged = useRef<CanvasLayout>({});

  useEffect(() => {
    dragged.current = {};
  }, [props.fitKey]);

  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((n) => [n.id, n]));
      return props.model.nodes.map((node) => {
        const prior = previous.get(node.id);
        const position = dragged.current[node.id] ?? node.position;
        return { ...(prior ?? {}), ...node, position, data: node.data, draggable: true, selectable: false };
      });
    });
  }, [props.model]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const activeNodeId =
    props.model.nodes.find((n) => n.data.status === 'waiting' || n.data.status === 'running')?.id ?? null;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const { onLayoutChange } = props;
  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, draggedNodes: Node[]) => {
      for (const n of draggedNodes) dragged.current[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      const layout: CanvasLayout = {};
      for (const n of nodesRef.current) {
        layout[n.id] = dragged.current[n.id] ?? { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }
      onLayoutChange(layout);
    },
    [onLayoutChange]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={props.model.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={props.onBackgroundClick}
      nodesConnectable={props.editable}
      onConnect={(c: Connection) => props.onConnect(c)}
      isValidConnection={(c: Connection | Edge) =>
        isPlausibleConnection({
          source: c.source,
          target: c.target,
          sourceHandle: c.sourceHandle ?? null,
          targetHandle: c.targetHandle ?? null,
        })
      }
      connectionRadius={28}
      onNodeClick={props.editable ? (_e, node) => props.onNodeClick(node.id) : undefined}
      onEdgeClick={props.editable ? (_e, edge) => edge.type !== 'loop' && props.onEdgeClick(edge.id) : undefined}
      edgesFocusable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="var(--dot)" />
      {props.model.banner && (
        <div className="scope-banner" data-kind={props.model.banner.kind}>
          <div className="scope-banner-title">{props.model.banner.title}</div>
          <div className="scope-banner-text">{props.model.banner.text}</div>
        </div>
      )}
      <ZoomControl />
      {props.editable && <AddNodeButton onAdd={props.onAddNode} />}
      <FitOnChange fitKey={props.fitKey} />
      <FollowActive nodeId={activeNodeId} />
      <FollowActive nodeId={props.focusNodeId ?? null} />
    </ReactFlow>
  );
}

export function WorkflowCanvas(props: Parameters<typeof Canvas>[0]) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
