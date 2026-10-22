import type { ModelUsage } from "acp-extension-core";
import { z } from "zod";

/** Pi `Usage` of one model response. Input and cache buckets are disjoint;
 * `reasoning` is a subset of `output`. */
export const piUsageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  reasoning: z.number().nonnegative().optional(),
  cost: z.object({ total: z.number().nonnegative() }).partial().optional(),
});

/** The accounting fields of a Pi assistant message; content is never needed. */
export const piAssistantUsageSchema = z.object({
  role: z.literal("assistant"),
  provider: z.string().min(1),
  model: z.string().min(1),
  responseId: z.string().min(1).optional(),
  timestamp: z.number(),
  usage: piUsageSchema,
});

export type PiAssistantUsage = z.infer<typeof piAssistantUsageSchema>;

/** Same `provider/id` spelling as the model config option. */
export const piModelKey = (provider: string, model: string) =>
  `${provider}/${model}`;

/** One response's own usage, keyed so a repeated report merges instead of adding. */
export const piResponseOperation = (message: PiAssistantUsage) =>
  message.responseId ??
  `${message.provider}/${message.model}@${message.timestamp}`;

export function toModelUsage(usage: z.infer<typeof piUsageSchema>): ModelUsage {
  const reasoning = usage.reasoning;
  return {
    inputTokens: usage.input,
    outputTokens: Math.max(0, usage.output - (reasoning ?? 0)),
    cacheReadInputTokens: usage.cacheRead,
    cacheCreationInputTokens: usage.cacheWrite,
    ...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
    ...(usage.cost?.total === undefined ? {} : { costUSD: usage.cost.total }),
  };
}
