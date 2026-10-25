import type { AssessmentFinding, AssessmentVerdict } from '@universal-agent/workflow-contract';
import type { NodeDataRecord } from './node-data';
import type { WorkflowRunState } from './ports';

/** Collection steps log problems they knowingly leave for later in (`ua-workflow issue …`). */
export const ISSUES_COLLECTION = 'issues';

export type FindingSeverity = AssessmentFinding['severity'];
const SEVERITIES: readonly FindingSeverity[] = ['critical', 'major', 'minor', 'info'];

/** A problem still open in a run: left by a review, or logged by a step. */
export interface OpenFinding {
  readonly source: 'assessment' | 'issue';
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
  /** The review's verdict (for findings from a review). */
  readonly verdict?: AssessmentVerdict;
  readonly assessmentId?: string;
  readonly attemptId?: string;
  /** Anything else the step logged with an issue. */
  readonly details?: Record<string, unknown>;
  readonly recordedAtMs: number;
}

/** A loop's rounds are one step, the latest round speaking for it; parallel items stay apart. */
const stepKey = (scopeKey: string, nodeId: string) => `${scopeKey.replace(/:round_\d+/g, '')}\u0000${nodeId}`;

/**
 * What reviews left open: for each reviewing step, its latest current assessment's findings
 * (a PASS can carry minor ones). A verdict short of PASS without findings counts as one major
 * finding, so it is not lost.
 */
export function openAssessmentFindings(state: Pick<WorkflowRunState, 'assessments' | 'attempts'>): OpenFinding[] {
  const latest = new Map<string, { scopeKey: string; assessment: WorkflowRunState['assessments'][string] }>();
  for (const assessment of Object.values(state.assessments)) {
    if (assessment.stale) continue;
    const scopeKey = state.attempts[assessment.attemptId]?.scopeKey ?? '$root';
    const key = stepKey(scopeKey, assessment.nodeId);
    const seen = latest.get(key);
    if (!seen || seen.assessment.createdAtMs <= assessment.createdAtMs) latest.set(key, { scopeKey, assessment });
  }
  const findings: OpenFinding[] = [];
  for (const { scopeKey, assessment } of latest.values()) {
    const base = {
      source: 'assessment' as const,
      scopeKey,
      nodeId: assessment.nodeId,
      verdict: assessment.verdict,
      assessmentId: assessment.assessmentId,
      attemptId: assessment.attemptId,
      recordedAtMs: assessment.createdAtMs,
    };
    if (assessment.findings.length === 0) {
      if (assessment.verdict !== 'PASS') findings.push({ ...base, severity: 'major', message: assessment.summary });
      continue;
    }
    for (const finding of assessment.findings) {
      findings.push({
        ...base,
        severity: finding.severity,
        message: finding.message,
        ...(finding.filePath ? { filePath: finding.filePath } : {}),
        ...(finding.line !== undefined ? { line: finding.line } : {}),
      });
    }
  }
  return findings;
}

/**
 * Issues steps logged: a record's value is a message, or an object with `message` (or `note`,
 * `text`), optional `severity` (default minor), `file`/`filePath` and `line`; other fields are
 * kept as details. A step logging the same issue again (say, every loop round) counts once.
 */
export function issueFindings(records: readonly NodeDataRecord[]): OpenFinding[] {
  const latest = new Map<string, OpenFinding>();
  for (const finding of records.map(toIssue)) {
    const key = [stepKey(finding.scopeKey, finding.nodeId), finding.severity, finding.message, finding.filePath ?? ''].join('\u0000');
    const seen = latest.get(key);
    if (!seen || seen.recordedAtMs <= finding.recordedAtMs) latest.set(key, finding);
  }
  return [...latest.values()];
}

function toIssue(record: NodeDataRecord): OpenFinding {
  const value = record.value;
  const fields: Record<string, unknown> =
    value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : { message: value };
  const take = (...names: string[]) => {
    for (const name of names) {
      if (fields[name] !== undefined) {
        const found = fields[name];
        for (const n of names) delete fields[n];
        return found;
      }
    }
    return undefined;
  };
  const message = take('message', 'note', 'text');
  const severity = take('severity');
  const filePath = take('filePath', 'file');
  const line = take('line');
  return {
    source: 'issue',
    scopeKey: record.scopeKey,
    nodeId: record.nodeId,
    severity: SEVERITIES.includes(severity as FindingSeverity) ? (severity as FindingSeverity) : 'minor',
    message: typeof message === 'string' ? message : JSON.stringify(message ?? value),
    ...(typeof filePath === 'string' ? { filePath } : {}),
    ...(typeof line === 'number' ? { line } : {}),
    ...(record.attemptId ? { attemptId: record.attemptId } : {}),
    ...(Object.keys(fields).length > 0 ? { details: fields } : {}),
    recordedAtMs: record.createdAtMs,
  } satisfies OpenFinding;
}

/** Most severe first, then in the order they were recorded. */
export function sortFindings(findings: readonly OpenFinding[]): OpenFinding[] {
  return [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.recordedAtMs - b.recordedAtMs);
}
