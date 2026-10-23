import { describe, expect, it } from 'vitest';
import { createWorkflowBuilder } from '../src/index';

const writer = (id: string, writeScopes: string[], extra: Record<string, unknown> = {}) =>
  ({ id, name: id, role: 'author', goal: 'x', writeScopes, ...extra }) as const;

describe('write policies', () => {
  it('isolates writers that may run at the same time in one slot, and nobody else', () => {
    const plan = createWorkflowBuilder('fan')
      .addAgent(writer('ui', ['src/ui']))
      .addAgent(writer('api', ['src/api']))
      .addAgent(writer('same_a', ['src/shared']))
      .addAgent(writer('same_b', ['src/shared'])) // overlapping scopes: the scheduler serializes these
      .addAgent(writer('read', []))
      .addAgent(writer('after', ['src']))
      .connectControl('ui', 'after')
      .connectControl('api', 'after')
      .connectControl('same_a', 'after')
      .connectControl('same_b', 'after')
      .compile();
    const isolated = Object.entries(plan.rootScope.writePolicies)
      .filter(([, p]) => p.isolated)
      .map(([id]) => id)
      .sort();
    // ui/api run alongside each other (and alongside same_a/same_b, whose scopes differ).
    expect(isolated).toEqual(['api', 'same_a', 'same_b', 'ui']);
    expect(plan.rootScope.writePolicies.after!.isolated).toBe(false);
    expect(plan.rootScope.writePolicies.read!.isolated).toBe(false);
  });

  it('treats different slots as independent and honours explicit modes', () => {
    const plan = createWorkflowBuilder('modes')
      .addWorkspace({ name: 'web' })
      .addWorkspace({ name: 'api' })
      .addAgent(writer('a', ['src']))
      .addAgent(writer('b', ['lib'], { workspace: 'api' }))
      .addAgent(writer('c', ['docs'], { isolation: 'worktree', enforceWriteScopes: true }))
      .addAgent(writer('d', ['test'], { isolation: 'shared' }))
      .connectControl('c', 'd')
      .compile();
    const p = plan.rootScope.writePolicies;
    expect(p.b).toEqual({ isolated: false, enforceWriteScopes: false }); // alone in its slot
    expect(p.c).toEqual({ isolated: true, enforceWriteScopes: true });
    expect(p.d!.isolated).toBe(false);
    expect(p.a!.isolated).toBe(true); // may run alongside c and d in "web"
  });

  it('isolates writers inside parallel items, and inherits container settings', () => {
    const plan = createWorkflowBuilder('items')
      .addWorkflowInput({ name: 'items', type: 'array', required: true })
      .addParallel({
        id: 'each',
        name: 'Each',
        maxConcurrency: 3,
        enforceWriteScopes: true,
        itemBody: (b) => b.addScript({ id: 'edit', name: 'Edit', command: 'true', writeScopes: ['out'] }).addScript({ id: 'look', name: 'Look', command: 'true' }),
      })
      .addParallel({
        id: 'serial',
        name: 'Serial',
        maxConcurrency: 1,
        itemBody: (b) => b.addScript({ id: 'edit', name: 'Edit', command: 'true', writeScopes: ['out'] }),
      })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'each', toPort: 'items' })
      .connectData({ fromNodeId: '$input', fromPort: 'items', toNodeId: 'serial', toPort: 'items' })
      .connectControl('each', 'serial')
      .compile();
    expect(plan.rootScope.childScopes.each!.writePolicies).toEqual({
      edit: { isolated: true, enforceWriteScopes: true },
      look: { isolated: false, enforceWriteScopes: true },
    });
    expect(plan.rootScope.childScopes.serial!.writePolicies.edit!.isolated).toBe(false);
  });
});
