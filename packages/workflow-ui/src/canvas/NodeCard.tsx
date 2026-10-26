import type { WaitRequest } from '@universal-agent/workflow-contract';
import { Handle, type NodeProps, Position, useUpdateNodeInternals } from '@xyflow/react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  AgentIcon,
  CheckIcon,
  GateIcon,
  InputsIcon,
  LoopIcon,
  OutputsIcon,
  ParallelIcon,
  ForkIcon,
  RerunIcon,
  ReviewIcon,
  ScriptIcon,
  SubflowIcon,
} from '../components/icons';
import { RuntimeFields } from '../components/RuntimeFields';
import type { CardData, CardRow, ViewStatus } from '../model/canvas';
import type { LoopRound, LoopSummary } from '../model/loop';
import type { RuntimeChoice } from '../model/runtime';
import { useCanvasActions } from './actions';

const STATUS_TEXT: Record<ViewStatus, string> = {
  idle: '',
  pending: 'Pending',
  running: 'Running',
  waiting: 'Waiting',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  stale: 'Stale',
  unreached: 'Not reached',
};

type CardVariant = CardData['kind'] | 'review';

function getCardVariant(data: CardData): CardVariant {
  if (data.kind === 'agent' && data.subtitle === 'Independent review') return 'review';
  return data.kind;
}

const VARIANT_BADGE: Record<CardVariant, string> = {
  inputs: 'Input',
  outputs: 'Output',
  agent: 'Agent',
  review: 'Review',
  script: 'Script',
  gate: 'Gate',
  loop: 'Loop',
  parallel: 'Parallel',
  subflow: 'Sub-flow',
};

function CardIcon({ data }: { data: CardData }) {
  switch (data.kind) {
    case 'agent':
      return data.subtitle === 'Independent review' ? <ReviewIcon /> : <AgentIcon />;
    case 'script':
      return <ScriptIcon />;
    case 'gate':
      return <GateIcon />;
    case 'loop':
      return <LoopIcon />;
    case 'parallel':
      return <ParallelIcon />;
    case 'subflow':
      return <SubflowIcon />;
    case 'inputs':
      return <InputsIcon />;
    case 'outputs':
      return <OutputsIcon />;
  }
}

/** Closes on Escape and runs `onSubmit` for the given shortcut (⌘/Ctrl + key). */
function useShortcuts(active: boolean, key: string, onSubmit: () => void, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === key.toLowerCase()) {
        event.preventDefault();
        onSubmit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, key, onSubmit, onClose]);
}

