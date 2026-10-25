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
import { INPUTS_NODE_ID, OUTPUTS_NODE_ID } from '../model/scope';
import { layeredLayout } from '../model/layout';
import { FlowEdge } from './FlowEdge';
import { LoopEdge } from './LoopEdge';
import { NodeCard } from './NodeCard';

const nodeTypes = { card: NodeCard };
const edgeTypes = { flow: FlowEdge, loop: LoopEdge };

const AUTO_LAYOUT_MS = 380;
/** Auto layout wraps a long flow so each row fits the view at this zoom or larger. */
const WRAP_ZOOM = 0.75;

function AutoLayoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2" width="4.5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="10" width="4.5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10" y="6" width="4.5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 4h1.5a1.5 1.5 0 0 1 1.5 1.5V8m-3 4h1.5A1.5 1.5 0 0 0 9 10.5V8m0 0h1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Zoom out / level / in, plus "auto layout" (tidies the graph using the cards' real sizes). */
function ZoomControl({ onAutoLayout }: { onAutoLayout(): void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  return (
    <div className="zoom">
      <button type="button" className="zoom-layout" aria-label="Auto layout" title="Auto layout" onClick={onAutoLayout}>
        <AutoLayoutIcon />
      </button>
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
  { kind: 'subflow', title: 'Sub-flow', desc: 'Run another saved workflow as one step' },
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
  theme?: 'dark' | 'light';
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
  const { getNodes, fitView } = useReactFlow();
  const viewWidth = useStore((s) => s.width);
  /** Lays the current graph out again from the cards' measured sizes, animated, and saves it. */
  const autoLayout = useCallback(() => {
    const measured = getNodes();
    const positions = layeredLayout({
      nodes: measured.map((n) => ({
        id: n.id,
        width: n.measured?.width ?? n.width ?? 280,
        height: n.measured?.height ?? n.height ?? 160,
      })),
      edges: props.model.edges.filter((e) => e.type !== 'loop'),
      first: INPUTS_NODE_ID,
      last: OUTPUTS_NODE_ID,
      ...(viewWidth ? { maxRowWidth: Math.max(1200, viewWidth / WRAP_ZOOM) } : {}),
    });
    dragged.current = { ...positions };
    onLayoutChange(positions);
    // Move cards (and with them their edges) frame by frame to the new places.
    const from = new Map(measured.map((n) => [n.id, n.position]));
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const started = performance.now();
    const frame = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - started) / AUTO_LAYOUT_MS);
      const ease = 1 - (1 - t) ** 3;
      setNodes((current) =>
        current.map((n) => {
          const to = positions[n.id];
          const start = from.get(n.id);
          if (!to || !start) return n;
          return { ...n, position: { x: start.x + (to.x - start.x) * ease, y: start.y + (to.y - start.y) * ease } };
        })
      );
      if (t < 1) requestAnimationFrame(frame);
      else void fitView({ duration: 300, padding: 0.12, maxZoom: 1 });
    };
    requestAnimationFrame(frame);
  }, [getNodes, fitView, props.model.edges, onLayoutChange, viewWidth]);
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
      // Design view: opens the inspector; run view: opens the step's execution details.
      onNodeClick={(_e, node) => props.onNodeClick(node.id)}
      onEdgeClick={props.editable ? (_e, edge) => !edge.id.startsWith('$') && props.onEdgeClick(edge.id) : undefined}
      edgesFocusable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      colorMode={props.theme ?? 'dark'}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="var(--dot)" />
      <div className="connection-legend" aria-label="Connection guide">
        <span><i className="legend-execution" aria-hidden="true" />Flow · when to run</span>
        <span><i className="legend-parameter" aria-hidden="true" />Parameters · shown for the selected step</span>
        <small>Click a step to see what it passes and receives. Hover a line for details.</small>
      </div>
      {props.model.banner && (
        // A small label; the full explanation shows on hover / focus.
        <div className="scope-banner" data-kind={props.model.banner.kind} tabIndex={0}>
          <div className="scope-banner-title">ⓘ {props.model.banner.title}</div>
          <div className="scope-banner-text">{props.model.banner.text}</div>
        </div>
      )}
      <ZoomControl onAutoLayout={autoLayout} />
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
