import { applyRunLogEntry, type RunLogEntry, type WorkflowRunState } from '@universal-agent/workflow-runtime';
import { useEffect, useState } from 'react';

export interface RunStream {
  readonly run: WorkflowRunState | null;
  /** Whether the server is currently driving this run. */
  readonly active: boolean;
  /** Whether the chief is working on an answer to a message. */
  readonly chiefAnswering: boolean;
  readonly error: string | null;
}

/**
 * Follows a run through the server's SSE log. State is rebuilt in the browser with the
 * runtime's own `applyRunLogEntry`, so the canvas sees exactly what the server folded.
 * EventSource reconnects with `Last-Event-ID`; entries at or below the current seq are skipped.
 */
export interface RunStreamOptions {
  /** Server-Sent Events URL of a run's log (default: the workflow server's `./api/runs/<id>/stream`). */
  readonly url?: (runId: string) => string;
}

const defaultStreamUrl = (runId: string) => `./api/runs/${encodeURIComponent(runId)}/stream`;

export function useRunStream(runId: string | null, options: RunStreamOptions = {}): RunStream {
  const streamUrl = options.url ?? defaultStreamUrl;
  const [stream, setStream] = useState<RunStream>({ run: null, active: false, chiefAnswering: false, error: null });

  useEffect(() => {
    setStream({ run: null, active: false, chiefAnswering: false, error: null });
    if (!runId) return;

    let state: WorkflowRunState | null = null;
    let active = false;
    let chiefAnswering = false;
    let frame = 0;
    const publish = () => {
      frame = 0;
      setStream({ run: state, active, chiefAnswering, error: null });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(publish);
    };

    const source = new EventSource(streamUrl(runId));
    source.addEventListener('log', (event) => {
      const entry = JSON.parse((event as MessageEvent<string>).data) as RunLogEntry;
      if (state && entry.seq <= state.revision) return;
      try {
        state = applyRunLogEntry(state, entry);
      } catch (err) {
        setStream({ run: state, active, chiefAnswering, error: err instanceof Error ? err.message : String(err) });
        source.close();
        return;
      }
      schedule();
    });
    source.addEventListener('activity', (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as { active: boolean; chiefAnswering?: boolean };
      if (next.active !== active || (next.chiefAnswering ?? false) !== chiefAnswering) {
        active = next.active;
        chiefAnswering = next.chiefAnswering ?? false;
        schedule();
      }
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setStream({ run: state, active: false, chiefAnswering: false, error: 'Lost connection to the server' });
      }
    };

    return () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
    };
    // Only a new run id reconnects; a fresh `url` function on every render must not.
  }, [runId]);

  return stream;
}
