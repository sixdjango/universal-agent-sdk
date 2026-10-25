import { describe, expect, it } from 'vitest';
import { describeCondition } from '../src/model/canvas';

describe('condition labels', () => {
  it('reads comparisons and combined conditions on edge labels', () => {
    expect(describeCondition({ kind: 'port_compare', port: 'score', op: '>=', value: 80 })).toBe('if score ≥ 80');
    expect(describeCondition({ kind: 'port_compare', port: 'issues', op: '==', value: 0, measure: 'length' })).toBe('if count of issues = 0');
    expect(
      describeCondition({
        kind: 'all',
        conditions: [
          { kind: 'verdict_is', verdict: 'PASS' },
          { kind: 'any', conditions: [{ kind: 'port_compare', port: 'coverage', op: '>', value: 0.8 }, { kind: 'port_truthy', port: 'waived' }] },
        ],
      })
    ).toBe('if PASS and (coverage > 0.8 or waived)');
    expect(describeCondition({ kind: 'otherwise' })).toBe('otherwise');
    expect(describeCondition(undefined)).toBeUndefined();
  });
});
