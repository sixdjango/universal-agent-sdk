import {
  defaultWorkspaceSlot,
  listWorkspaceSlots,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkspaceSlot,
} from '@universal-agent/workflow-contract';
import { uniqueName } from './editing';
import { innerGraph, type ScopePath } from './scope';

export { defaultWorkspaceSlot, listWorkspaceSlots };

/** Applies `fn` to every node of every graph, depth first. */
function mapAllNodes(graph: WorkflowGraph, fn: (node: WorkflowNode) => WorkflowNode): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const mapped = fn(node);
      if (mapped.kind === 'loop') return { ...mapped, bodyGraph: mapAllNodes(mapped.bodyGraph, fn) };
      if (mapped.kind === 'parallel') return { ...mapped, itemGraph: mapAllNodes(mapped.itemGraph, fn) };
      return mapped;
    }),
  };
}

/** Rewrites every node's slot references; `to: null` drops the reference (the node inherits again). */
function retargetSlot(definition: WorkflowDefinition, from: string, to: string | null): WorkflowGraph {
  return mapAllNodes(definition.graph, (node) => {
    let next = node;
    if (node.workspace === from) {
      const { workspace: _w, ...rest } = node;
      next = (to ? { ...rest, workspace: to } : rest) as WorkflowNode;
    }
    if (next.kind === 'agent' && next.readWorkspaces.includes(from)) {
      next = {
        ...next,
        readWorkspaces: to ? next.readWorkspaces.map((s) => (s === from ? to : s)) : next.readWorkspaces.filter((s) => s !== from),
      };
    }
    return next;
  });
}

/**
 * Adds a slot. The first slot of a workflow is called `main`, matching the implicit slot it
 * replaces, so nodes that already say `main` keep working.
 */
export function addWorkspaceSlot(definition: WorkflowDefinition): { definition: WorkflowDefinition; name: string } {
  const taken = definition.workspaces.map((s) => s.name);
  const name = taken.length === 0 ? 'main' : uniqueName('workspace', taken);
  return { definition: { ...definition, workspaces: [...definition.workspaces, { name, required: true }] }, name };
}

export function updateWorkspaceSlot(
  definition: WorkflowDefinition,
  name: string,
  patch: Partial<Pick<WorkspaceSlot, 'description' | 'required'>>
): WorkflowDefinition {
  return {
    ...definition,
    workspaces: definition.workspaces.map((slot) => {
      if (slot.name !== name) return slot;
      const next = { ...slot, ...patch };
      if (!next.description) delete next.description;
      return next;
    }),
  };
}

/** Renames a slot and every reference to it. */
export function renameWorkspaceSlot(
  definition: WorkflowDefinition,
  from: string,
  to: string
): { ok: true; definition: WorkflowDefinition } | { ok: false; error: string } {
  if (from === to) return { ok: true, definition };
  if (!/^[A-Za-z_][\w-]*$/.test(to)) return { ok: false, error: 'Use letters, digits, "_" and "-", starting with a letter' };
  if (definition.workspaces.some((s) => s.name === to)) return { ok: false, error: `"${to}" already exists` };
  const next: WorkflowDefinition = {
    ...definition,
    workspaces: definition.workspaces.map((s) => (s.name === from ? { ...s, name: to } : s)),
    graph: retargetSlot(definition, from, to),
  };
  if (definition.defaultWorkspace === from) next.defaultWorkspace = to;
  return { ok: true, definition: next };
}

/** Removes a slot; nodes that used it fall back to the default slot. */
export function removeWorkspaceSlot(definition: WorkflowDefinition, name: string): WorkflowDefinition {
  const next: WorkflowDefinition = {
    ...definition,
    workspaces: definition.workspaces.filter((s) => s.name !== name),
    graph: retargetSlot(definition, name, null),
  };
  if (next.defaultWorkspace === name || next.workspaces.length === 0) delete next.defaultWorkspace;
  return next;
}

export function setDefaultWorkspaceSlot(definition: WorkflowDefinition, name: string): WorkflowDefinition {
  const next = { ...definition };
  // The first slot is the default anyway; only store an explicit choice.
  if (definition.workspaces[0]?.name === name) delete next.defaultWorkspace;
  else next.defaultWorkspace = name;
  return next;
}

/** Slot that nodes in the graph at `path` inherit when they name none. */
export function inheritedWorkspaceSlot(definition: WorkflowDefinition, path: ScopePath): string {
  let slot = defaultWorkspaceSlot(definition);
  let graph = definition.graph;
  for (const id of path) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node || (node.kind !== 'loop' && node.kind !== 'parallel')) break;
    slot = node.workspace ?? slot;
    graph = innerGraph(node);
  }
  return slot;
}

/** Whether the canvas should mention workspaces at all (only once the workflow declares several). */
export function showsWorkspaces(definition: WorkflowDefinition): boolean {
  return definition.workspaces.length > 1;
}
