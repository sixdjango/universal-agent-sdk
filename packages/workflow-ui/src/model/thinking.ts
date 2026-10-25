import type {
  ArtifactReadReceipt,
  AssessmentRecord,
  ContextManifest,
  LiveAttemptProgress,
  ThinkingStep,
  ThinkingStepPill,
  ThinkingStepSubItem,
  WorkflowNode,
} from '@universal-agent/workflow-contract';
import type { NodeAttemptRecord } from '@universal-agent/workflow-runtime';
import type { ViewStatus } from './canvas';

export interface ThinkingTraceModel {
  readonly state: 'running' | 'done' | 'failed';
  readonly headerLabel: string;
  readonly startedAtMs?: number;
  readonly durationMs?: number;
  readonly steps: readonly ThinkingStep[];
  readonly summary?: string;
}

function fileBadge(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'TSX';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'TS';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'JS';
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'MD';
  if (lower.endsWith('.css') || lower.endsWith('.scss')) return 'CSS';
  if (lower.endsWith('.py')) return 'PY';
  if (lower.endsWith('.sh') || lower.endsWith('.zsh')) return 'SH';
  if (lower.endsWith('.sql')) return 'SQL';
  return 'FILE';
}

function baseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

export function formatThinkingSeconds(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return '0s';
  if (ms < 1000) return '<1s';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

/**
 * Builds the interactive thinking/execution timeline for a workflow node (on a canvas card
 * or in the trace inspector). Combines live streaming ACP steps while running with durable
 * receipt steps, context manifests, artifact reads, workspace file diffs and review findings.
 */
export function buildNodeThinkingTrace(input: {
  readonly node: WorkflowNode;
  readonly status: ViewStatus;
  readonly attempt?: NodeAttemptRecord;
  readonly live?: LiveAttemptProgress;
  readonly manifest?: ContextManifest;
  readonly assessment?: AssessmentRecord;
  readonly readReceipts?: readonly ArtifactReadReceipt[];
  readonly chiefGuidance?: readonly string[];
}): ThinkingTraceModel | undefined {
  const { node, status, attempt, live, manifest, assessment } = input;
  const readReceipts = input.readReceipts ?? [];
  const chiefGuidance = input.chiefGuidance ?? manifest?.chiefGuidance ?? [];

  if (status === 'running') {
    if (live && live.steps.length > 0) {
      return {
        state: 'running',
        headerLabel: 'Thinking',
        startedAtMs: live.startedAtMs,
        steps: live.steps,
      };
    }

    const steps: ThinkingStep[] = [];
    const inputPills: ThinkingStepPill[] = (manifest?.entries ?? node.inputs).map((entry) =>
      'portName' in entry
        ? { label: entry.portName, badge: entry.mode === 'artifact_ref' ? 'ART' : 'IN' }
        : { label: entry.name, badge: entry.type === 'artifact' ? 'ART' : 'IN' }
    );
    if (inputPills.length > 0) {
      steps.push({
        id: `${node.id}:inputs`,
        kind: 'read',
        status: 'done',
        label: `Prepared ${inputPills.length} input${inputPills.length === 1 ? '' : 's'}`,
        pills: inputPills,
      });
    }
    if (chiefGuidance.length > 0) {
      steps.push({
        id: `${node.id}:guidance`,
        kind: 'think',
        status: 'done',
        label: 'Applied chief guidance',
        subItems: chiefGuidance.map((text, i) => ({ id: `g-${i}`, text, status: 'done' as const })),
      });
    }
    if (node.kind === 'agent') {
      const criteriaSubItems: ThinkingStepSubItem[] = node.acceptanceCriteria.slice(0, 3).map((c, i) => ({
        id: `crit-${i}`,
        text: c,
        status: 'running' as const,
      }));
      steps.push({
        id: `${node.id}:work`,
        kind: 'think',
        status: 'running',
        label: node.producesAssessment ? 'Checking acceptance criteria' : `Working on "${node.name}"`,
        ...(criteriaSubItems.length > 0 ? { subItems: criteriaSubItems } : {}),
      });
    } else if (node.kind === 'script') {
      steps.push({
        id: `${node.id}:script`,
        kind: 'execute',
        status: 'running',
        label: `Running ${[node.command, ...node.args].join(' ').slice(0, 60)}`,
      });
    } else {
      steps.push({
        id: `${node.id}:container`,
        kind: 'think',
        status: 'running',
        label: `Running steps in "${node.name}"`,
      });
    }

    return {
      state: 'running',
      headerLabel: 'Thinking',
      ...(attempt?.startedAtMs ? { startedAtMs: attempt.startedAtMs } : {}),
      steps,
    };
  }

  if (status !== 'succeeded' && status !== 'failed' && status !== 'waiting') {
    return undefined;
  }
  if (!attempt) return undefined;

  const failed = status === 'failed' || attempt.status === 'FAILED';
  const durationMs =
    attempt.receipt?.durationMs ??
    (attempt.completedAtMs !== undefined ? Math.max(0, attempt.completedAtMs - attempt.startedAtMs) : undefined);

  const steps: ThinkingStep[] = [];

  if (chiefGuidance.length > 0) {
    steps.push({
      id: `${attempt.attemptId}:guidance`,
      kind: 'think',
      status: 'done',
      label: 'Applied chief guidance',
      subItems: chiefGuidance.map((text, i) => ({ id: `g-${i}`, text, status: 'done' as const })),
    });
  }

  if (attempt.receipt?.steps && attempt.receipt.steps.length > 0) {
    for (const step of attempt.receipt.steps) {
      steps.push({
        ...step,
        status: step.status === 'running' ? (failed ? 'failed' : 'done') : step.status,
      });
    }
  } else {
    const inputPills: ThinkingStepPill[] = (manifest?.entries ?? []).map((entry) => ({
      label: entry.portName,
      badge: entry.mode === 'artifact_ref' ? 'ART' : 'IN',
    }));
    if (inputPills.length > 0) {
      steps.push({
        id: `${attempt.attemptId}:inputs`,
        kind: 'read',
        status: 'done',
        label: `Read ${inputPills.length} input${inputPills.length === 1 ? '' : 's'}`,
        pills: inputPills,
      });
    }

    if (readReceipts.length > 0) {
      steps.push({
        id: `${attempt.attemptId}:receipts`,
        kind: 'read',
        status: 'done',
        label: `Read ${readReceipts.length} artifact page${readReceipts.length === 1 ? '' : 's'}`,
      });
    }

    if (node.kind === 'script') {
      const cmd = [node.command, ...node.args].join(' ');
      steps.push({
        id: `${attempt.attemptId}:script`,
        kind: 'execute',
        status: failed ? 'failed' : 'done',
        label: `Ran ${cmd.length > 52 ? `${cmd.slice(0, 51)}…` : cmd}`,
        ...(attempt.receipt?.exitCode !== undefined && attempt.receipt.exitCode !== null
          ? {
              subItems: [
                {
                  id: `${attempt.attemptId}:exit`,
                  text: `Exit code ${attempt.receipt.exitCode}`,
                  status: attempt.receipt.exitCode === 0 ? ('done' as const) : ('failed' as const),
                },
              ],
            }
          : {}),
      });
    } else if (node.kind === 'agent') {
      const outPills: ThinkingStepPill[] = node.outputs.map((out) => ({
        label: out.name,
        badge: out.type === 'artifact' ? 'ART' : 'OUT',
      }));
      steps.push({
        id: `${attempt.attemptId}:agent`,
        kind: node.producesAssessment ? 'think' : 'draft',
        status: failed && !assessment ? 'failed' : 'done',
        label: node.producesAssessment
          ? `Checked ${node.acceptanceCriteria.length || 'acceptance'} criteria`
          : outPills.length > 0
            ? `Produced ${outPills.map((p) => p.label).join(', ')}`
            : `Completed "${node.name}"`,
        ...(outPills.length > 0 ? { pills: outPills } : {}),
      });
    } else if (node.kind === 'gate') {
      steps.push({
        id: `${attempt.attemptId}:gate`,
        kind: 'think',
        status: status === 'waiting' ? 'running' : 'done',
        label: status === 'waiting' ? 'Waiting for human decision' : 'Recorded human decision',
      });
    }
  }

  // Append workspace file changes if not already represented by an edit step
  if (attempt.changes && attempt.changes.files.length > 0 && !steps.some((s) => s.kind === 'edit')) {
    const filePills: ThinkingStepPill[] = attempt.changes.files.map((f) => ({
      label: baseName(f.path),
      badge: fileBadge(f.path),
      path: f.path,
    }));
    steps.push({
      id: `${attempt.attemptId}:changes`,
      kind: 'edit',
      status: 'done',
      label: `Updated ${filePills.length} file${filePills.length === 1 ? '' : 's'}`,
      pills: filePills,
    });
  }

  // Append assessment verdict & findings
  if (assessment) {
    const verdictFailed = assessment.verdict === 'FAIL' || assessment.verdict === 'BLOCKED';
    const needsFix = assessment.verdict === 'NEEDS_FIX';
    const subItems: ThinkingStepSubItem[] =
      assessment.findings.length > 0
        ? assessment.findings.slice(0, 4).map((f) => ({
            id: f.id,
            text: `${f.filePath ? `${baseName(f.filePath)}: ` : ''}${f.message}`,
            status: verdictFailed || needsFix ? ('failed' as const) : ('done' as const),
          }))
        : assessment.summary
          ? [{ id: `${assessment.assessmentId}:sum`, text: assessment.summary, status: 'done' as const }]
          : [];
    steps.push({
      id: `${attempt.attemptId}:assessment`,
      kind: 'think',
      status: verdictFailed ? 'failed' : 'done',
      label: `Verdict: ${assessment.verdict}`,
      ...(subItems.length > 0 ? { subItems } : {}),
    });
  }

  if (attempt.error) {
    steps.push({
      id: `${attempt.attemptId}:error`,
      kind: 'fail',
      status: 'failed',
      label: attempt.error.length > 96 ? `${attempt.error.slice(0, 95)}…` : attempt.error,
    });
  }

  const summaryParts: string[] = [];
  if (assessment?.verdict) summaryParts.push(assessment.verdict);
  if (attempt.producedArtifactIds.length > 0) {
    summaryParts.push(`${attempt.producedArtifactIds.length} artifact${attempt.producedArtifactIds.length === 1 ? '' : 's'}`);
  }
  if (attempt.changes && attempt.changes.files.length > 0) {
    summaryParts.push(`${attempt.changes.files.length} file${attempt.changes.files.length === 1 ? '' : 's'}`);
  }
  if (summaryParts.length === 0 && steps.length > 0) {
    summaryParts.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`);
  }

  const durText = formatThinkingSeconds(durationMs);
  return {
    state: status === 'waiting' ? 'running' : failed ? 'failed' : 'done',
    headerLabel:
      status === 'waiting'
        ? 'Waiting'
        : failed
          ? `Stopped after ${durText}`
          : `Thought for ${durText}`,
    ...(durationMs !== undefined ? { durationMs } : {}),
    steps,
    ...(summaryParts.length > 0 ? { summary: summaryParts.join(' · ') } : {}),
  };
}

/**
 * Builds the interactive thinking timeline for the chief agent in `ChiefDock`, either while
 * it is actively thinking (`live`) or for a completed `chief.intervened` entry.
 */
export function buildChiefThinkingTrace(input: {
  readonly running: boolean;
  readonly live?: LiveAttemptProgress;
  readonly triggerLabel?: string;
  readonly nodeName?: string;
  readonly rationale?: string;
  readonly applied?: readonly string[];
  readonly rejected?: readonly string[];
  readonly durationMs?: number;
  readonly steps?: readonly ThinkingStep[];
}): ThinkingTraceModel {
  if (input.running) {
    if (input.live && input.live.steps.length > 0) {
      return {
        state: 'running',
        headerLabel: 'Thinking',
        startedAtMs: input.live.startedAtMs,
        steps: input.live.steps,
      };
    }
    return {
      state: 'running',
      headerLabel: 'Thinking',
      steps: [
        {
          id: 'chief-live-inspect',
          kind: 'read',
          status: 'done',
          label: 'Inspected run state & active scopes',
        },
        {
          id: 'chief-live-think',
          kind: 'think',
          status: 'running',
          label: 'Evaluating workflow progress & next action',
        },
      ],
    };
  }

  const steps: ThinkingStep[] = [];
  if (input.steps && input.steps.length > 0) {
    for (const s of input.steps) {
      steps.push({ ...s, status: s.status === 'running' ? 'done' : s.status });
    }
  } else {
    steps.push({
      id: 'chief-trigger',
      kind: 'read',
      status: 'done',
      label: input.triggerLabel
        ? `Checked ${input.triggerLabel}${input.nodeName ? ` · ${input.nodeName}` : ''}`
        : 'Inspected run state & active scopes',
    });
    if (input.rationale) {
      steps.push({
        id: 'chief-rationale',
        kind: 'think',
        status: 'done',
        label: input.rationale.length > 96 ? `${input.rationale.slice(0, 95)}…` : input.rationale,
      });
    }
  }

  const applied = input.applied ?? [];
  const rejected = input.rejected ?? [];
  if (applied.length > 0) {
    steps.push({
      id: 'chief-applied',
      kind: 'execute',
      status: 'done',
      label: `Applied ${applied.length} action${applied.length === 1 ? '' : 's'}`,
      subItems: applied.map((text, i) => ({ id: `app-${i}`, text, status: 'done' as const })),
    });
  }
  if (rejected.length > 0) {
    steps.push({
      id: 'chief-rejected',
      kind: 'fail',
      status: 'failed',
      label: `Blocked ${rejected.length} disallowed action${rejected.length === 1 ? '' : 's'}`,
      subItems: rejected.map((text, i) => ({ id: `rej-${i}`, text, status: 'failed' as const })),
    });
  }

  const durText = formatThinkingSeconds(input.durationMs);
  const summary =
    applied.length > 0
      ? `${applied.length} action${applied.length === 1 ? '' : 's'} · ${steps.length} step${steps.length === 1 ? '' : 's'}`
      : `${steps.length} step${steps.length === 1 ? '' : 's'}`;

  return {
    state: 'done',
    headerLabel: input.durationMs !== undefined ? `Thought for ${durText}` : 'Thought',
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    steps,
    summary,
  };
}
