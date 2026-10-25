import { computeDefinitionDigest } from './canonical';
import { type EdgeCondition, listWorkspaceSlots, type LoopNode, type SubflowNode, type WorkflowDefinition, type WorkflowGraph, type WorkflowNode } from './schema';

/** Sub-flows nest at most this deep (a guard against runaway chains). */
export const MAX_SUBFLOW_DEPTH = 8;

export class SubflowResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubflowResolutionError';
  }
}

/** Applies `fn` to every node of `graph` and of the graphs nested in its containers. */
function mapNodes(graph: WorkflowGraph, fn: (node: WorkflowNode) => WorkflowNode): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const mapped = fn(node);
      if (mapped.kind === 'loop') return { ...mapped, bodyGraph: mapNodes(mapped.bodyGraph, fn) };
      if (mapped.kind === 'parallel') return { ...mapped, itemGraph: mapNodes(mapped.itemGraph, fn) };
      return mapped;
    }),
  };
}

async function mapNodesAsync(graph: WorkflowGraph, fn: (node: WorkflowNode) => Promise<WorkflowNode>): Promise<WorkflowGraph> {
  const nodes: WorkflowNode[] = [];
  for (const node of graph.nodes) {
    let mapped = await fn(node);
    if (mapped.kind === 'loop') mapped = { ...mapped, bodyGraph: await mapNodesAsync(mapped.bodyGraph, fn) };
    if (mapped.kind === 'parallel') mapped = { ...mapped, itemGraph: await mapNodesAsync(mapped.itemGraph, fn) };
    nodes.push(mapped);
  }
  return { ...graph, nodes };
}

/**
 * Embeds the workflow every sub-flow step runs (`snapshot`), recursively, loading saved
 * workflows through `load`. Hosts call this when a run starts so the run is reproducible.
 * Throws `SubflowResolutionError` for unknown workflows, cycles (A runs B runs A) and chains
 * deeper than `MAX_SUBFLOW_DEPTH`.
 */
export async function resolveSubflows(
  definition: WorkflowDefinition,
  load: (workflowId: string) => Promise<WorkflowDefinition | null | undefined>
): Promise<WorkflowDefinition> {
  const resolve = async (def: WorkflowDefinition, chain: readonly string[]): Promise<WorkflowDefinition> => {
    const graph = await mapNodesAsync(def.graph, async (node) => {
      if (node.kind !== 'subflow') return node;
      if (!node.workflowId) throw new SubflowResolutionError(`Sub-flow step "${node.name}" does not say which workflow to run`);
      if (chain.includes(node.workflowId)) {
        throw new SubflowResolutionError(`Sub-flows run in a circle: ${[...chain, node.workflowId].join(' → ')}`);
      }
      if (chain.length >= MAX_SUBFLOW_DEPTH) {
        throw new SubflowResolutionError(`Sub-flows nest more than ${MAX_SUBFLOW_DEPTH} levels deep`);
      }
      const child = await load(node.workflowId);
      if (!child) throw new SubflowResolutionError(`Sub-flow step "${node.name}" runs workflow "${node.workflowId}", which does not exist`);
      const resolved = await resolve(child, [...chain, node.workflowId]);
      const snapshot = {
        workflowId: resolved.id,
        digest: computeDefinitionDigest(resolved),
        name: resolved.name,
        inputs: resolved.inputs,
        outputs: resolved.outputs,
        graph: resolved.graph,
      };
      return { ...node, snapshot } satisfies SubflowNode;
    });
    return { ...def, graph };
  };
  return resolve(definition, [definition.id]);
}

/**
 * A condition that never holds: a sub-flow runs its workflow once. (Its source does not
 * exist, so it evaluates false and the single round's own result decides.)
 */
export const RUN_ONCE: EdgeCondition = { kind: 'port_truthy', port: '__never__', sourceNodeId: '$input' };

/**
 * Turns every sub-flow step that carries a snapshot into a `LoopNode` that runs the embedded
 * workflow once, so runs reuse the loop machinery (scopes, trace, chief). Steps without a
 * snapshot stay as they are (editors validate them as plain steps; runs refuse them).
 * Workspace slots the parent does not declare are dropped, so those steps use the slot
 * the sub-flow step works in.
 */
export function embedSubflows(graph: WorkflowGraph, declaredSlots: ReadonlySet<string>, preserveParallel = false): WorkflowGraph {
  const knownSlot = (node: WorkflowNode): WorkflowNode => {
    let next = node;
    if (next.workspace && !declaredSlots.has(next.workspace)) {
      const { workspace: _w, ...rest } = next;
      next = rest as WorkflowNode;
    }
    if (next.kind === 'agent' && next.readWorkspaces.some((s) => !declaredSlots.has(s))) {
      next = { ...next, readWorkspaces: next.readWorkspaces.filter((s) => declaredSlots.has(s)) };
    }
    return next;
  };
  return mapNodes(graph, (node) => {
    if (node.kind !== 'subflow' || !node.snapshot || (preserveParallel && node.parallel)) return node;
    const { snapshot } = node;
    const loop: LoopNode = {
      kind: 'loop',
      id: node.id,
      name: node.name,
      ...(node.description ? { description: node.description } : {}),
      inputs: snapshot.inputs,
      outputs: snapshot.outputs,
      writeScopes: [],
      maxTechnicalRetries: 0,
      ...(node.workspace ? { workspace: node.workspace } : {}),
      ...(node.isolation ? { isolation: node.isolation } : {}),
      ...(node.enforceWriteScopes !== undefined ? { enforceWriteScopes: node.enforceWriteScopes } : {}),
      maxRounds: 1,
      continueWhen: RUN_ONCE,
      onExhausted: 'fail',
      bodyGraph: embedSubflows(mapNodes(snapshot.graph, knownSlot), declaredSlots, preserveParallel),
      origin: { subflowOf: snapshot.workflowId, digest: snapshot.digest },
    };
    return loop;
  });
}

const embedded = new WeakMap<WorkflowDefinition, WorkflowDefinition>();

/**
 * `definition` as its runs execute it: sub-flow steps with a snapshot become the loops that
 * run them (see `embedSubflows`). Cached per definition, so viewers can call it freely.
 */
export function withEmbeddedSubflows(definition: WorkflowDefinition): WorkflowDefinition {
  let result = embedded.get(definition);
  if (!result) {
    const slots = new Set(listWorkspaceSlots(definition).map((s) => s.name));
    result = { ...definition, graph: embedSubflows(definition.graph, slots, true) };
    embedded.set(definition, result);
  }
  return result;
}

/** The saved workflow a node runs as a sub-flow (a sub-flow step, or the loop it became). */
export function subflowWorkflowId(node: WorkflowNode): string | undefined {
  if (node.kind === 'subflow') return node.workflowId;
  if (node.kind === 'loop' && node.origin && 'subflowOf' in node.origin) return node.origin.subflowOf;
  return undefined;
}
