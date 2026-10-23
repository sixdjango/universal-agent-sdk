import {
  type ChiefLevel,
  type ChiefPolicy,
  ChiefPolicySchema,
  type WaitRequest,
} from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentListing } from '../types';
import { buildChiefThread, type ChiefThreadItem, TRIGGER_LABEL } from '../model/chief-thread';

const LEVELS: { value: ChiefLevel; label: string; short: string }[] = [
  { value: 'observe', label: 'Observe only', short: 'observes' },
  { value: 'advise', label: 'Advise (add guidance)', short: 'advises' },
  { value: 'escalate', label: 'Advise and ask me', short: 'advises, asks you' },
  { value: 'operate', label: 'Operate (retry, rerun, swap agents)', short: 'operates' },
];

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ThreadItem({ item, onAnswer }: { item: ChiefThreadItem; onAnswer(wait: WaitRequest, answer: string): void }) {
  const [text, setText] = useState('');
  if (item.kind === 'user') {
    return (
      <div className="chief-msg from-user">
        <div className="chief-bubble">{item.text}</div>
        <div className="chief-meta">{timeOf(item.atMs)}</div>
      </div>
    );
  }
  if (item.kind === 'escalation') {
    const { wait } = item;
    return (
      <div className="chief-msg from-chief">
        <div className="chief-bubble chief-question">
          <div className="chief-label">The chief needs your decision</div>
          <div>{wait.prompt}</div>
          <div className="chief-answers">
            {wait.options.map((o) => (
              <button key={o.value} type="button" className="btn" onClick={() => onAnswer(wait, o.value)} title={o.description}>
                {o.label}
              </button>
            ))}
          </div>
          {wait.options.length === 0 && (
            <form
              className="chief-answer-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) onAnswer(wait, text.trim());
              }}
            >
              <input type="text" value={text} placeholder="Your answer" onChange={(e) => setText(e.target.value)} />
              <button type="submit" className="btn" disabled={!text.trim()}>
                Answer
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="chief-msg from-chief">
      <div className="chief-bubble">
        {item.trigger !== 'user.message' && (
          <div className="chief-label">
            Stepped in: {TRIGGER_LABEL[item.trigger]}
            {item.nodeName ? ` · ${item.nodeName}` : ''}
          </div>
        )}
        {item.text && <div className="chief-text">{item.text}</div>}
        {item.applied.length > 0 && (
          <ul className="chief-actions">
            {item.applied.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
        {item.rejected.length > 0 && (
          <ul className="chief-actions rejected">
            {item.rejected.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="chief-meta">{timeOf(item.atMs)}</div>
    </div>
  );
}

/**
 * The chief's corner of the screen: who supervises and how far it may go, a message box to
 * ask it about the run or tell it what to do, and the conversation (including what it did on
 * its own and questions it needs you to answer).
 */
export function ChiefDock(props: {
  readonly run: WorkflowRunState | null;
  /** The chief settings in force: the run's, or the workflow's in design view. */
  readonly policy: ChiefPolicy | undefined;
  /** Design view: settings can be changed (they apply to future runs). */
  readonly editable: boolean;
  readonly agents: readonly AgentListing[];
  readonly chiefAnswering: boolean;
  nodeName(nodeId: string): string;
  onPolicyChange(next: ChiefPolicy | null): void;
  onSend(text: string): Promise<void>;
  onAnswer(wait: WaitRequest, answer: string): void;
}) {
  const { run, policy } = props;
  const thread = useMemo(() => buildChiefThread(run, props.nodeName), [run, props.nodeName]);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [seen, setSeen] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // A new run starts a new conversation; its own question to you opens the thread.
  useEffect(() => {
    setSeen(0);
    setOpen(false);
  }, [run?.runId]);
  const hasQuestion = thread.items.some((i) => i.kind === 'escalation');
  useEffect(() => {
    if (hasQuestion) setOpen(true);
  }, [hasQuestion]);
  useEffect(() => {
    if (open) setSeen(thread.chiefEntryCount);
  }, [open, thread.chiefEntryCount]);
  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [open, thread.items.length, thread.waitingForChief]);

  const agentName = policy?.agentRef ? (props.agents.find((a) => a.agentId === policy.agentRef?.split('@')[0])?.name ?? policy.agentRef) : 'Default supervisor';
  const level = LEVELS.find((l) => l.value === policy?.maxLevel);
  const canTalk = !!run && !!policy;
  const unread = Math.max(0, thread.chiefEntryCount - seen);
  const placeholder = !run
    ? policy
      ? 'Start a run to talk to the chief'
      : 'Turn on a chief to supervise runs'
    : !policy
      ? 'This run has no chief'
      : 'Ask the chief about the run, or tell it what to do…';

  const send = async () => {
    const text = draft.trim();
    if (!text || !canTalk || sending) return;
    setSending(true);
    try {
      await props.onSend(text);
      setDraft('');
      setOpen(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chief-dock" data-open={open ? 'true' : 'false'}>
      {open && (
        <section className="chief-thread" aria-label="Conversation with the chief">
          <header className="chief-thread-head">
            <span>Chief</span>
            <button type="button" className="icon-btn visible" aria-label="Hide conversation" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          <div className="chief-thread-body" ref={listRef}>
            {thread.items.length === 0 && (
              <div className="popover-note">
                {canTalk
                  ? 'Nothing yet. The chief steps in when steps fail, loops stall or agents ask questions; you can also ask it anything about the run.'
                  : placeholder}
              </div>
            )}
            {thread.items.map((item) => (
              <ThreadItem key={item.id} item={item} onAnswer={props.onAnswer} />
            ))}
            {(thread.waitingForChief || props.chiefAnswering) && (
              <div className="chief-msg from-chief">
                <div className="chief-bubble chief-typing" aria-label="The chief is answering">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {settingsOpen && (
        <section className="chief-settings" aria-label="Chief settings">
          <div className="menu-label">{props.editable ? 'Chief for runs of this workflow' : 'Chief of this run'}</div>
          {props.editable ? (
            <>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={!!policy}
                  onChange={(e) => props.onPolicyChange(e.target.checked ? ChiefPolicySchema.parse({ maxLevel: 'escalate' }) : null)}
                />
                <span>
                  <span>Supervise runs</span>
                  <span className="field-hint">Keeps runs moving; never changes what counts as done</span>
                </span>
              </label>
              {policy && (
                <>
                  <label className="field">
                    <span>Agent</span>
                    <select
                      aria-label="Chief agent"
                      value={policy.agentRef ?? ''}
                      onChange={(e) =>
                        props.onPolicyChange(
                          e.target.value ? { ...policy, agentRef: e.target.value } : (({ agentRef: _a, ...rest }) => rest)(policy)
                        )
                      }
                    >
                      <option value="">Default supervisor</option>
                      {props.agents.map((a) => (
                        <option key={a.agentId} value={a.agentId}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Allowed to</span>
                    <select
                      aria-label="Chief level"
                      value={policy.maxLevel}
                      onChange={(e) => props.onPolicyChange({ ...policy, maxLevel: e.target.value as ChiefLevel })}
                    >
                      {LEVELS.map((l) => (
                        <option key={l.value} value={l.value}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="popover-note">Changes apply to runs started after you save.</div>
                </>
              )}
            </>
          ) : policy ? (
            <div className="popover-note">
              {agentName} · {level?.label}. {policy.maxInterventionsPerRun} interventions at most
              {run ? `, ${run.chief.interventionCount} used` : ''}. Change it in the design view for future runs.
            </div>
          ) : (
            <div className="popover-note">This run was started without a chief. Turn one on in the design view for future runs.</div>
          )}
        </section>
      )}

      <div className="chief-composer">
        <button
          type="button"
          className="chief-toggle"
          aria-label={open ? 'Hide conversation' : 'Show conversation'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          {unread > 0 && <span className="chief-unread">{unread}</span>}
        </button>
        <textarea
          rows={1}
          value={draft}
          disabled={!canTalk}
          placeholder={placeholder}
          aria-label="Message to the chief"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="chief-chip"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(!settingsOpen)}
          title="Chief settings"
        >
          {policy ? (
            <>
              <span className="chief-chip-name">{agentName}</span>
              <span className="chief-chip-level">{level?.short}</span>
            </>
          ) : (
            <span className="chief-chip-name">No chief</span>
          )}
          <span className="chev">⌄</span>
        </button>
        <button type="button" className="chief-send" aria-label="Send" disabled={!canTalk || !draft.trim() || sending} onClick={() => void send()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 12V2M7 2 3 6M7 2l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
