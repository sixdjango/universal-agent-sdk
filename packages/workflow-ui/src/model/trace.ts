import type {
  AssessmentFinding,
  AssessmentVerdict,
  LiveAttemptProgress,
  WaitRequest,
  WorkflowDefinition,
  WorkflowNode,
} from '@universal-agent/workflow-contract';
import { subflowWorkflowId } from '@universal-agent/workflow-contract';
import {
  computeScopeReadyNodeIds,
  type GraphScopeState,
  type NodeAttemptRecord,
  type WorkflowRunState,
} from '@universal-agent/workflow-runtime';
import { compilePlan, containerInstanceKeys } from './canvas';
import { buildNodeThinkingTrace, type ThinkingTraceModel } from './thinking';

export type TraceSpanStatus = 'running' | 'waiting' | 'done' | 'failed';

export type TraceSpanColor = 'purple' | 'blue' | 'amber' | 'emerald' | 'slate' | 'red';

export interface TraceSegment {
  readonly id: string;
  readonly startPct: number;
  readonly widthPct: number;
  readonly color: TraceSpanColor;
}

export interface TraceSpan {
  readonly id: string;
  readonly nodeId?: string;
  readonly scopeKey: string;
  readonly kind: 'orchestrator' | 'agent' | 'script' | 'gate' | 'loop' | 'parallel' | 'tool' | 'artifact' | 'review';
  readonly title: string;
  readonly subtitle: string;
  readonly status: TraceSpanStatus;
  readonly color: TraceSpanColor;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly startOffsetMs: number;
  readonly startPct: number;
  readonly widthPct: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly verdict?: AssessmentVerdict;
  readonly findings?: readonly AssessmentFinding[];
  readonly error?: string;
  readonly inputPreview?: string;
  readonly outputPreview?: string;
  readonly artifactId?: string;
  readonly artifactTitle?: string;
  /** Files the latest attempt changed in its workspace, with the diff artifact. */
  readonly changes?: {
    readonly artifactId?: string;
    readonly files: readonly { path: string; status: string }[];
    readonly outOfScope?: readonly string[];
    readonly isolated?: boolean;
  };
  readonly pendingWait?: WaitRequest;
  readonly rerunnable?: boolean;
  readonly isSlowest?: boolean;
  readonly thinking?: ThinkingTraceModel;
  /** Actual Agent node span; artifact/assessment child spans do not own executions. */
  readonly hasConversation?: boolean;
  /** One authored node with independently inspectable item executions. */
  readonly parallelBatch?: boolean;
  readonly children: readonly TraceSpan[];
  readonly segments: readonly TraceSegment[];
}

export interface TraceTick {
  readonly label: string;
  readonly timeMs: number;
  readonly offsetPct: number;
}

export interface TraceModel {
  readonly runId: string;
  readonly workflowName: string;
  readonly headline: string;
  readonly status: 'live' | 'done' | 'failed' | 'waiting';
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly errorCount: number;
  readonly ticks: readonly TraceTick[];
  readonly playheadPct: number;
  readonly spans: readonly TraceSpan[];
}

