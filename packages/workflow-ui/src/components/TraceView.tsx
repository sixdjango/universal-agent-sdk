import type { LiveAttemptProgress, WaitRequest } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationReader } from '../model/conversation';
import { NodeConversation } from './NodeConversation';
import {
  buildTraceModel,
  formatCostUsd,
  formatDurationMs,
  formatTokenCount,
  type TraceSpan,
} from '../model/trace';
import { ThinkingTrace } from './ThinkingTrace';
import { NodeData } from './NodeData';
import type { NodeDataReader } from '../model/node-data';
import {
  AgentIcon,
  CheckIcon,
  CloseIcon,
  GateIcon,
  LoopIcon,
  OutputsIcon,
  ParallelIcon,
  ForkIcon,
  RerunIcon,
  ReviewIcon,
  ScriptIcon,
} from './icons';

function SpanKindIcon({ kind, status }: { kind: TraceSpan['kind']; status: TraceSpan['status'] }) {
  if (status === 'failed') {
    return (
      <span className="trace-span-icon" data-color="red" aria-hidden="true">
        ⊗
      </span>
    );
  }
  switch (kind) {
    case 'orchestrator':
    case 'loop':
      return (
        <span className="trace-span-icon" data-color="purple">
          <LoopIcon />
        </span>
      );
    case 'parallel':
      return (
        <span className="trace-span-icon" data-color="purple">
          <ParallelIcon />
        </span>
      );
    case 'review':
      return (
        <span className="trace-span-icon" data-color="emerald">
          <ReviewIcon />
        </span>
      );
    case 'agent':
      return (
        <span className="trace-span-icon" data-color="blue">
          <AgentIcon />
        </span>
      );
    case 'gate':
      return (
        <span className="trace-span-icon" data-color="amber">
          <GateIcon />
        </span>
      );
    case 'artifact':
      return (
        <span className="trace-span-icon" data-color="emerald">
          <OutputsIcon />
        </span>
      );
    case 'script':
    case 'tool':
    default:
      return (
        <span className="trace-span-icon" data-color="slate">
          <ScriptIcon />
        </span>
      );
  }
}

