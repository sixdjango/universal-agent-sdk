import { z } from 'zod';

/**
 * Request bodies the HTTP API accepts. The server validates against these and the OpenAPI
 * document (`GET /api/openapi.json`) is generated from them, so the two cannot drift apart.
 */
export const JsonRecord = z.record(z.string(), z.unknown());
export const LayoutSchema = z.record(z.string(), z.object({ x: z.number(), y: z.number() }));
export const SaveWorkflowBody = z.object({ definition: z.unknown(), layout: LayoutSchema.optional() });
export const WorkspaceBindingsSchema = z.record(z.string(), z.string().min(1));
export const StartRunBody = z.object({
  workflowId: z.string().min(1),
  inputs: JsonRecord.default({}),
  /** Workspace id per slot; remembered as the workflow's defaults for the next run. */
  workspaces: WorkspaceBindingsSchema.default({}),
});
export const IsolationSchema = z.enum(['in-place', 'git-worktree']);
export const CreateWorkspaceBody = z.object({
  name: z.string().optional(),
  path: z.string().min(1),
  isolation: IsolationSchema.optional(),
});
export const UpdateWorkspaceBody = CreateWorkspaceBody.partial();
export const RespondBody = z.object({
  requestId: z.string().min(1),
  answer: z.union([z.string(), JsonRecord]),
  responderId: z.string().min(1).default('web'),
});
export const RerunBody = z.object({ nodeId: z.string().min(1), scopeKey: z.string().min(1).optional() });
export const ChiefMessageBody = z.object({ text: z.string().trim().min(1).max(8000), authorId: z.string().min(1).default('web') });
