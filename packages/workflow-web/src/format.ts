import { ApiError } from './api';

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = (err.details as { issues?: { message: string }[] } | undefined)?.issues;
    return issues?.length ? `${err.message}: ${issues.slice(0, 3).map((i) => i.message).join('; ')}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function timeAgo(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}
