import type { EdgeCondition } from '@universal-agent/workflow-contract';

const OP_TEXT = { '==': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤' } as const;

/** A condition in words, without the leading "if": `PASS and score ≥ 80`. */
export function conditionText(condition: EdgeCondition, nested = false): string {
  switch (condition.kind) {
    case 'always':
      return 'always';
    case 'otherwise':
      return 'otherwise';
    case 'verdict_is':
      return condition.verdict;
    case 'verdict_in':
      return condition.verdicts.join(' / ');
    case 'port_equals':
      return `${condition.port} = ${String(condition.value)}`;
    case 'port_truthy':
      return condition.port;
    case 'port_compare':
      return `${condition.measure === 'length' ? `count of ${condition.port}` : condition.port} ${OP_TEXT[condition.op]} ${String(condition.value)}`;
    case 'all':
    case 'any': {
      const text = condition.conditions.map((c) => conditionText(c, true)).join(condition.kind === 'all' ? ' and ' : ' or ');
      return nested && condition.conditions.length > 1 ? `(${text})` : text;
    }
  }
}
