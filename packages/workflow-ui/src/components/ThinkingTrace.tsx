import type { ThinkingStep } from '@universal-agent/workflow-contract';
import { useEffect, useRef, useState } from 'react';
import { formatThinkingSeconds, type ThinkingTraceModel } from '../model/thinking';
import { VirtualList } from './VirtualList';

function StepMarker({ step }: { step: ThinkingStep }) {
  if (step.status === 'running') {
    return (
      <span className="thinking-marker is-running" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
          <path
            className="thinking-spinner-arc"
            d="M 7 1.75 A 5.25 5.25 0 0 1 12.25 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="7" cy="7" r="2" fill="currentColor" />
        </svg>
      </span>
    );
  }
  if (step.status === 'failed') {
    return (
      <span className="thinking-marker is-failed" aria-hidden="true">
        ×
      </span>
    );
  }
  if (step.kind === 'search') {
    return (
      <span className="thinking-marker is-search" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <circle cx="5.2" cy="5.2" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7.8 7.8 10.4 10.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="thinking-marker is-done" aria-hidden="true">
      <span className="thinking-dot" />
    </span>
  );
}

const MAX_VISIBLE_PILLS = 3;

function StepRow({ step, last }: { step: ThinkingStep; last: boolean }) {
  const pills = step.pills ?? [];
  const visiblePills = pills.slice(0, MAX_VISIBLE_PILLS);
  const extraCount = Math.max(0, pills.length - visiblePills.length);
  const subItems = step.subItems ?? [];

  return (
    <div className="thinking-step" data-status={step.status} data-last={last ? 'true' : 'false'}>
      <StepMarker step={step} />
      <div className="thinking-step-main">
        <div
          className="thinking-step-label"
          data-shimmer={step.status === 'running' ? 'true' : 'false'}
          title={step.label}
        >
          {step.label}
        </div>

        {visiblePills.length > 0 && (
          <div className="thinking-pills">
            {visiblePills.map((pill, idx) => (
              <span key={`${pill.label}-${idx}`} className="thinking-pill" title={pill.path ?? pill.label}>
                {pill.badge && (
                  <span className="thinking-pill-badge" data-badge={pill.badge}>
                    {pill.badge}
                  </span>
                )}
                <span className="thinking-pill-text">{pill.label}</span>
              </span>
            ))}
            {extraCount > 0 && <span className="thinking-pill is-more">+{extraCount} more</span>}
          </div>
        )}

        {subItems.length > 0 && (
          <div className="thinking-subitems">
            {subItems.map((sub, idx) => {
              const isLast = idx === subItems.length - 1;
              return (
                <div key={sub.id} className="thinking-subitem" data-status={sub.status ?? 'done'}>
                  <span className="thinking-subitem-branch" aria-hidden="true">
                    {sub.status === 'failed' ? '×' : isLast ? '└' : '├'}
                  </span>
                  <span className="thinking-subitem-text" title={sub.text}>
                    {sub.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FinalRow({ trace }: { trace: ThinkingTraceModel }) {
  return (
    <div className="thinking-step is-final" data-status={trace.state === 'failed' ? 'failed' : 'done'} data-last="true">
      <span
        className={`thinking-marker ${trace.state === 'failed' ? 'is-final-failed' : 'is-final-done'}`}
        aria-hidden="true"
      >
        {trace.state === 'failed' ? (
          '×'
        ) : (
          <svg width="9" height="9" viewBox="0 0 10 10">
            <path
              d="M2 5.2 4.1 7.3 8.2 2.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <div className="thinking-step-main is-final-row">
        <span className="thinking-final-title">
          {trace.state === 'failed' ? 'Execution failed' : 'Finished thinking'}
        </span>
        {trace.summary && <span className="thinking-final-summary">{trace.summary}</span>}
        {trace.durationMs !== undefined && !trace.summary && (
          <span className="thinking-final-summary">{formatThinkingSeconds(trace.durationMs)}</span>
        )}
      </div>
    </div>
  );
}

export function ThinkingTrace({
  trace,
  defaultOpen = true,
  variant = 'card',
}: {
  readonly trace: ThinkingTraceModel;
  readonly defaultOpen?: boolean;
  readonly variant?: 'card' | 'chat' | 'drawer';
}) {
  const [open, setOpen] = useState(trace.state === 'running' ? true : defaultOpen);
  const prevState = useRef(trace.state);
  const fallbackStartRef = useRef<number>(Date.now());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (trace.state === 'running' && prevState.current !== 'running') {
      fallbackStartRef.current = Date.now();
      setOpen(true);
    }
    prevState.current = trace.state;
  }, [trace.state]);

  useEffect(() => {
    if (trace.state !== 'running') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [trace.state]);

  const rows: (ThinkingStep | 'final')[] = trace.state === 'running' ? [...trace.steps] : [...trace.steps, 'final'];

  const elapsedMs =
    trace.state === 'running'
      ? Math.max(0, nowMs - (trace.startedAtMs ?? fallbackStartRef.current))
      : trace.durationMs;

  return (
    <div
      className="thinking-trace nodrag"
      data-state={trace.state}
      data-variant={variant}
      data-open={open ? 'true' : 'false'}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="thinking-chev" aria-hidden="true">
          ⌄
        </span>
        <span className="thinking-head-label" data-shimmer={trace.state === 'running' ? 'true' : 'false'}>
          {trace.headerLabel}
        </span>
        {trace.state === 'running' && (
          <span className="thinking-timer">{ `${Math.floor((elapsedMs ?? 0) / 1000)}s` }</span>
        )}
        {!open && trace.state !== 'running' && trace.summary && (
          <span className="thinking-collapsed-summary">{trace.summary}</span>
        )}
      </button>

      {open && (
        <VirtualList
          className="thinking-body"
          items={rows}
          itemKey={(row) => (row === 'final' ? 'final' : row.id)}
          estimateSize={24}
          gap={8}
          follow
          virtualize={variant === 'drawer'}
          renderItem={(row, index) =>
            row === 'final' ? <FinalRow trace={trace} /> : <StepRow step={row} last={index === rows.length - 1} />
          }
        />
      )}
    </div>
  );
}
