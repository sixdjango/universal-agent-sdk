import { useEffect, useRef, useState } from 'react';
import {
  readConversationTranscript, readNodeConversationCalls,
  type ConversationCall, type ConversationReader, type ConversationTranscript, type NodeConversationTarget,
} from '../model/conversation';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Only mounted details read history. Effects cancel in-flight work on selection/unmount. */
export function useNodeConversationCalls(reader: ConversationReader, target: NodeConversationTarget, live: boolean, refresh: number) {
  const [state, setState] = useState<{ calls: ConversationCall[]; loading: boolean; error: string | null }>({ calls: [], loading: true, error: null });
  const cache = useRef<ConversationCall[]>([]);
  const { runId, scopeKey, nodeId } = target;
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setState(value => ({ ...value, loading: true }));
      try {
        const calls = await readNodeConversationCalls(reader, { runId, scopeKey, nodeId }, abort.signal, cache.current);
        if (abort.signal.aborted) return;
        cache.current = calls;
        setState({ calls, loading: false, error: null });
        if (live || calls.some(call => call.record.status === 'open')) timer = setTimeout(load, 1500);
      } catch (error) {
        if (abort.signal.aborted) return;
        setState(value => ({ ...value, loading: false, error: errorText(error) }));
        if (live || cache.current.some(call => call.record.status === 'open')) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [reader, runId, scopeKey, nodeId, live, refresh]);
  return state;
}

export function useConversationTranscript(reader: ConversationReader, id: string | null, refresh: number) {
  const [state, setState] = useState<{ id: string | null; value: ConversationTranscript | null; loading: boolean; error: string | null }>({ id, value: null, loading: true, error: null });
  const cache = useRef<ConversationTranscript | undefined>(undefined);
  useEffect(() => {
    if (cache.current?.record.id !== id) cache.current = undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setState({ id, value: cache.current ?? null, loading: Boolean(id), error: null });
    if (!id) return () => abort.abort();
    const publish = (value: ConversationTranscript, loading: boolean) => {
      if (abort.signal.aborted) return;
      cache.current = value;
      setState({ id, value, loading, error: null });
    };
    const load = async () => {
      try {
        const value = await readConversationTranscript(reader, id, abort.signal, {
          previous: cache.current, onPage: value => publish(value, true),
        });
        if (abort.signal.aborted) return;
        publish(value, false);
        if (value.record.status === 'open') timer = setTimeout(load, 1500);
      } catch (error) {
        if (abort.signal.aborted) return;
        setState(value => ({ ...value, loading: false, error: errorText(error) }));
        // Keep the partial cursor. Retry when the connection returns, or via Refresh.
        timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [reader, id, refresh]);
  // Never flash the previous call while React is committing a new selection.
  return state.id === id ? state : { value: null, loading: Boolean(id), error: null };
}
