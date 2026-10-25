import type { AgentNode, NodeParallel, ParallelNode, PortDefinition, ScriptNode, SubflowNode, WorkflowGraph, WorkflowNode } from './schema';

export type ParallelizableNode = AgentNode | ScriptNode | SubflowNode;

export function supportsParallel(node: WorkflowNode): node is ParallelizableNode {
  return node.kind === 'agent' || node.kind === 'script' || node.kind === 'subflow';
}

export function nodeParallel(node: WorkflowNode): NodeParallel | undefined {
  return supportsParallel(node) ? node.parallel : undefined;
}

/** Ports seen by edges; node.inputs/outputs continue to describe an individual call. */
export function nodeBoundaryPorts(node: WorkflowNode, side: 'in' | 'out'): PortDefinition[] {
  const parallel = nodeParallel(node);
  return (side === 'in' ? node.inputs : node.outputs).map((port) =>
    parallel && (side === 'out' || port.name === parallel.itemsPort)
      ? { ...port, type: 'array', ...(side === 'in' ? { required: true } : {}) }
      : port
  );
}

export interface ParallelLoweringIssue { nodeId: string; scopePath: string; message: string }

/** Reuse the scheduler's item scopes, keeping the authored node ID in every item.
 * This is an execution-plan transformation, never a mutation of the saved graph. */
export function lowerNodeParallel(graph: WorkflowGraph, scopePath = '$root', issues: ParallelLoweringIssue[] = []): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map((original): WorkflowNode => {
    let node = original;
    if (node.kind === 'loop') node = { ...node, bodyGraph: lowerNodeParallel(node.bodyGraph, `${scopePath}/${node.id}`, issues) };
    if (node.kind === 'parallel') node = { ...node, itemGraph: lowerNodeParallel(node.itemGraph, `${scopePath}/${node.id}`, issues) };
    if (node.kind === 'subflow' && node.snapshot) {
      node = { ...node, snapshot: { ...node.snapshot, graph: lowerNodeParallel(node.snapshot.graph, `${scopePath}/${node.id}`, issues) } };
    }
    if (!supportsParallel(node) || !node.parallel) return node;
    const { parallel, ...single } = node;
    if (!node.inputs.some((p) => p.name === parallel.itemsPort)) {
      issues.push({ nodeId: node.id, scopePath, message: `Parallel input "${parallel.itemsPort}" is not an input of "${node.name}"` });
    }
    const container: ParallelNode = {
      id: node.id, name: node.name, description: node.description,
      kind: 'parallel', origin: { nodeKind: node.kind },
      inputs: nodeBoundaryPorts(node, 'in'), outputs: nodeBoundaryPorts(node, 'out'),
      writeScopes: node.writeScopes, maxTechnicalRetries: 0,
      workspace: node.workspace, isolation: node.isolation, enforceWriteScopes: node.enforceWriteScopes,
      ...parallel,
      itemGraph: {
        nodes: [single as WorkflowNode], controlEdges: [],
        dataEdges: [
          ...node.inputs.map((p) => ({ id: `input:${p.name}`, fromNodeId: '$input', fromPort: p.name, toNodeId: node.id, toPort: p.name, required: p.required,
            delivery: graph.dataEdges.find(e => e.toNodeId === node.id && e.toPort === p.name)?.delivery ?? 'auto' as const })),
          ...node.outputs.map((p) => ({ id: `output:${p.name}`, fromNodeId: node.id, fromPort: p.name, toNodeId: '$output', toPort: p.name, required: p.required, delivery: 'auto' as const })),
        ],
      },
    };
    return container;
  }) };
}