export function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) {
    return `${(clamped / 1000).toFixed(1)}s`;
  }
  const totalSeconds = clamped / 1000;
  if (totalSeconds < 60) {
    return totalSeconds < 10 ? `${totalSeconds.toFixed(1)}s` : `${Math.round(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function formatAxisTickMs(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatCostUsd(cost: number | undefined): string {
  if (cost === undefined || cost <= 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens <= 0) return '0';
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

function summarizeValue(value: unknown, maxLen = 180): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === 'string' ? value.trim() : JSON.stringify(value, null, 2);
  if (!raw) return undefined;
  return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
}

function summarizeRecord(record: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!record) return undefined;
  const entries = Object.entries(record).filter(([k, v]) => !k.startsWith('__') && v !== undefined);
  if (entries.length === 0) return undefined;
  if (entries.length === 1) {
    return summarizeValue(entries[0]![1]);
  }
  return summarizeValue(
    Object.fromEntries(entries.map(([k, v]) => [k, typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v]))
  );
}

function computeNiceAxis(durationMs: number): { axisMaxMs: number; ticks: TraceTick[] } {
  const minDurationMs = Math.max(durationMs, 2000);
  const targetStepCandidates = [
    500, 1000, 2000, 5000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000,
  ];
  const stepMs =
    targetStepCandidates.find((step) => minDurationMs / step <= 5) ??
    Math.ceil(minDurationMs / 4 / 60_000) * 60_000;
  const count = Math.max(4, Math.ceil(minDurationMs / stepMs));
  const axisMaxMs = count * stepMs;
  const ticks: TraceTick[] = [];
  for (let i = 0; i <= count; i++) {
    const timeMs = i * stepMs;
    ticks.push({
      label: formatAxisTickMs(timeMs),
      timeMs,
      offsetPct: (timeMs / axisMaxMs) * 100,
    });
  }
  return { axisMaxMs, ticks };
}

function spanColorForKind(
  kind: TraceSpan['kind'],
  status: TraceSpanStatus,
  verdict?: AssessmentVerdict
): TraceSpanColor {
  if (status === 'failed' || verdict === 'FAIL' || verdict === 'BLOCKED') return 'red';
  if (status === 'waiting' || verdict === 'NEEDS_FIX') return 'amber';
  if (status === 'running') return 'blue';
  switch (kind) {
    case 'orchestrator':
    case 'loop':
    case 'parallel':
      return 'purple';
    case 'review':
      return 'emerald';
    case 'agent':
      return 'blue';
    case 'gate':
      return 'amber';
    default:
      return 'slate';
  }
}

export function buildTraceModel(input: {
  readonly run: WorkflowRunState;
  readonly runActive?: boolean;
  readonly liveProgress?: readonly LiveAttemptProgress[];
  readonly agentNames?: Readonly<Record<string, string>>;
  readonly nowMs?: number;
}): TraceModel {
  const { run } = input;
  const agentNames = input.agentNames ?? {};
  const isLive =
    run.status === 'RUNNING' || run.status === 'WAITING' || input.runActive === true;

  const allAttempts = Object.values(run.attempts).sort((a, b) => a.startedAtMs - b.startedAtMs);
  const startMs = run.createdAtMs;

  let maxObservedMs = Math.max(run.createdAtMs, run.updatedAtMs);
  for (const a of allAttempts) {
    maxObservedMs = Math.max(maxObservedMs, a.startedAtMs, a.completedAtMs ?? a.startedAtMs);
  }
  for (const ev of run.events) {
    maxObservedMs = Math.max(maxObservedMs, ev.timestampMs);
  }
  const nowMs = input.nowMs ?? Date.now();
  const endMs = isLive ? Math.max(nowMs, maxObservedMs) : maxObservedMs;
  const durationMs = Math.max(200, endMs - startMs);
  const { axisMaxMs, ticks } = computeNiceAxis(durationMs);

  const toPct = (ms: number) =>
    Math.max(0, Math.min(100, ((ms - startMs) / axisMaxMs) * 100));
  const toWidthPct = (sMs: number, eMs: number) =>
    Math.max(1.2, Math.min(100 - toPct(sMs), ((Math.max(eMs, sMs) - sMs) / axisMaxMs) * 100));

  const plan = compilePlan(run.definition);
  const settled = run.status !== 'RUNNING' && !input.runActive;

  const describeAgent = (node: WorkflowNode, attempt?: NodeAttemptRecord): string => {
    if (node.kind === 'agent') {
      const ref = attempt?.agent?.ref ?? node.agentRef;
      const agentId = ref?.split('@')[0];
      const name = (agentId ? agentNames[agentId] : undefined) ?? agentId ?? node.role;
      const engine =
        attempt?.receipt?.modelId ??
        attempt?.receipt?.agentType ??
        (ref ? run.pinnedAgents[ref]?.profile.runtime.agentType : undefined) ??
        node.modelId ??
        node.agentType;
      return engine && engine !== name ? `${name} · ${engine}` : name;
    }
    if (node.kind === 'script') {
      return [node.command, ...node.args].join(' ');
    }
    if (node.kind === 'gate') {
      return 'Human decision';
    }
    const runsWorkflow = subflowWorkflowId(node);
    if (runsWorkflow) {
      return `Sub-flow · ${runsWorkflow}`;
    }
    if (node.kind === 'loop') {
      return `Up to ${node.maxRounds} rounds`;
    }
    return node.kind === 'parallel' ? `Parallel · max ${node.maxConcurrency}` : 'Sub-flow';
  };

  const buildAttemptChildren = (
    node: WorkflowNode,
    attempt: NodeAttemptRecord,
    scopeState: GraphScopeState | undefined
  ): TraceSpan[] => {
    const children: TraceSpan[] = [];
    const aStart = attempt.startedAtMs;
    const aEnd = attempt.completedAtMs ?? endMs;
    const aDur = Math.max(50, aEnd - aStart);

    // 1. Context / Input read sub-spans from manifest
    const manifest = attempt.contextManifestId ? run.manifests[attempt.contextManifestId] : undefined;
    if (manifest && manifest.entries.length > 0) {
      manifest.entries.forEach((entry, idx) => {
        const subStart = aStart;
        const subEnd = Math.min(aEnd, aStart + Math.max(80, Math.round(aDur * 0.22)));
        children.push({
          id: `${attempt.attemptId}:in:${entry.portName}:${idx}`,
          scopeKey: attempt.scopeKey,
          kind: 'tool',
          title: `Read ${entry.portName}`,
          subtitle: `${entry.sourceNodeId === '$input' ? 'Workflow input' : entry.sourceNodeId} · ${entry.byteSize} B`,
          status: 'done',
          color: 'slate',
          startMs: subStart,
          endMs: subEnd,
          durationMs: Math.max(10, subEnd - subStart),
          startOffsetMs: Math.max(0, subStart - startMs),
          startPct: toPct(subStart),
          widthPct: toWidthPct(subStart, subEnd),
          outputPreview:
            entry.artifactRef?.summary ??
            summarizeValue(entry.inlineValue) ??
            `Port ${entry.portName} (${entry.byteSize} bytes)`,
          ...(entry.artifactRef?.artifactId ? { artifactId: entry.artifactRef.artifactId } : {}),
          artifactTitle: `${node.name} · input ${entry.portName}`,
          children: [],
          segments: [],
        });
      });
    }

    // 2. Assessment / Verdict sub-span if produced
    const assessment = attempt.assessmentId ? run.assessments[attempt.assessmentId] : undefined;
    if (assessment) {
      const revStart = Math.max(aStart, aEnd - Math.max(100, Math.round(aDur * 0.3)));
      const revStatus: TraceSpanStatus =
        assessment.verdict === 'FAIL' || assessment.verdict === 'BLOCKED'
          ? 'failed'
          : assessment.verdict === 'NEEDS_FIX'
            ? 'waiting'
            : 'done';
      children.push({
        id: `${attempt.attemptId}:assessment`,
        scopeKey: attempt.scopeKey,
        kind: 'review',
        title: `Verdict · ${assessment.verdict}`,
        subtitle: assessment.summary.slice(0, 60),
        status: revStatus,
        color: spanColorForKind('review', revStatus, assessment.verdict),
        startMs: revStart,
        endMs: aEnd,
        durationMs: Math.max(10, aEnd - revStart),
        startOffsetMs: Math.max(0, revStart - startMs),
        startPct: toPct(revStart),
        widthPct: toWidthPct(revStart, aEnd),
        verdict: assessment.verdict,
        findings: assessment.findings,
        outputPreview: assessment.summary,
        children: [],
        segments: [],
      });
    }

    // 3. Produced output artifacts
    if (scopeState) {
      const nodeState = scopeState.nodes[node.id];
      for (const [portName, portVal] of Object.entries(nodeState?.outputs ?? {})) {
        if (!portVal.artifactId) continue;
        const outStart = Math.max(aStart, aEnd - Math.max(80, Math.round(aDur * 0.25)));
        children.push({
          id: `${attempt.attemptId}:out:${portName}`,
          scopeKey: attempt.scopeKey,
          kind: 'artifact',
          title: `Write ${portName}`,
          subtitle: `Artifact · ${portName}`,
          status: 'done',
          color: 'emerald',
          startMs: outStart,
          endMs: aEnd,
          durationMs: Math.max(10, aEnd - outStart),
          startOffsetMs: Math.max(0, outStart - startMs),
          startPct: toPct(outStart),
          widthPct: toWidthPct(outStart, aEnd),
          outputPreview: summarizeValue(portVal.value),
          artifactId: portVal.artifactId,
          artifactTitle: `${node.name} · ${portName}`,
          children: [],
          segments: [],
        });
      }
    }

    return children;
  };

  const buildScopeNodeSpans = (
    compiledScope: WorkflowDefinition['graph'] extends unknown ? ReturnType<typeof compilePlan>['rootScope'] : never,
    scopeKey: string
  ): TraceSpan[] => {
    const scopeState = run.scopes[scopeKey];
    const readyIds = new Set<string>(
      scopeState?.status === 'RUNNING' && isLive
        ? computeScopeReadyNodeIds(compiledScope, scopeState)
        : []
    );

    const spans: TraceSpan[] = [];

    for (const nodeId of compiledScope.topologicalOrder) {
      const node = compiledScope.nodesById[nodeId]!;
      const nodeState = scopeState?.nodes[nodeId];

      if (node.kind === 'loop' || node.kind === 'parallel') {
        const childCompiled = compiledScope.childScopes[nodeId]!;
        const instanceKeys = containerInstanceKeys(run, `${scopeKey}/${nodeId}`);
        const instanceSpans: TraceSpan[] = [];

        instanceKeys.forEach((instKey, idx) => {
          const instScope = run.scopes[instKey];
          const childNodeSpans = buildScopeNodeSpans(childCompiled, instKey);
          if (childNodeSpans.length === 0 && !instScope) return;
          const iStart =
            childNodeSpans.length > 0
              ? Math.min(...childNodeSpans.map((c) => c.startMs))
              : startMs;
          const iEnd =
            childNodeSpans.length > 0
              ? Math.max(...childNodeSpans.map((c) => c.endMs))
              : endMs;
          const iStatus: TraceSpanStatus =
            instScope?.status === 'FAILED' || childNodeSpans.some((c) => c.status === 'failed')
              ? 'failed'
              : instScope?.status === 'WAITING' || childNodeSpans.some((c) => c.status === 'waiting')
                ? 'waiting'
                : instScope?.status === 'RUNNING' || childNodeSpans.some((c) => c.status === 'running')
                  ? 'running'
                  : 'done';
          const iCost = childNodeSpans.reduce((s, c) => s + (c.costUsd ?? 0), 0);
          const iInTokens = childNodeSpans.reduce((s, c) => s + (c.inputTokens ?? 0), 0);
          const iOutTokens = childNodeSpans.reduce((s, c) => s + (c.outputTokens ?? 0), 0);
          const label = node.kind === 'loop' ? `Round ${idx + 1}` : `Item ${idx + 1}`;
          const itemPreview =
            node.kind === 'parallel' && instScope?.inputs[node.itemsPort]
              ? summarizeValue(instScope.inputs[node.itemsPort]!.value, 40)
              : undefined;
          const singleChildThinking =
            childNodeSpans.length === 1 ? childNodeSpans[0]!.thinking : undefined;
          if (node.kind === 'parallel' && node.origin && childNodeSpans.length === 1) {
            instanceSpans.push({ ...childNodeSpans[0]!, title: `${node.name} · ${label}`, subtitle: itemPreview ?? childNodeSpans[0]!.subtitle });
            return;
          }
          instanceSpans.push({
            id: `scope:${instKey}`,
            nodeId: node.id,
            scopeKey: instKey,
            kind: node.kind,
            title: `${node.name} · ${label}`,
            subtitle: itemPreview ? `${itemPreview} · ${describeAgent(node)}` : describeAgent(node),
            status: iStatus,
            color: spanColorForKind(node.kind, iStatus),
            startMs: iStart,
            endMs: iEnd,
            durationMs: Math.max(0, iEnd - iStart),
            startOffsetMs: Math.max(0, iStart - startMs),
            startPct: toPct(iStart),
            widthPct: toWidthPct(iStart, iEnd),
            ...(iCost > 0 ? { costUsd: iCost } : {}),
            ...(iInTokens > 0 ? { inputTokens: iInTokens } : {}),
            ...(iOutTokens > 0 ? { outputTokens: iOutTokens } : {}),
            inputPreview: summarizeRecord(instScope?.inputs),
            outputPreview: summarizeRecord(instScope?.outputs),
            ...(singleChildThinking ? { thinking: singleChildThinking } : {}),
            children: childNodeSpans,
            segments: childNodeSpans.map((c) => ({
              id: c.id,
              startPct: c.startPct,
              widthPct: c.widthPct,
              color: c.color,
            })),
          });
        });

        if (instanceSpans.length === 1 && node.kind === 'loop') {
          // Single loop round: still show the loop container with its body steps directly
          const only = instanceSpans[0]!;
          spans.push({
            ...only,
            id: `node:${scopeKey}:${node.id}`,
            title: node.name,
            subtitle: `${describeAgent(node)} · Round 1`,
          });
        } else if (instanceSpans.length > 0) {
          const cStart = Math.min(...instanceSpans.map((c) => c.startMs));
          const cEnd = Math.max(...instanceSpans.map((c) => c.endMs));
          const cStatus: TraceSpanStatus =
            nodeState?.status === 'FAILED' || instanceSpans.some((c) => c.status === 'failed')
              ? 'failed'
              : nodeState?.status === 'WAITING' || instanceSpans.some((c) => c.status === 'waiting')
                ? 'waiting'
                : instanceSpans.some((c) => c.status === 'running')
                  ? 'running'
                  : 'done';
          const cCost = instanceSpans.reduce((s, c) => s + (c.costUsd ?? 0), 0);
          spans.push({
            id: `node:${scopeKey}:${node.id}`,
            nodeId: node.id,
            scopeKey,
            kind: node.kind === 'parallel' && node.origin ? (node.origin.nodeKind === 'subflow' ? 'loop' : node.origin.nodeKind) : node.kind,
            ...(node.kind === 'parallel' && node.origin ? { parallelBatch: true } : {}),
            title: node.name,
            subtitle:
              node.kind === 'loop'
                ? `${instanceSpans.length} rounds`
                : `${instanceSpans.length} parallel items`,
            status: cStatus,
            rerunnable: !isLive,
            ...(nodeState?.error ? { error: nodeState.error } : {}),
            outputPreview: summarizeRecord(nodeState?.outputs),
            color: spanColorForKind(node.kind, cStatus),
            startMs: cStart,
            endMs: cEnd,
            durationMs: Math.max(0, cEnd - cStart),
            startOffsetMs: Math.max(0, cStart - startMs),
            startPct: toPct(cStart),
            widthPct: toWidthPct(cStart, cEnd),
            ...(cCost > 0 ? { costUsd: cCost } : {}),
            children: instanceSpans,
            segments: instanceSpans.map((c) => ({
              id: c.id,
              startPct: c.startPct,
              widthPct: c.widthPct,
              color: c.color,
            })),
          });
        } else if (node.kind === 'parallel' && node.origin) {
          const status: TraceSpanStatus = nodeState?.status === 'FAILED' ? 'failed' : nodeState?.status === 'SUCCEEDED' ? 'done' : 'running';
          spans.push({ id: `node:${scopeKey}:${node.id}`, nodeId: node.id, scopeKey,
            kind: node.origin.nodeKind === 'subflow' ? 'loop' : node.origin.nodeKind, parallelBatch: true,
            title: node.name, subtitle: '0 parallel items', status, color: spanColorForKind('parallel', status),
            startMs, endMs: startMs, durationMs: 0, startOffsetMs: 0, startPct: 0, widthPct: 0,
            outputPreview: summarizeRecord(nodeState?.outputs), ...(nodeState?.error ? { error: nodeState.error } : {}),
            rerunnable: !isLive, children: [], segments: [],
          });
        }
        continue;
      }

      // Leaf node: agent, script, or gate
      const nodeAttempts = allAttempts.filter(
        (a) => a.scopeKey === scopeKey && a.nodeId === nodeId
      );
      const pendingWait =
        nodeState?.activeWaitRequestId &&
        run.waitRequests[nodeState.activeWaitRequestId]?.status === 'PENDING'
          ? run.waitRequests[nodeState.activeWaitRequestId]
          : undefined;
      const waitsForNode = Object.values(run.waitRequests).filter(
        (w) => w.scopeKey === scopeKey && w.nodeId === nodeId
      );

      if (node.kind === 'gate') {
        if (waitsForNode.length === 0 && nodeState?.status === 'PENDING' && !readyIds.has(nodeId)) {
          continue;
        }
        const wait = waitsForNode[waitsForNode.length - 1];
        const gStart = wait?.createdAtMs ?? maxObservedMs;
        const gEnd = wait?.response?.respondedAtMs ?? (pendingWait ? endMs : gStart + 100);
        const gStatus: TraceSpanStatus = pendingWait ? 'waiting' : 'done';
        const decisionVal = nodeState?.outputs[node.outputs[0]?.name ?? 'decision']?.value;
        spans.push({
          id: `gate:${scopeKey}:${node.id}`,
          nodeId: node.id,
          scopeKey,
          kind: 'gate',
          title: node.name,
          subtitle: decisionVal !== undefined ? `Decision · ${String(decisionVal)}` : 'Human gate',
          status: gStatus,
          color: spanColorForKind('gate', gStatus),
          startMs: gStart,
          endMs: gEnd,
          durationMs: Math.max(0, gEnd - gStart),
          startOffsetMs: Math.max(0, gStart - startMs),
          startPct: toPct(gStart),
          widthPct: toWidthPct(gStart, gEnd),
          inputPreview: node.prompt,
          outputPreview: decisionVal !== undefined ? String(decisionVal) : undefined,
          ...(pendingWait ? { pendingWait } : {}),
          children: [],
          segments: [],
        });
        continue;
      }

      const isCurrentlyRunning =
        readyIds.has(nodeId) ||
        nodeState?.status === 'RUNNING' ||
        nodeAttempts.some((a) => a.status === 'RUNNING');

      if (nodeAttempts.length === 0 && !isCurrentlyRunning && !pendingWait) {
        continue;
      }

      if (nodeAttempts.length === 0 && isCurrentlyRunning) {
        // Node is actively executing right now (before its first attempt record is committed)
        const live = input.liveProgress?.find((p) => p.scopeKey === scopeKey && p.nodeId === nodeId);
        const activeStartMs = live?.startedAtMs ?? maxObservedMs;
        const activeEndMs = Math.max(endMs, activeStartMs + 200);
        const thinking = buildNodeThinkingTrace({
          node,
          status: 'running',
          ...(live ? { live } : {}),
        });
        spans.push({
          id: `running:${scopeKey}:${node.id}`,
          ...(node.kind === 'agent' ? { hasConversation: true } : {}),
          nodeId: node.id,
          scopeKey,
          kind: node.kind === 'agent' ? 'agent' : 'script',
          title: node.name,
          subtitle: describeAgent(node),
          status: 'running',
          color: 'blue',
          startMs: activeStartMs,
          endMs: activeEndMs,
          durationMs: Math.max(100, activeEndMs - activeStartMs),
          startOffsetMs: Math.max(0, activeStartMs - startMs),
          startPct: toPct(activeStartMs),
          widthPct: toWidthPct(activeStartMs, activeEndMs),
          inputPreview: summarizeRecord(scopeState?.inputs),
          ...(thinking ? { thinking } : {}),
          children: [],
          segments: [],
        });
        continue;
      }

      // Build span from attempts
      const latestAttempt = nodeAttempts[nodeAttempts.length - 1]!;
      const live = input.liveProgress?.find((p) => p.scopeKey === scopeKey && p.nodeId === nodeId);
      const firstStart = nodeAttempts[0]!.startedAtMs;
      const lastEnd = isCurrentlyRunning
        ? endMs
        : (latestAttempt.completedAtMs ?? latestAttempt.startedAtMs + (latestAttempt.receipt?.durationMs ?? 100));
      const assessment = latestAttempt.assessmentId
        ? run.assessments[latestAttempt.assessmentId]
        : undefined;
      const manifest = latestAttempt.contextManifestId
        ? run.manifests[latestAttempt.contextManifestId]
        : undefined;
      const readReceipts = run.readReceipts.filter((r) => r.attemptId === latestAttempt.attemptId);
      const verdict = assessment?.verdict ?? nodeState?.latestVerdict;
      const spanStatus: TraceSpanStatus = isCurrentlyRunning
        ? 'running'
        : pendingWait || latestAttempt.status === 'WAITING'
          ? 'waiting'
          : latestAttempt.status === 'FAILED' ||
              nodeState?.status === 'FAILED' ||
              verdict === 'FAIL' ||
              verdict === 'BLOCKED'
            ? 'failed'
            : 'done';
      const thinking = buildNodeThinkingTrace({
        node,
        status:
          spanStatus === 'running'
            ? 'running'
            : spanStatus === 'waiting'
              ? 'waiting'
              : spanStatus === 'failed'
                ? 'failed'
                : 'succeeded',
        attempt: latestAttempt,
        ...(live ? { live } : {}),
        ...(manifest ? { manifest } : {}),
        ...(assessment ? { assessment } : {}),
        readReceipts,
      });

      const costUsd = nodeAttempts.reduce((sum, a) => sum + (a.receipt?.totalCostUsd ?? 0), 0);
      const inputTokens = nodeAttempts.reduce((sum, a) => sum + (a.receipt?.inputTokens ?? 0), 0);
      const outputTokens = nodeAttempts.reduce((sum, a) => sum + (a.receipt?.outputTokens ?? 0), 0);
      const firstOutputPort = node.outputs[0]?.name;
      const firstOutputRecord = firstOutputPort ? nodeState?.outputs[firstOutputPort] : undefined;
      const subChildren = buildAttemptChildren(node, latestAttempt, scopeState);

      const spanKind: TraceSpan['kind'] =
        node.kind === 'agent'
          ? node.producesAssessment
            ? 'review'
            : 'agent'
          : 'script';

      const color = spanColorForKind(spanKind, spanStatus, verdict);

      spans.push({
        id: `node:${scopeKey}:${node.id}`,
        ...(node.kind === 'agent' ? { hasConversation: true } : {}),
        nodeId: node.id,
        scopeKey,
        kind: spanKind,
        title: node.name,
        subtitle: describeAgent(node, latestAttempt),
        status: spanStatus,
        color,
        startMs: firstStart,
        endMs: lastEnd,
        durationMs: Math.max(
          latestAttempt.receipt?.durationMs ?? 0,
          lastEnd - firstStart
        ),
        startOffsetMs: Math.max(0, firstStart - startMs),
        startPct: toPct(firstStart),
        widthPct: toWidthPct(firstStart, lastEnd),
        ...(costUsd > 0 ? { costUsd } : {}),
        ...(inputTokens > 0 ? { inputTokens } : {}),
        ...(outputTokens > 0 ? { outputTokens } : {}),
        ...(verdict ? { verdict } : {}),
        ...(assessment?.findings?.length ? { findings: assessment.findings } : {}),
        ...(latestAttempt.error ?? nodeState?.error
          ? { error: latestAttempt.error ?? nodeState?.error }
          : {}),
        inputPreview:
          node.kind === 'script'
            ? [node.command, ...node.args].join(' ')
            : summarizeRecord(scopeState?.inputs),
        outputPreview:
          assessment?.summary ??
          summarizeValue(firstOutputRecord?.value) ??
          summarizeRecord(nodeState?.outputs),
        ...(firstOutputRecord?.artifactId
          ? {
              artifactId: firstOutputRecord.artifactId,
              artifactTitle: `${node.name} · ${firstOutputPort}`,
            }
          : {}),
        ...(latestAttempt.changes ? { changes: latestAttempt.changes } : {}),
        ...(pendingWait ? { pendingWait } : {}),
        ...(thinking ? { thinking } : {}),
        rerunnable:
          settled &&
          scopeKey === '$root' &&
          (nodeState?.status === 'SUCCEEDED' || nodeState?.status === 'FAILED'),
        children: subChildren,
        segments:
          subChildren.length > 0
            ? subChildren.map((c) => ({
                id: c.id,
                startPct: c.startPct,
                widthPct: c.widthPct,
                color: c.color,
              }))
            : [{ id: latestAttempt.attemptId, startPct: toPct(firstStart), widthPct: toWidthPct(firstStart, lastEnd), color }],
      });
    }

    return spans;
  };

  let rootSpans = buildScopeNodeSpans(plan.rootScope, '$root');

  // Mark the slowest completed top-level or second-level span (when >= 2 spans exist)
  const candidateLeafSpans: TraceSpan[] = [];
  const collectCandidates = (list: readonly TraceSpan[]) => {
    for (const s of list) {
      if (s.kind === 'loop' || s.kind === 'parallel' || s.parallelBatch) {
        collectCandidates(s.children);
      } else if (s.status === 'done' && s.durationMs > 0) {
        candidateLeafSpans.push(s);
      }
    }
  };
  collectCandidates(rootSpans);
  const slowestId =
    candidateLeafSpans.length >= 2
      ? candidateLeafSpans.reduce((a, b) => (a.durationMs >= b.durationMs ? a : b)).id
      : null;

  const markSlowest = (list: readonly TraceSpan[]): TraceSpan[] =>
    list.map((s) => ({
      ...s,
      ...(s.id === slowestId ? { isSlowest: true } : {}),
      children: markSlowest(s.children),
    }));
  if (slowestId) {
    rootSpans = markSlowest(rootSpans);
  }

  // Compute aggregate metrics
  const totalCostUsd = allAttempts.reduce((sum, a) => sum + (a.receipt?.totalCostUsd ?? 0), 0);
  const totalTokens = allAttempts.reduce(
    (sum, a) => sum + (a.receipt?.inputTokens ?? 0) + (a.receipt?.outputTokens ?? 0),
    0
  );
  const llmCalls = allAttempts.filter((a) => Boolean(a.agent || a.receipt?.agentType)).length;
  const scriptCalls = allAttempts.filter((a) => !a.agent && !a.receipt?.agentType).length;
  const toolCalls = scriptCalls + run.readReceipts.length;
  const errorCount = allAttempts.filter((a) => {
    const v = a.assessmentId ? run.assessments[a.assessmentId]?.verdict : undefined;
    return a.status === 'FAILED' || v === 'FAIL' || v === 'BLOCKED';
  }).length;

  const firstInputString = Object.values(run.inputs).find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  );
  const headline = firstInputString
    ? firstInputString.trim()
    : run.definition.description ?? run.definition.name;

  const overallStatus: TraceModel['status'] =
    run.status === 'FAILED' || run.status === 'CANCELLED'
      ? 'failed'
      : run.status === 'WAITING'
        ? 'waiting'
        : isLive
          ? 'live'
          : 'done';

  const playheadPct = Math.max(0, Math.min(100, (durationMs / axisMaxMs) * 100));

  return {
    runId: run.runId,
    workflowName: run.definition.name,
    headline,
    status: overallStatus,
    startMs,
    endMs,
    durationMs,
    totalCostUsd,
    totalTokens,
    llmCalls,
    toolCalls,
    errorCount,
    ticks,
    playheadPct,
    spans: rootSpans,
  };
}
