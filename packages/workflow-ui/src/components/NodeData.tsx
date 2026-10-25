import { useEffect, useState } from 'react';
import { groupByCollection, type NodeDataReader, type NodeDataRecord, type NodeDataTarget, previewValue } from '../model/node-data';

function Records({ records }: { records: readonly NodeDataRecord[] }) {
  return (
    <>
      {groupByCollection(records).map((group) => (
        <div key={group.collection} className="node-data-group">
          <div className="trace-detail-section-label">{group.collection}</div>
          {group.records.map((record) => (
            <details key={record.id} className="node-data-record">
              <summary>
                <span className="node-data-key">{record.key}</span>
                <span className="node-data-preview">{previewValue(record.value)}</span>
              </summary>
              <pre className="trace-detail-code">
                {typeof record.value === 'string' ? record.value : JSON.stringify(record.value, null, 2)}
              </pre>
              <div className="node-data-meta">
                {record.namespace === 'run' ? `saved by ${record.nodeId} · ` : ''}
                {new Date(record.updatedAtMs).toLocaleTimeString()} · attempt {record.attemptId.slice(-8)}
              </div>
            </details>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * What a step saved while it worked (`ua-workflow data …` or the `data_*` tools), plus the
 * run's shared data. Refreshes every few seconds while the run is live.
 */
export function NodeData({ reader, target, live }: { reader: NodeDataReader; target: NodeDataTarget; live: boolean }) {
  const [own, setOwn] = useState<readonly NodeDataRecord[] | null>(null);
  const [shared, setShared] = useState<readonly NodeDataRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      Promise.all([
        reader.list({ runId: target.runId, nodeId: target.nodeId, scopeKey: target.scopeKey, namespace: 'node' }, abort.signal),
        reader.list({ runId: target.runId, namespace: 'run' }, abort.signal),
      ]).then(
        ([mine, run]) => {
          setOwn(mine);
          setShared(run);
          setError(null);
        },
        (err: unknown) => {
          if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
        }
      );
    void load();
    const timer = live ? window.setInterval(() => void load(), 3000) : undefined;
    return () => {
      abort.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [reader, target.runId, target.nodeId, target.scopeKey, live]);

  if (error) return <p className="trace-detail-warning">Could not load step data: {error}</p>;
  if (!own) return <p className="node-data-empty">Loading…</p>;
  return (
    <div className="node-data">
      {own.length === 0 ? (
        <p className="node-data-empty">
          Nothing saved by this step. Steps save intermediate data with <code>ua-workflow data put</code> (scripts and shells) or the{' '}
          <code>data_put</code> tool (agents).
        </p>
      ) : (
        <Records records={own} />
      )}
      {shared.length > 0 && (
        <>
          <div className="node-data-divider">Shared in this run</div>
          <Records records={shared} />
        </>
      )}
    </div>
  );
}
