/** HTTP-only errors (bad request bodies, missing optional features). Service errors are `WorkflowHostError`s. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
