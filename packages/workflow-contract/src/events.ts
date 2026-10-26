import type { ManifestWorkspace } from './workspace';
import type { ChiefCommand, ChiefTriggerKind } from './chief';
import type { AssessmentVerdict } from './schema';

export type WorkflowRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type NodeExecutionStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED'
  | 'STALE';

export type StagePhase = 'open' | 'prepare' | 'accept' | 'publish';

export interface ArtifactVersion {
  readonly artifactId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly producerRunId: string;
  readonly producerNodeId: string;
  readonly producerAttemptId: string;
  readonly portName: string;
  readonly summary?: string;
  readonly sections?: readonly string[];
  readonly uri?: string;
  readonly createdAtMs: number;
}

export interface AssessmentFinding {
  readonly id: string;
  readonly severity: 'critical' | 'major' | 'minor' | 'info';
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
}

export interface AssessmentRecord {
  readonly assessmentId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly targetArtifactIds: readonly string[];
  readonly verdict: AssessmentVerdict;
  readonly summary: string;
  readonly findings: readonly AssessmentFinding[];
  readonly independentReviewer: boolean;
  readonly stale: boolean;
  readonly createdAtMs: number;
}

export interface ContextPortEntry {
  readonly portName: string;
  readonly sourceNodeId: string;
  readonly sourcePort: string;
  readonly mode: 'inline' | 'artifact_ref';
  readonly inlineValue?: unknown;
  readonly artifactRef?: {
    readonly artifactId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly summary?: string;
    readonly sections?: readonly string[];
  };
  readonly byteSize: number;
  readonly selectionReason: string;
}

export interface ContextManifest {
  readonly manifestId: string;
  /** Agent profile the task was delegated to, pinned for reproducibility. */
  readonly agent?: { readonly ref: string; readonly digest: string };
  /** Chief guidance injected into this attempt, verbatim. */
  readonly chiefGuidance?: readonly string[];
  /** Directory the attempt works in and the slots it may read. */
  readonly workspace?: ManifestWorkspace;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly scopeKey: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly entries: readonly ContextPortEntry[];
  readonly authorizedArtifactIds: readonly string[];
  readonly totalInlineBytes: number;
  readonly initialBudgetBytes: number;
  readonly pageReadBytes: number;
  /** Cumulative artifact read quota for this attempt; absent means unlimited. */
  readonly stageReadQuotaBytes?: number;
  readonly createdAtMs: number;
}

export interface ArtifactReadReceipt {
  readonly receiptId: string;
  readonly attemptId: string;
  readonly artifactId: string;
  readonly offsetBytes: number;
  readonly readBytes: number;
  readonly section?: string;
  readonly timestampMs: number;
}

export interface ThinkingStepPill {
  readonly label: string;
  /** Short badge such as 'TS', 'JS', 'JSON', 'MD', 'SH', 'ART', 'IN'. */
  readonly badge?: string;
  readonly path?: string;
}

export interface ThinkingStepSubItem {
  readonly id: string;
  readonly text: string;
  readonly status?: 'running' | 'done' | 'failed';
}

export interface ThinkingStep {
  readonly id: string;
  readonly kind: 'think' | 'search' | 'read' | 'edit' | 'execute' | 'plan' | 'draft' | 'done' | 'fail';
  readonly status: 'running' | 'done' | 'failed';
  readonly label: string;
  readonly detail?: string;
  readonly pills?: readonly ThinkingStepPill[];
  readonly subItems?: readonly ThinkingStepSubItem[];
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
}

export interface LiveAttemptProgress {
  readonly runId: string;
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly startedAtMs: number;
  readonly steps: readonly ThinkingStep[];
}

export interface WaitRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly prompt: string;
  readonly options: readonly { value: string; label: string; description?: string }[];
  readonly requiredRole?: string;
  readonly sessionBinding?: {
    readonly sessionId: string;
    readonly acpSessionId: string;
    readonly agentType: string;
  };
  readonly status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
  readonly response?: {
    readonly answer: string | Record<string, unknown>;
    readonly responderId: string;
    readonly respondedAtMs: number;
  };
  readonly createdAtMs: number;
}

export type WorkflowEvent =
  | {
      readonly type: 'run.started';
      readonly runId: string;
      readonly definitionId: string;
      readonly definitionDigest: string;
      readonly timestampMs: number;
    }
  | {
      readonly type: 'node.stage';
      readonly runId: string;
      readonly scopeKey: string;
      readonly nodeId: string;
      readonly attemptId: string;
      readonly phase: StagePhase;
      readonly timestampMs: number;
    }
  | {
      readonly type: 'node.completed';
      readonly runId: string;
      readonly scopeKey: string;
      readonly nodeId: string;
      readonly attemptId: string;
      readonly status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
      readonly verdict?: AssessmentVerdict;
      readonly timestampMs: number;
    }
  | {
      readonly type: 'node.waiting';
      readonly runId: string;
      readonly scopeKey: string;
      readonly nodeId: string;
      readonly attemptId: string;
      readonly requestId: string;
      readonly prompt: string;
      readonly timestampMs: number;
    }
  | {
      readonly type: 'node.invalidated';
      readonly runId: string;
      readonly scopeKey: string;
      readonly nodeId: string;
      readonly reason: string;
      readonly timestampMs: number;
    }
  | {
      readonly type: 'loop.round.advanced';
      readonly runId: string;
      /** Scope that contains the loop node. */
      readonly scopeKey?: string;
      readonly loopNodeId: string;
      readonly roundIndex: number;
      readonly timestampMs: number;
    }
  | {
      /** A human wrote to the run's chief. */
      readonly type: 'chief.user_message';
      readonly runId: string;
      readonly messageId: string;
      readonly text: string;
      readonly authorId: string;
      readonly timestampMs: number;
    }
  | {
      readonly type: 'chief.intervened';
      readonly runId: string;
      readonly trigger: ChiefTriggerKind;
      readonly scopeKey?: string;
      readonly nodeId?: string;
      /** The `chief.user_message` this answers. */
      readonly inReplyTo?: string;
      /** What the chief told the human. */
      readonly reply?: string;
      readonly rationale: string;
      readonly applied: readonly ChiefCommand[];
      readonly rejected: readonly { readonly command: ChiefCommand; readonly reason: string }[];
      readonly durationMs?: number;
      readonly steps?: readonly ThinkingStep[];
      readonly timestampMs: number;
    }
  | {
      readonly type: 'chief.escalation_resolved';
      readonly runId: string;
      readonly requestId: string;
      readonly answer: string | Record<string, unknown>;
      readonly responderId: string;
      readonly timestampMs: number;
    }
  | {
      /** The run was forked from another run: `inherited` steps were taken over, the rest runs again. */
      readonly type: 'run.forked';
      readonly runId: string;
      readonly sourceRunId: string;
      readonly fromNodeId: string;
      readonly inherited: readonly string[];
      readonly timestampMs: number;
    }
  | {
      readonly type: 'run.finished';
      readonly runId: string;
      readonly status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
      readonly timestampMs: number;
    };
