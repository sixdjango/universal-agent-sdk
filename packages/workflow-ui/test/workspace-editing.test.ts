import { validateWorkflowDefinition, type WorkflowDefinition } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import { buildCanvasModel } from '../src/model/canvas';
import { addNode, createBlankWorkflow, updateNode } from '../src/model/editing';
import { graphAt } from '../src/model/scope';
import {
  addWorkspaceSlot,
  inheritedWorkspaceSlot,
  removeWorkspaceSlot,
  renameWorkspaceSlot,
  setDefaultWorkspaceSlot,
} from '../src/model/workspaces';

function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error((result as unknown as { error: string }).error);
  return result as Extract<T, { ok: true }>;
}

/** Two slots, an agent in the loop on `api`, an agent at the root reading `api`. */
function twoSlotWorkflow(): WorkflowDefinition {
  let d = createBlankWorkflow('Two repos', []);
  d = addWorkspaceSlot(d).definition; // main
  d = addWorkspaceSlot(d).definition; // workspace
  d = must(renameWorkspaceSlot(d, 'workspace', 'api')).definition;
  d = must(addNode(d, 'agent')).definition;
  d = must(addNode(d, 'loop')).definition;
  const agentId = d.graph.nodes.find((n) => n.kind === 'agent')!.id;
  d = updateNode(d, agentId, { readWorkspaces: ['api'] });
  d = updateNode(d, 'loop', { workspace: 'api' });
  return d;
}

describe('workspace slot editing', () => {
  it('names the first slot "main" and keeps the result valid', () => {
    const d = twoSlotWorkflow();
    expect(d.workspaces.map((s) => s.name)).toEqual(['main', 'api']);
    expect(validateWorkflowDefinition(d).ok).toBe(true);
    expect(inheritedWorkspaceSlot(d, [])).toBe('main');
    expect(inheritedWorkspaceSlot(d, ['loop'])).toBe('api');
  });

  it('renames every reference, including nested containers and read lists', () => {
    const d = must(renameWorkspaceSlot(twoSlotWorkflow(), 'api', 'backend')).definition;
    expect(d.graph.nodes.find((n) => n.id === 'loop')!.workspace).toBe('backend');
    const agent = d.graph.nodes.find((n) => n.kind === 'agent')!;
    expect(agent.kind === 'agent' && agent.readWorkspaces).toEqual(['backend']);
    expect(validateWorkflowDefinition(d).ok).toBe(true);
    expect(renameWorkspaceSlot(d, 'backend', 'main').ok).toBe(false);
    expect(renameWorkspaceSlot(d, 'backend', '9bad').ok).toBe(false);
  });

  it('removing a slot sends its nodes back to the default', () => {
    let d = setDefaultWorkspaceSlot(twoSlotWorkflow(), 'api');
    expect(d.defaultWorkspace).toBe('api');
    d = removeWorkspaceSlot(d, 'api');
    expect(d.defaultWorkspace).toBeUndefined();
    expect(d.graph.nodes.find((n) => n.id === 'loop')!.workspace).toBeUndefined();
    expect(validateWorkflowDefinition(d).ok).toBe(true);
  });

  it('shows the slot on cards, and the bound directory in a run', () => {
    const d = twoSlotWorkflow();
    const design = buildCanvasModel({ definition: d });
    const row = (model: typeof design, id: string) =>
      model.nodes.find((n) => n.id === id)?.data.rows.find((r) => r.id === 'workspace')?.value;
    const agentId = d.graph.nodes.find((n) => n.kind === 'agent')!.id;
    expect(row(design, agentId)).toBe('main');
    expect(row(design, 'loop')).toBe('api');
    const inner = buildCanvasModel({ definition: d, path: ['loop'] });
    expect(row(inner, graphAt(d, ['loop']).nodes[0]!.id)).toBe('api');

    const single = buildCanvasModel({ definition: addWorkspaceSlot(createBlankWorkflow('One', [])).definition });
    expect(single.nodes.every((n) => !n.data.rows?.some((r) => r.id === 'workspace'))).toBe(true);
  });
});
