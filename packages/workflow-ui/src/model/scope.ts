import type {
  LoopNode,
  ParallelNode,
  PortDefinition,
  WorkflowDefinition,
  WorkflowGraph,
} from '@universal-agent/workflow-contract';
import { PARALLEL_ITEM_INDEX_PORT } from '@universal-agent/workflow-contract';

/**
 * A position in the workflow's nesting: container node ids from the root graph down,
 * e.g. `[]` is the root graph and `['fix_loop']` is that loop's body.
 */
export type ScopePath = readonly string[];

export const INPUTS_NODE_ID = '$input';
export const OUTPUTS_NODE_ID = '$output';

export type ContainerNode = LoopNode | ParallelNode;

/** Fields every parallel item receives without declaring them (see the contract compiler). */
export const PARALLEL_ITEM_PORTS: readonly PortDefinition[] = [PARALLEL_ITEM_INDEX_PORT];

/**
 * What a container's steps receive through `$input`: its own inputs, except that inside a
 * parallel step the items port holds one item, next to the item's index.
 */
export function containerScopeInputs(container: ContainerNode): PortDefinition[] {
  if (container.kind !== 'parallel') return container.inputs;
  return [
    ...container.inputs.map((port) =>
      port.name === container.itemsPort ? { ...port, type: 'json' as const, description: port.description ?? 'This item' } : port
    ),
    ...PARALLEL_ITEM_PORTS,
  ];
}

export function innerGraph(container: ContainerNode): WorkflowGraph {
  return container.kind === 'loop' ? container.bodyGraph : container.itemGraph;
}

/** The container whose body `path` points into (null at the root). */
export function containerAt(definition: WorkflowDefinition, path: ScopePath): ContainerNode | null {
  let graph = definition.graph;
  let container: ContainerNode | null = null;
  for (const id of path) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node || (node.kind !== 'loop' && node.kind !== 'parallel')) {
      throw new Error(`No loop or parallel step "${id}" at ${path.join(' / ') || 'the root'}`);
    }
    container = node;
    graph = innerGraph(node);
  }
  return container;
}

export function graphAt(definition: WorkflowDefinition, path: ScopePath): WorkflowGraph {
  const container = containerAt(definition, path);
  return container ? innerGraph(container) : definition.graph;
}

/** Replaces the graph at `path`, rebuilding every enclosing container immutably. */
export function mapGraphAt(
  definition: WorkflowDefinition,
  path: ScopePath,
  fn: (graph: WorkflowGraph) => WorkflowGraph
): WorkflowDefinition {
  if (path.length === 0) return { ...definition, graph: fn(definition.graph) };
  const containerId = path[path.length - 1]!;
  return mapGraphAt(definition, path.slice(0, -1), (parent) => ({
    ...parent,
    nodes: parent.nodes.map((n) => {
      if (n.id !== containerId) return n;
      if (n.kind === 'loop') return { ...n, bodyGraph: fn(n.bodyGraph) };
      if (n.kind === 'parallel') return { ...n, itemGraph: fn(n.itemGraph) };
      return n;
    }),
  }));
}

/** Compiler scope path for issues (`$root`, `$root/fix_loop`, ...). */
export function compilerScopePath(path: ScopePath): string {
  return ['$root', ...path].join('/');
}

/** Layout key for a card: root cards keep their bare id, nested ones are prefixed by path. */
export function layoutKey(path: ScopePath, nodeId: string): string {
  return path.length === 0 ? nodeId : `${path.join('/')}/${nodeId}`;
}
