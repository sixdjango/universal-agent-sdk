import type { WorkflowValidationIssue } from '@universal-agent/workflow-contract';

export type WorkflowHostErrorCode = 'not_found' | 'conflict' | 'invalid';

/**
 * Errors from the workflow host services (library, workspaces, runs) that callers can act on:
 * `not_found`, `conflict` (already exists / still running), `invalid` (bad input). HTTP hosts
 * map them to 404 / 409 / 400; anything else is an internal failure.
 */
export class WorkflowHostError extends Error {
  readonly code: WorkflowHostErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: WorkflowHostErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'WorkflowHostError';
    this.code = code;
    if (details) this.details = details;
  }
}

export const notFound = (what: string) => new WorkflowHostError('not_found', `${what} not found`);
export const conflict = (message: string) => new WorkflowHostError('conflict', message);
export const invalid = (message: string, details?: Readonly<Record<string, unknown>>) =>
  new WorkflowHostError('invalid', message, details);

export function invalidDefinition(issues: readonly WorkflowValidationIssue[]): WorkflowHostError {
  return invalid(`Workflow definition is invalid (${issues.length} issue(s))`, { issues });
}
