import { describe, expect, it } from 'vitest';
import { compileWorkflowDefinition, computeDefinitionDigest, createWorkflowBuilder, nodeBoundaryPorts, resolveSubflows, validateWorkflowDefinition, withEmbeddedSubflows } from '../src/index';

const input = { name: 'text', type: 'string' as const, required: true };
const output = { name: 'result', type: 'string' as const, required: true };
const parallel = { itemsPort: 'text', maxConcurrency: 2, failurePolicy: 'settle_all' as const };
const flow = () => createWorkflowBuilder('batch').addWorkflowInput({ ...input, type: 'array' }).addWorkflowOutput({ ...output, type: 'array' })
  .addAgent({ id: 'work', name: 'Work', role: 'worker', goal: 'Work', inputs: [input], outputs: [output], parallel: { ...parallel }, writeScopes: ['src'] })
  .connectData({ fromNodeId: '$input', fromPort: 'text', toNodeId: 'work', toPort: 'text' })
  .connectData({ fromNodeId: 'work', fromPort: 'result', toNodeId: '$output', toPort: 'result' }).buildDefinition();

describe('per-node parallel contract', () => {
  it('preserves the authored node, ports and edges, and isolates item writers in the compiled plan', () => {
    const definition = flow();
    const before = JSON.stringify(definition);
    const plan = compileWorkflowDefinition(definition);
    expect(JSON.stringify(definition)).toBe(before);
    expect(plan.definition.graph.nodes[0]!.kind).toBe('agent');
    expect(plan.rootScope.nodesById.work).toMatchObject({ kind: 'parallel', origin: { nodeKind: 'agent' }, inputs: [{ name: 'text', type: 'array' }], outputs: [{ name: 'result', type: 'array' }] });
    expect(plan.rootScope.childScopes.work!.nodesById.work).toMatchObject({ kind: 'agent', inputs: [input], outputs: [output] });
    expect(plan.rootScope.childScopes.work!.writePolicies.work!.isolated).toBe(true);
    expect(nodeBoundaryPorts(definition.graph.nodes[0]!, 'out')[0]!.type).toBe('array');
  });

  it('includes the execution settings in the frozen definition digest', () => {
    const definition = flow();
    const digest = computeDefinitionDigest(definition);
    (definition.graph.nodes[0] as any).parallel.maxConcurrency = 1;
    expect(computeDefinitionDigest(definition)).not.toBe(digest);
  });

  it('rejects missing item ports and invalid concurrency instead of silently ignoring settings', () => {
    const definition = flow();
    (definition.graph.nodes[0] as any).parallel.itemsPort = 'missing';
    expect(validateWorkflowDefinition(definition)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_PARALLEL', nodeId: 'work' })]) });
    (definition.graph.nodes[0] as any).parallel.maxConcurrency = 0;
    expect(validateWorkflowDefinition(definition).ok).toBe(false);
  });

  it('keeps normal execution when the property is absent', () => {
    const definition = flow();
    delete (definition.graph.nodes[0] as any).parallel;
    expect(compileWorkflowDefinition(definition).rootScope.childScopes).toEqual({});
  });

  it('expands a frozen subflow inside each item and retains its authored representation for the viewer', async () => {
    const child = flow();
    const parent = createWorkflowBuilder('parent').addWorkflowInput({ ...input, type: 'array' })
      .addSubflow({ id: 'sub', name: 'Sub', workflowId: child.id, inputs: child.inputs, outputs: child.outputs, parallel })
      .connectData({ fromNodeId: '$input', fromPort: 'text', toNodeId: 'sub', toPort: 'text' }).buildDefinition();
    const definition = await resolveSubflows(parent, async () => child);
    const plan = compileWorkflowDefinition(definition);
    expect(plan.rootScope.nodesById.sub).toMatchObject({ kind: 'parallel', origin: { nodeKind: 'subflow' } });
    expect(plan.rootScope.childScopes.sub!.nodesById.sub!.kind).toBe('loop');
    expect(plan.rootScope.childScopes.sub!.childScopes.sub!.nodesById.work!.kind).toBe('parallel');
    expect(withEmbeddedSubflows(definition).graph.nodes[0]).toMatchObject({ kind: 'subflow', parallel });
  });
});