function Popover({ children }: { children: ReactNode }) {
  return (
    <div
      className="popover nodrag nowheel nopan"
      style={{ top: 'calc(100% + 8px)', left: 0, width: '100%' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function AgentPicker({ data, onClose }: { data: CardData; onClose: () => void }) {
  const actions = useCanvasActions();
  const current = data.agentRef?.split('@')[0];
  const [selected, setSelected] = useState<string | undefined>(current);
  const [runtime, setRuntime] = useState<RuntimeChoice>(data.runtimeChoice ?? {});
  const [saving, setSaving] = useState(false);
  const agentRuntime = actions.agents.find((a) => a.agentId === selected)?.profile?.runtime;
  const changed =
    selected !== current || JSON.stringify(runtime) !== JSON.stringify(data.runtimeChoice ?? {});
  const save = async () => {
    if (!selected || !changed || saving) return;
    setSaving(true);
    try {
      await actions.assignAgent(data.nodeId, selected, runtime);
      onClose();
    } finally {
      setSaving(false);
    }
  };
  useShortcuts(true, 'Enter', () => void save(), onClose);

  return (
    <Popover>
      <div className="popover-label">Who performs "{data.title}"?</div>
      {actions.agents.length === 0 && <div className="popover-note">No agents registered yet.</div>}
      {actions.agents.map((agent) => (
        <button
          key={agent.agentId}
          type="button"
          className="option"
          data-selected={selected === agent.agentId}
          onClick={() => setSelected(agent.agentId)}
        >
          <span>
            <div className="option-title">{agent.name}</div>
            <div className="option-desc">
              {agent.agentId === current ? 'Current · ' : ''}
              {agent.profile?.runtime.agentType ?? agent.profile?.runtime.adapter ?? ''}
              {agent.profile?.charter ? ` · ${agent.profile.charter}` : ''}
            </div>
          </span>
          {selected === agent.agentId && (
            <span className="check">
              <CheckIcon />
            </span>
          )}
        </button>
      ))}
      <div className="popover-label">Client · model · effort for this step</div>
      <RuntimeFields
        compact
        value={runtime}
        {...(agentRuntime ? { agentRuntime } : {})}
        runtimes={actions.runtimes}
        onChange={setRuntime}
        onRefresh={actions.refreshRuntime}
      />
      <div className="popover-note">Part of your draft: save the workflow to apply it. Runs already started keep their agent.</div>
      <div className="popover-footer">
        <button type="button" className="btn btn-primary" disabled={!selected || !changed || saving} onClick={() => void save()}>
          Use agent <span className="kbd">⌘↵</span>
        </button>
      </div>
    </Popover>
  );
}

function AnswerPanel({ wait, onClose }: { wait: WaitRequest; onClose: () => void }) {
  const actions = useCanvasActions();
  const [choice, setChoice] = useState<string>(wait.options[0]?.value ?? '');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const answer = wait.options.length > 0 ? choice : text.trim();
  const submit = async () => {
    if (!answer || sending) return;
    setSending(true);
    try {
      await actions.answer(wait, answer);
      onClose();
    } finally {
      setSending(false);
    }
  };
  useShortcuts(true, 'Enter', () => void submit(), onClose);

  return (
    <Popover>
      <div className="popover-label">{wait.prompt}</div>
      {wait.options.length > 0 ? (
        wait.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="option"
            data-selected={choice === option.value}
            onClick={() => setChoice(option.value)}
          >
            <span>
              <div className="option-title">{option.label}</div>
              {option.description && <div className="option-desc">{option.description}</div>}
            </span>
            {choice === option.value && (
              <span className="check">
                <CheckIcon />
              </span>
            )}
          </button>
        ))
      ) : (
        <label className="field">
          <textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" />
        </label>
      )}
      <div className="popover-footer">
        <button type="button" className="btn btn-primary" disabled={!answer || sending} onClick={() => void submit()}>
          Submit <span className="kbd">⌘↵</span>
        </button>
      </div>
    </Popover>
  );
}

function Row({ row, onClick, connectable, reversed }: { row: CardRow; onClick?: () => void; connectable: boolean; reversed: boolean }) {
  return (
    <div
      className="row"
      data-kind={row.kind}
      data-tone={row.tone}
      data-interactive={onClick ? 'true' : 'false'}
      onClick={
        onClick
          ? (event) => {
              // Keep row actions from also opening the node inspector.
              event.stopPropagation();
              onClick();
            }
          : undefined
      }
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      {row.handle && (
        <Handle
          type={row.handle.type}
          id={row.handle.id}
          position={(row.handle.type === 'target') !== reversed ? Position.Left : Position.Right}
          className="port"
          role="button"
          aria-label={`${row.handle.type === 'target' ? 'Input' : 'Output'} parameter: ${row.label}`}
          title={`${row.handle.type === 'target' ? 'Input parameter — receives a value' : 'Output parameter — passes a value'}. Connect only to a parameter point.`}
          isConnectable={connectable}
        />
      )}
      <span className="row-label">
        {row.handle && row.kind !== 'add' && <span className="port-direction" aria-hidden="true">{row.handle.type === 'target' ? 'IN' : 'OUT'}</span>}
        {row.status && <span className="row-status" data-status={row.status} style={{ display: 'inline-block' }} />} {row.label}
      </span>
      {row.value !== undefined && (
        <span className="row-value">
          {row.value}
          {(row.kind === 'agent' || (row.kind === 'decision' && row.tone === 'warn')) && <span className="caret">⌄</span>}
          {row.kind === 'open' && <span className="caret open-caret">›</span>}
        </span>
      )}
    </div>
  );
}

const ROUND_TEXT: Record<LoopRound['state'], string> = {
  running: 'running',
  passed: 'passed',
  again: 'went round again',
  failed: 'stopped the loop',
  done: 'finished',
};

/** A loop's rule at a glance: what repeats it, how it ends, its rounds (so far) and its limit. */
function LoopRule({ loop }: { loop: LoopSummary }) {
  const limit = loop.maxRounds + loop.extraRounds;
  const slots = Math.max(limit, loop.rounds.length);
  return (
    <div className="loop-rule">
      <div className="loop-line">
        <span className="loop-key">repeats while</span>
        <span className="loop-value">{loop.repeatWhen}</span>
      </div>
      {loop.endsWhen && (
        <div className="loop-line">
          <span className="loop-key">ends when</span>
          <span className="loop-value">{loop.endsWhen}</span>
        </div>
      )}
      <div className="loop-line">
        <span className="loop-key">rounds</span>
        <span className="loop-pips" aria-label={`${loop.rounds.length} of ${limit} rounds`}>
          {Array.from({ length: slots }, (_, i) => {
            const round = loop.rounds[i];
            return (
              <span
                key={i}
                className="loop-pip"
                data-state={round?.state ?? 'pending'}
                data-extra={i >= loop.maxRounds ? 'true' : 'false'}
                title={
                  round
                    ? `Round ${round.number}: ${round.verdict ?? ''} ${ROUND_TEXT[round.state]}`.replace(/\s+/g, ' ')
                    : i >= loop.maxRounds
                      ? `Round ${i + 1}: granted by the chief`
                      : `Round ${i + 1}`
                }
              >
                {round?.verdict === 'NEEDS_FIX' ? '↻' : round?.state === 'passed' ? '✓' : round?.state === 'failed' ? '×' : ''}
              </span>
            );
          })}
          <span className="loop-limit">
            {loop.rounds.length > 0 ? `${loop.rounds.length} / ${limit}` : `up to ${limit}`}
            {loop.extraRounds > 0 ? ` (+${loop.extraRounds} by chief)` : ''}
          </span>
        </span>
      </div>
      <div className="loop-line">
        <span className="loop-key">out of rounds</span>
        <span className="loop-value">{loop.whenOutOfRounds}</span>
      </div>
    </div>
  );
}

/** A workflow node: icon, title, status, interactive rows with port handles, and activity. */
export function NodeCard({ id, data: raw }: NodeProps) {
  const data = raw as CardData;
  const actions = useCanvasActions();
  // On a row running right to left, edges come in on the right and leave on the left.
  const reversed = !!data.reversed;
  const inSide = reversed ? Position.Right : Position.Left;
  const outSide = reversed ? Position.Left : Position.Right;
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => updateNodeInternals(id), [id, reversed, updateNodeInternals]);
  const popoverId = actions.openPopover?.startsWith(`${data.nodeId}:`) ? actions.openPopover : null;
  const close = () => actions.setOpenPopover(null);
  const toggle = (kind: string) =>
    actions.setOpenPopover(popoverId === `${data.nodeId}:${kind}` ? null : `${data.nodeId}:${kind}`);

  const rows: CardRow[] = [...data.rows];
  if (data.kind === 'agent' && data.pendingWait) {
    rows.splice(1, 0, { id: 'question', label: 'question', value: 'Answer', kind: 'decision', tone: 'warn' });
  }

  const rowAction = (row: CardRow): (() => void) | undefined => {
    // Design view: a sub-flow step opens the workflow it runs.
    if (row.id === 'workflow') return data.subflowOf && actions.openWorkflow ? () => actions.openWorkflow!(data.subflowOf!) : undefined;
    if (row.kind === 'add') {
      if (data.kind === 'inputs') return () => actions.addPort(data.nodeId, 'out');
      if (data.kind === 'outputs') return () => actions.addPort(data.nodeId, 'in');
      return () => actions.addPort(data.nodeId, row.handle?.type === 'target' ? 'in' : 'out');
    }
    if (row.kind === 'open') return () => actions.openScope(data.scopeNodeId ?? data.nodeId, data.itemIndex);
    if (row.kind === 'agent' && data.kind === 'agent' && data.editable) return () => toggle('agent');
    if (row.kind === 'decision' && data.pendingWait) return () => toggle('answer');
    if (row.artifactId) return () => actions.openArtifact(row.artifactId!, `${data.title} · ${row.label}`);
    return undefined;
  };

  const variant = getCardVariant(data);
  const badgeText =
    data.kind === 'parallel' && data.itemIndex !== undefined
      ? `Parallel #${data.itemIndex + 1}`
      : VARIANT_BADGE[variant];
  const showSubtitleText =
    Boolean(data.subtitle) &&
    data.subtitle.toLowerCase() !== badgeText.toLowerCase() &&
    !(variant === 'review' && data.subtitle === 'Independent review');

  return (
    <div
      className="card-wrap"
      data-status={data.status}
      data-kind={data.kind}
      data-variant={variant}
      style={{ ['--order' as string]: data.order }}
    >
      <div
        className="card"
        data-status={data.status}
        data-kind={data.kind}
        data-variant={variant}
        data-fanned-item={data.itemIndex !== undefined ? 'true' : 'false'}
        data-editable={data.editable ? 'true' : 'false'}
        data-invalid={data.issue ? 'true' : 'false'}
        data-selected={data.selected ? 'true' : 'false'}
        title={data.issue}
      >
        {data.kind !== 'inputs' && data.kind !== 'outputs' && <>
          <Handle type="target" id="ctrl-in" position={inSide} className="ctrl" role="button"
            aria-label="Execution input" title="Execution input — wait for upstream steps. No parameters are passed here." isConnectable={data.editable} />
          <Handle type="source" id="ctrl-out" position={outSide} className="ctrl" role="button"
            aria-label="Execution output" title="Execution output — continue after success or a matching branch. Connect only to execution input." isConnectable={data.editable} />
        </>}
        {/* Flow lines reach the inputs and outputs cards too; they are not connected by hand. */}
        {data.kind === 'inputs' && <Handle type="source" id="ctrl-out" position={outSide} className="ctrl" isConnectable={false} />}
        {data.kind === 'outputs' && <Handle type="target" id="ctrl-in" position={inSide} className="ctrl" isConnectable={false} />}
        {(data.loopRole === 'decider' || data.loopRole === 'self') && (
          <Handle type="source" id="loop-out" position={Position.Bottom} className="loop-handle" isConnectable={false} />
        )}
        {(data.loopRole === 'start' || data.loopRole === 'self') && (
          <Handle type="target" id="loop-in" position={Position.Bottom} className="loop-handle" isConnectable={false} />
        )}
        <div className="card-head">
          <div className="card-icon" data-variant={variant}>
            <CardIcon data={data} />
          </div>
          <div className="card-headtext">
            <div className="card-title" title={data.title}>
              {data.title}
            </div>
            <div className="card-sub">
              <span className="card-kind-badge" data-variant={variant}>
                {badgeText}
              </span>
              {showSubtitleText && <span className="card-sub-text">{data.subtitle}</span>}
              {/* Loop roles: a small mark, the explanation on hover. */}
              {data.loopRole === 'decider' && (
                <span className="loop-mark" title={`Decides the loop: ${data.loopRepeat ?? ''} → another round`}>
                  ↻ decides
                </span>
              )}
              {data.loopRole === 'start' && (
                <span className="loop-mark" title="Every round of the loop starts here">
                  ↻ start
                </span>
              )}
              {data.loopRole === 'self' && (
                <span className="loop-mark" title={`Runs again while ${data.loopRepeat ?? ''}`}>
                  ↻ repeats
                </span>
              )}
            </div>
          </div>
          {data.kind === 'loop' && data.editable && actions.expandLoop && (
            <button
              type="button"
              className="icon-btn nodrag loop-expand"
              title="Expand onto the canvas: its steps and a way back from the deciding step"
              aria-label="Expand loop onto the canvas"
              onClick={(event) => {
                event.stopPropagation();
                actions.expandLoop!(data.nodeId);
              }}
            >
              ↻⤢
            </button>
          )}
          {data.rerunnable && (
            <button
              type="button"
              className="icon-btn nodrag"
              title="Rerun from here"
              onClick={() => void actions.rerun(data.nodeId)}
            >
              <RerunIcon />
            </button>
          )}
          {data.forkable && actions.fork && (
            <button
              type="button"
              className="icon-btn nodrag"
              title="Fork from here: a new run that takes over the steps before this one"
              aria-label="Fork a new run from here"
              onClick={() => void actions.fork!(data.nodeId)}
            >
              <ForkIcon />
            </button>
          )}
          {data.issue && (
            <span className="status-chip" data-status="failed" title={data.issue}>
              <span className="dot" />
              Issue
            </span>
          )}
          {data.status !== 'idle' && data.kind !== 'inputs' && data.kind !== 'outputs' && (
            <span className="status-chip" data-status={data.status}>
              <span className="dot" />
              {data.verdict ?? STATUS_TEXT[data.status]}
            </span>
          )}
        </div>
        {data.loop && <LoopRule loop={data.loop} />}
        {rows.length > 0 && (
          <div className="rows">
            {rows.map((row) => (
              <Row key={row.id} row={row} onClick={rowAction(row)} connectable={data.editable} reversed={reversed} />
            ))}
          </div>
        )}
      </div>

      {popoverId === `${data.nodeId}:agent` && <AgentPicker data={data} onClose={close} />}
      {popoverId === `${data.nodeId}:answer` && data.pendingWait && (
        <AnswerPanel wait={data.pendingWait} onClose={close} />
      )}

      {!popoverId && data.activity.length > 0 && (
        <div className="activity">
          {data.activityTitle && (
            <div className="activity-title" title={data.activityTitle}>
              {data.activityTitle}
            </div>
          )}
          {data.activity.map((item) => (
            <span key={item.id} className="chip" data-tone={item.tone}>
              <span className="chip-tag">{item.tag}</span>
              {item.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
