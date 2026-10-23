import { useState } from 'react';
import { api, type WorkflowRecord } from '../api';
import { describeError } from '../format';

/** Paste a WorkflowDefinition JSON (e.g. built with the SDK) to save it as a new workflow. */
export function ImportPanel({ onDone, onError }: { onDone(record: WorkflowRecord): void; onError(message: string): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      onDone(await api.createWorkflow(JSON.parse(text)));
    } catch (err) {
      onError(err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="menu-label">Paste a WorkflowDefinition (JSON)</div>
      <label className="field">
        <textarea rows={8} autoFocus value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </label>
      <div className="popover-footer">
        <button type="button" className="btn btn-primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
          Import
        </button>
      </div>
    </>
  );
}
