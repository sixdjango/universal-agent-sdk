import type { NodeDataRecord } from '@universal-agent/workflow-runtime';

export type { NodeDataRecord };

/** Which step's data to show. */
export interface NodeDataTarget {
  readonly runId: string;
  readonly nodeId: string;
  readonly scopeKey: string;
}

/** How the host loads saved step data (e.g. `GET /api/runs/:id/data`). */
export interface NodeDataReader {
  list(
    query: { runId: string; nodeId?: string; scopeKey?: string; namespace?: 'node' | 'run' },
    signal?: AbortSignal
  ): Promise<readonly NodeDataRecord[]>;
}

/** Records grouped by collection, in first-seen order. */
export function groupByCollection(records: readonly NodeDataRecord[]): { collection: string; records: NodeDataRecord[] }[] {
  const groups = new Map<string, NodeDataRecord[]>();
  for (const record of records) {
    const list = groups.get(record.collection) ?? [];
    list.push(record);
    groups.set(record.collection, list);
  }
  return [...groups].map(([collection, list]) => ({ collection, records: list }));
}

/** One-line rendering of a value for the list; the full value expands on demand. */
export function previewValue(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const line = (text ?? 'null').replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
