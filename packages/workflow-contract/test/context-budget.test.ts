import { describe, expect, it } from 'vitest';
import { AgentNodeSchema, ContextBudgetConfigSchema } from '../src/index';

describe('context budget defaults', () => {
  it.each([{}, { pageReadBytes: 4096 }])('does not add a cumulative quota to %j', (config) => {
    const node = AgentNodeSchema.parse({
      id: 'reader', name: 'Reader', kind: 'agent', role: 'reader', goal: 'Read the report',
      contextBudget: config,
    });

    expect(node.contextBudget?.initialBundleBytes).toBe(32 * 1024);
    expect(node.contextBudget?.pageReadBytes).toBe(config.pageReadBytes ?? 8 * 1024);
    expect(node.contextBudget?.stageReadQuotaBytes).toBeUndefined();
    expect(JSON.parse(JSON.stringify(node)).contextBudget).not.toHaveProperty('stageReadQuotaBytes');
  });

  it('preserves explicitly configured quotas, including a saved 128 KiB quota', () => {
    const config = ContextBudgetConfigSchema.parse({ stageReadQuotaBytes: 128 * 1024 });
    expect(config.stageReadQuotaBytes).toBe(128 * 1024);
    expect(ContextBudgetConfigSchema.parse(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });
});