function SpanWaitControl({
  wait,
  onAnswer,
}: {
  wait: WaitRequest;
  onAnswer(wait: WaitRequest, answer: string): Promise<void>;
}) {
  const [choice, setChoice] = useState<string>(wait.options[0]?.value ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = wait.options.length > 0 ? choice : text.trim();

  const submit = async () => {
    if (!answer || busy) return;
    setBusy(true);
    try {
      await onAnswer(wait, answer);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trace-wait-box">
      <div className="trace-detail-section-label">WAITING FOR YOUR DECISION</div>
      <div className="trace-wait-prompt">{wait.prompt}</div>
      {wait.options.length > 0 ? (
        <div className="trace-wait-options">
          {wait.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="option"
              data-selected={choice === opt.value}
              onClick={() => setChoice(opt.value)}
            >
              <span>
                <div className="option-title">{opt.label}</div>
                {opt.description && <div className="option-desc">{opt.description}</div>}
              </span>
              {choice === opt.value && (
                <span className="check">
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your response…"
        />
      )}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!answer || busy}
          onClick={() => void submit()}
        >
          Submit decision
        </button>
      </div>
    </div>
  );
}

export function NodeExecutionDetails({
  span: rootSpan,
  onClose,
  onOpenArtifact,
  onRerun,
  onFork,
  onAnswer,
  runId,
  runActive = false,
  conversationReader,
  dataReader,
}: {
  span: TraceSpan;
  onClose(): void;
  onOpenArtifact(artifactId: string, title: string): void;
  onRerun(nodeId: string, scopeKey?: string): void;
  /** Starts a new run from the step, taking over the ones before it (omit to hide). */
  onFork?(nodeId: string): void;
  onAnswer(wait: WaitRequest, answer: string): Promise<void>;
  runId: string;
  runActive?: boolean;
  conversationReader?: ConversationReader;
  /** Loads what the step saved (its "Data" tab); omit to hide the tab. */
  dataReader?: NodeDataReader;
}) {
  const [selectedItem, setSelectedItem] = useState('');
  const choices: { span: TraceSpan; label: string }[] = [];
  const collect = (spans: readonly TraceSpan[], prefix: string) => {
    for (const child of spans) {
      const label = prefix ? `${prefix} / ${child.title}` : child.title;
      if (child.nodeId && (child.hasConversation || (child.id.startsWith('node:') && !child.children.some(c => c.nodeId && c.id.startsWith('node:'))))) choices.push({ span: child, label });
      collect(child.children, label);
    }
  };
  if (rootSpan.parallelBatch) collect(rootSpan.children, '');
  const span = choices.find(c => c.span.id === selectedItem)?.span ?? rootSpan;
  const [tab, setTab] = useState<'summary' | 'conversation' | 'data'>('summary');
  const tabsId = useId();
  const card = useRef<HTMLDivElement>(null);
  const hasConversation = Boolean(span.hasConversation && span.nodeId && conversationReader);
  const hasData = Boolean(span.nodeId && dataReader);
  const tabs = ['summary', ...(hasConversation ? ['conversation' as const] : []), ...(hasData ? ['data' as const] : [])] as const;
  const tabLabel = { summary: 'Overview', conversation: 'Conversation', data: 'Data' } as const;
  useLayoutEffect(() => {
    const fit = () => {
      if (!card.current) return;
      // Trace details sit below the waterfall header; keep them above the chief dock.
      const available = Math.max(100, window.innerHeight - card.current.getBoundingClientRect().top - 100);
      card.current.style.setProperty('--detail-max-height', `${available}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    return () => {
      window.removeEventListener('resize', fit);
      window.removeEventListener('scroll', fit, true);
    };
  }, [tab]);
  const statusLabel =
    span.status === 'running'
      ? 'Running'
      : span.status === 'waiting'
        ? 'Waiting'
        : span.status === 'failed'
          ? 'Failed'
          : 'Done';

  return (
    <div
      ref={card}
      className="trace-detail-card"
      role="dialog"
      aria-label={`Details for ${span.title}`}
      data-tab={hasConversation ? tab : 'summary'}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="trace-detail-head">
        <SpanKindIcon kind={span.kind} status={span.status} />
        <div className="trace-detail-titles">
          <div className="trace-detail-title">{span.title}</div>
          <div className="trace-detail-sub">{span.subtitle}</div>
        </div>
        <span className="trace-status-badge" data-status={span.status}>
          {span.status === 'running' && <span className="dot" />}
          {statusLabel}
        </span>
        <button type="button" className="trace-close-btn" aria-label="Close details" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      {rootSpan.parallelBatch && <label className="field parallel-execution-picker">
        <span>Item execution</span>
        <select aria-label="Item execution" value={span === rootSpan ? '' : span.id} onChange={event => { setSelectedItem(event.target.value); setTab('summary'); }}>
          <option value="">All items · {rootSpan.status}</option>
          {choices.map(c => <option key={c.span.id} value={c.span.id}>{c.label} · {c.span.status}</option>)}
        </select>
      </label>}

      {tabs.length > 1 && <div className="execution-detail-tabs" role="tablist" aria-label="Execution details">
        {tabs.map((name, index) => <button type="button" key={name} role="tab"
          id={`${tabsId}-${name}`} aria-controls={`${tabsId}-${name}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
          onClick={() => setTab(name)} onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
            setTab(next);
            document.getElementById(`${tabsId}-${next}`)?.focus();
          }}>{tabLabel[name]}</button>)}
      </div>}

      {hasData && tab === 'data' && <div role="tabpanel" id={`${tabsId}-data-panel`} aria-labelledby={`${tabsId}-data`}>
        <NodeData reader={dataReader!} target={{ runId, scopeKey: span.scopeKey, nodeId: span.nodeId! }} live={runActive} />
      </div>}

      {hasConversation && tab === 'conversation' && <div role="tabpanel" id={`${tabsId}-conversation-panel`} aria-labelledby={`${tabsId}-conversation`}>
        <NodeConversation reader={conversationReader!} target={{ runId, scopeKey: span.scopeKey, nodeId: span.nodeId! }} live={runActive} />
      </div>}

      <div role={tabs.length > 1 ? 'tabpanel' : undefined} id={`${tabsId}-summary-panel`} aria-labelledby={tabs.length > 1 ? `${tabsId}-summary` : undefined} hidden={tab !== 'summary'}>
      <div className="trace-detail-metrics">
        <div>
          <div className="trace-metric-label">DURATION</div>
          <div className="trace-metric-val">{formatDurationMs(span.durationMs)}</div>
        </div>
        <div>
          <div className="trace-metric-label">STARTED</div>
          <div className="trace-metric-val">+{formatDurationMs(span.startOffsetMs)}</div>
        </div>
        <div>
          <div className="trace-metric-label">COST</div>
          <div className="trace-metric-val">{formatCostUsd(span.costUsd)}</div>
        </div>
        {(span.inputTokens !== undefined ||
          span.outputTokens !== undefined ||
          span.children.length > 0 ||
          span.verdict) && (
          <>
            <div>
              <div className="trace-metric-label">TOKENS IN</div>
              <div className="trace-metric-val">{formatTokenCount(span.inputTokens ?? 0)}</div>
            </div>
            <div>
              <div className="trace-metric-label">TOKENS OUT</div>
              <div className="trace-metric-val">{formatTokenCount(span.outputTokens ?? 0)}</div>
            </div>
            <div>
              <div className="trace-metric-label">{span.verdict ? 'VERDICT' : 'SPANS'}</div>
              <div className="trace-metric-val">{span.verdict ?? span.children.length}</div>
            </div>
          </>
        )}
      </div>

      {(span.error || (span.findings && span.findings.length > 0)) && (
        <div className="trace-detail-error">
          <span className="trace-detail-error-icon">⊗</span>
          <div>
            {span.error && <div>{span.error}</div>}
            {span.findings?.map((f, i) => (
              <div key={i}>
                <strong>{f.severity}:</strong> {f.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {span.pendingWait && <SpanWaitControl wait={span.pendingWait} onAnswer={onAnswer} />}

      {span.thinking && (
        <div className="trace-detail-section">
          <div className="trace-detail-section-label">EXECUTION STEPS</div>
          <ThinkingTrace trace={span.thinking} defaultOpen={true} variant="drawer" />
        </div>
      )}

      {span.inputPreview && (
        <div className="trace-detail-section">
          <div className="trace-detail-section-label">INPUT</div>
          <div className="trace-detail-code">{span.inputPreview}</div>
        </div>
      )}

      {span.outputPreview && (
        <div className="trace-detail-section">
          <div className="trace-detail-section-label">OUTPUT</div>
          <div className="trace-detail-code">{span.outputPreview}</div>
        </div>
      )}

      {span.changes && (
        <div className="trace-detail-section">
          <div className="trace-detail-section-label">
            CHANGES · {span.changes.files.length === 0 ? 'none' : `${span.changes.files.length} file${span.changes.files.length === 1 ? '' : 's'}`}
            {span.changes.isolated ? ' · made in its own copy, merged back' : ''}
          </div>
          {span.changes.outOfScope && span.changes.outOfScope.length > 0 && (
            <div className="trace-detail-warning">Outside its write scopes: {span.changes.outOfScope.join(', ')}</div>
          )}
          {span.changes.files.length > 0 && (
            <div className="trace-detail-code">
              {span.changes.files
                .slice(0, 20)
                .map((f) => `${f.status}  ${f.path}`)
                .join('\n')}
              {span.changes.files.length > 20 ? `\n… ${span.changes.files.length - 20} more` : ''}
            </div>
          )}
          {span.changes.artifactId && (
            <div className="trace-detail-actions">
              <button type="button" className="btn" onClick={() => onOpenArtifact(span.changes!.artifactId!, `${span.title} · diff`)}>
                View diff
              </button>
            </div>
          )}
        </div>
      )}

      {(span.artifactId || ((span.rerunnable || (span.forkable && onFork)) && span.nodeId)) && (
        <div className="trace-detail-actions">
          {span.artifactId && (
            <button
              type="button"
              className="btn"
              onClick={() => onOpenArtifact(span.artifactId!, span.artifactTitle ?? span.title)}
            >
              View full output
            </button>
          )}
          {span.rerunnable && span.nodeId && (
            <button type="button" className="btn" onClick={() => onRerun(span.nodeId!, span.scopeKey)}>
              <RerunIcon /> Rerun from here
            </button>
          )}
          {span.forkable && span.nodeId && onFork && (
            <button type="button" className="btn" title="A new run that takes over the steps before this one" onClick={() => onFork(span.nodeId!)}>
              <ForkIcon /> Fork from here
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

export function TraceView(props: {
  run: WorkflowRunState;
  runActive: boolean;
  liveProgress?: readonly LiveAttemptProgress[];
  agentNames: Readonly<Record<string, string>>;
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
  onOpenArtifact(artifactId: string, title: string): void;
  onRerun(nodeId: string, scopeKey?: string): void;
  /** Starts a new run from a step, taking over the ones before it (omit to hide). */
  onFork?(nodeId: string): void;
  onAnswer(wait: WaitRequest, answer: string): Promise<void>;
  conversationReader?: ConversationReader;
  dataReader?: NodeDataReader;
}) {
  const { run, runActive, liveProgress, agentNames, onOpenArtifact, onRerun, onAnswer } = props;
  const isLive = run.status === 'RUNNING' || run.status === 'WAITING' || runActive;

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [localLightTheme, setLocalLightTheme] = useState<boolean>(false);
  const effectiveTheme = props.theme ?? (localLightTheme ? 'light' : 'dark');
  const toggleTheme = props.onToggleTheme ?? (() => setLocalLightTheme((v) => !v));

  useEffect(() => {
    if (!isLive) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [isLive]);

  const model = useMemo(
    () =>
      buildTraceModel({
        run,
        runActive,
        ...(liveProgress ? { liveProgress } : {}),
        agentNames,
        nowMs,
      }),
    [run, runActive, liveProgress, agentNames, nowMs]
  );

  const flatRows = useMemo(() => {
    const rows: { span: TraceSpan; depth: number }[] = [];
    const visit = (list: readonly TraceSpan[], depth: number) => {
      for (const span of list) {
        rows.push({ span, depth });
        if (span.children.length > 0 && !collapsed[span.id]) {
          visit(span.children, depth + 1);
        }
      }
    };
    visit(model.spans, 0);
    return rows;
  }, [model.spans, collapsed]);

  const selectedSpan = useMemo(() => {
    if (!selectedSpanId) return null;
    const find = (list: readonly TraceSpan[]): TraceSpan | null => {
      for (const s of list) {
        if (s.id === selectedSpanId || s.id.replace(/^running:/, 'node:') === selectedSpanId.replace(/^running:/, 'node:')) return s;
        const child = find(s.children);
        if (child) return child;
      }
      return null;
    };
    return find(model.spans);
  }, [model.spans, selectedSpanId]);

  const toggleCollapse = (spanId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setCollapsed((prev) => ({ ...prev, [spanId]: !prev[spanId] }));
  };

  return (
    <div
      className="trace-shell"
      data-theme={effectiveTheme}
      onClick={() => setSelectedSpanId(null)}
    >
      <div className="trace-card" onClick={(e) => e.stopPropagation()}>
        {/* Top bar: Trace title + Live/Done badge */}
        <div className="trace-header">
          <div className="trace-header-left">
            <span className="trace-brand-icon" aria-hidden="true">
              ✦
            </span>
            <span className="trace-header-label">Trace</span>
            <span className="trace-header-headline" title={model.headline}>
              {model.headline}
            </span>
          </div>
          <div className="trace-header-right">
            <button
              type="button"
              className="trace-theme-btn"
              onClick={toggleTheme}
              title="Switch theme"
            >
              {effectiveTheme === 'light' ? 'Dark' : 'Light'}
            </button>
            <span className="trace-status-badge" data-status={model.status}>
              {model.status === 'live' && <span className="dot" />}
              {model.status === 'live'
                ? 'Live'
                : model.status === 'waiting'
                  ? 'Waiting'
                  : model.status === 'failed'
                    ? 'Failed'
                    : 'Done'}
            </span>
          </div>
        </div>

        {/* 6-column KPI summary strip */}
        <div className="trace-kpis">
          <div className="trace-kpi">
            <div className="trace-kpi-label">DURATION</div>
            <div className="trace-kpi-value">{formatDurationMs(model.durationMs)}</div>
          </div>
          <div className="trace-kpi">
            <div className="trace-kpi-label">COST</div>
            <div className="trace-kpi-value">{formatCostUsd(model.totalCostUsd)}</div>
          </div>
          <div className="trace-kpi">
            <div className="trace-kpi-label">TOKENS</div>
            <div className="trace-kpi-value">{formatTokenCount(model.totalTokens)}</div>
          </div>
          <div className="trace-kpi">
            <div className="trace-kpi-label">LLM CALLS</div>
            <div className="trace-kpi-value">{model.llmCalls}</div>
          </div>
          <div className="trace-kpi">
            <div className="trace-kpi-label">TOOL CALLS</div>
            <div className="trace-kpi-value">{model.toolCalls}</div>
          </div>
          <div className="trace-kpi">
            <div className="trace-kpi-label">ERRORS</div>
            <div className="trace-kpi-value" data-danger={model.errorCount > 0 ? 'true' : 'false'}>
              {model.errorCount}
            </div>
          </div>
        </div>

        {/* Waterfall body */}
        <div className="trace-body">
          {/* Axis header */}
          <div className="trace-axis-row">
            <div className="trace-col-span trace-axis-label">SPAN</div>
            <div className="trace-col-timeline trace-axis-ticks">
              {model.ticks.map((tick) => (
                <span
                  key={tick.timeMs}
                  className="trace-tick-label"
                  style={{ left: `${tick.offsetPct}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>

          {/* Span rows + vertical grid + playhead */}
          <div className="trace-rows-container">
            <div className="trace-grid-overlay" aria-hidden="true">
              <div className="trace-col-span" />
              <div className="trace-col-timeline">
                {model.ticks.map((tick) => (
                  <div
                    key={tick.timeMs}
                    className="trace-grid-line"
                    style={{ left: `${tick.offsetPct}%` }}
                  />
                ))}
                {model.status === 'live' && (
                  <div
                    className="trace-playhead"
                    style={{ left: `${model.playheadPct}%` }}
                  >
                    <span className="trace-playhead-dot" />
                  </div>
                )}
              </div>
            </div>

            {flatRows.length === 0 && (
              <div className="trace-empty-row">Waiting for first step to start…</div>
            )}

            {flatRows.map(({ span, depth }) => {
              const hasChildren = span.children.length > 0;
              const isCollapsed = !!collapsed[span.id];
              const isSelected = selectedSpan?.id === span.id;
              const barMeta = `${formatDurationMs(span.durationMs)}${
                span.costUsd && span.costUsd > 0 ? ` · ${formatCostUsd(span.costUsd)}` : ''
              }`;

              return (
                <div
                  key={span.id}
                  className="trace-row"
                  data-selected={isSelected ? 'true' : 'false'}
                  data-status={span.status}
                  onClick={() => setSelectedSpanId(isSelected ? null : span.id)}
                >
                  <div
                    className="trace-col-span trace-span-cell"
                    style={{ paddingLeft: `${16 + depth * 22}px` }}
                  >
                    {hasChildren ? (
                      <button
                        type="button"
                        className="trace-chevron"
                        aria-label={isCollapsed ? 'Expand span' : 'Collapse span'}
                        onClick={(e) => toggleCollapse(span.id, e)}
                      >
                        {isCollapsed ? '›' : '⌄'}
                      </button>
                    ) : (
                      <span className="trace-chevron-spacer" />
                    )}
                    <SpanKindIcon kind={span.kind} status={span.status} />
                    <span className="trace-span-title" title={span.title}>
                      {span.title}
                    </span>
                    <span className="trace-span-sub" title={span.subtitle}>
                      {span.subtitle}
                    </span>
                    {hasChildren && isCollapsed && (
                      <span className="trace-collapsed-count">+{span.children.length}</span>
                    )}
                  </div>

                  <div className="trace-col-timeline trace-bar-track">
                    {hasChildren && isCollapsed && span.segments.length > 1 ? (
                      <div
                        className="trace-bar-segmented"
                        style={{
                          left: `${span.startPct}%`,
                          width: `${span.widthPct}%`,
                        }}
                      >
                        {span.segments.map((seg) => {
                          const relStart =
                            span.widthPct > 0
                              ? Math.max(0, ((seg.startPct - span.startPct) / span.widthPct) * 100)
                              : 0;
                          const relWidth =
                            span.widthPct > 0
                              ? Math.max(6, Math.min(100 - relStart, (seg.widthPct / span.widthPct) * 100))
                              : 100;
                          return (
                            <span
                              key={seg.id}
                              className="trace-bar-seg"
                              data-color={seg.color}
                              style={{ left: `${relStart}%`, width: `${relWidth}%` }}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div
                        className="trace-bar"
                        data-color={span.color}
                        data-status={span.status}
                        style={{
                          left: `${span.startPct}%`,
                          width: `${span.widthPct}%`,
                        }}
                      />
                    )}

                    <div
                      className="trace-bar-label"
                      data-status={span.status}
                      style={{
                        left: `calc(${Math.min(84, span.startPct + span.widthPct)}% + 8px)`,
                      }}
                    >
                      {span.status === 'failed' && <span className="trace-err-dot">⊗</span>}
                      <span>{barMeta}</span>
                      {span.isSlowest && <span className="trace-slowest-badge">SLOWEST</span>}
                      {span.pendingWait && (
                        <span className="trace-action-badge">Needs decision</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {selectedSpan && (
              <NodeExecutionDetails
                key={`${run.runId}:${selectedSpan.scopeKey}:${selectedSpan.nodeId ?? selectedSpan.id}`}
                span={selectedSpan}
                runId={run.runId}
                runActive={runActive}
                conversationReader={props.conversationReader}
                {...(props.dataReader ? { dataReader: props.dataReader } : {})}
                onClose={() => setSelectedSpanId(null)}
                onOpenArtifact={onOpenArtifact}
                onRerun={onRerun}
                {...(props.onFork ? { onFork: props.onFork } : {})}
                onAnswer={onAnswer}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
