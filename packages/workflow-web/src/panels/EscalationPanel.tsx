import type { WaitRequest } from '@universal-agent/workflow-contract';
import { useState } from 'react';

/** The chief's open question to you, answered from the status pill. */
export function EscalationPanel({ wait, onAnswer }: { wait: WaitRequest; onAnswer(answer: string): void }) {
  const [text, setText] = useState('');
  return (
    <>
      <div className="menu-label">The chief agent asks: {wait.prompt}</div>
      {wait.options.length > 0 ? (
        wait.options.map((option) => (
          <button key={option.value} type="button" className="option" onClick={() => onAnswer(option.value)}>
            <span className="option-title">{option.label}</span>
          </button>
        ))
      ) : (
        <>
          <label className="field">
            <textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="popover-footer">
            <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => onAnswer(text.trim())}>
              Reply
            </button>
          </div>
        </>
      )}
    </>
  );
}
