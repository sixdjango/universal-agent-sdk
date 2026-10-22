import {
  SessionUsageAccumulator,
  type ModelUsage,
  type SessionUsageUpdate,
} from "acp-extension-core";

import { privateWireContract as contract } from "./manifest.js";

type Update = Record<string, unknown>;

/** ACP `model` config option carrying the active model id. */
const MODEL_OPTION_ID = "model";
/** modelUsage key until a model option arrives; also the honest label for
 * usage the wire cannot attribute to a model. */
const FALLBACK_MODEL_ID = "devin";
/** Sidekick usage is session spend, but the wire gives no sidekick model id —
 * it is bucketed under this agent key rather than misattributed to the lead. */
const SIDEKICK_MODEL_ID = "sidekick";
const MAX_RECENT_SIGNATURES = 8;

/** Private cost/dimension fields re-published verbatim under the same
 * cognition.ai keys; the wire does not specify their units, so they never
 * become Core costUSD (unknown cost is omitted, never zeroed). */
const PASSTHROUGH_META = [
  contract.usageTotalCreditCostMeta,
  contract.usageTotalAcuCostMeta,
  contract.usageResponseDimensionsMeta,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function agentContext(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const ctx = meta?.[contract.subagentContextMeta];
  if (!isRecord(ctx)) return undefined;
  const id = ctx["parentAgentId"];
  return typeof id === "string" ? id : undefined;
}

/**
 * Per-session Devin usage accounting. Devin emits one `usage_update` per
 * inference request — already a delta, not a snapshot — as an untagged row
 * plus a `cognition.ai/subagent_context`-tagged twin naming the owning agent.
 * Rows tagged to a run_subagent child have their own billing identity and are
 * excluded here (the subagent stream reports them as run progress). Rows for
 * the root agent and the in-session sidekick count once, deduplicated by
 * counter signature, and accumulate under the session's active model.
 */
export class DevinSessionUsage {
  /** One accumulator per ACP session: each session is its own accounting
   * lifetime, so each keeps a never-reused usageScopeId. Created lazily so
   * sessions without countable usage never consume an injected id. */
  private accumulator?: SessionUsageAccumulator;
  private modelId = FALLBACK_MODEL_ID;
  private operation = 0;
  private readonly signatures = new Set<string>();
  private readonly signatureOrder: string[] = [];
  private readonly newId: () => string;

  constructor(
    readonly sessionId: string,
    newId: () => string = crypto.randomUUID.bind(crypto),
  ) {
    this.newId = newId;
  }

  /** Track the ACP `model` config option from session responses and
   * config_option_update notifications; usage rows accumulate under it. */
  observeConfigOptions(options: unknown): void {
    if (!Array.isArray(options)) return;
    for (const option of options) {
      if (!isRecord(option) || option["id"] !== MODEL_OPTION_ID) continue;
      const value = option["currentValue"];
      if (typeof value === "string" && value.length > 0) this.modelId = value;
    }
  }

  /**
   * Translate one runtime `usage_update` into a Core SessionUsageUpdate, or
   * return undefined when the row must not enter this session's accounting:
   * child-run usage, a duplicate report of an already-counted request, or a
   * row without the private token counters needed for disjoint buckets.
   */
  record(update: Update): SessionUsageUpdate | undefined {
    const meta = isRecord(update["_meta"]) ? update["_meta"] : undefined;
    const ctx = agentContext(meta);
    if (
      ctx !== undefined &&
      ctx !== contract.rootAgentId &&
      ctx !== contract.sidekickAgentId
    ) {
      return undefined;
    }
    const input = num(meta?.[contract.usageInputTokensMeta]);
    const output = num(meta?.[contract.usageOutputTokensMeta]);
    if (input === undefined || output === undefined) return undefined;
    const cachedRead = num(meta?.[contract.usageCachedReadTokensMeta]) ?? 0;
    const cachedWrite = num(meta?.[contract.usageCachedWriteTokensMeta]);

    // Devin's usage_update is one report per inference request and the
    // context-tagged twin repeats the same counters; either twin counts once.
    const signature = JSON.stringify([
      input,
      output,
      cachedRead,
      cachedWrite ?? 0,
      num(update["used"]) ?? null,
    ]);
    if (this.signatures.has(signature)) return undefined;
    this.signatures.add(signature);
    this.signatureOrder.push(signature);
    if (this.signatureOrder.length > MAX_RECENT_SIGNATURES) {
      this.signatures.delete(this.signatureOrder.shift() as string);
    }

    const row: ModelUsage = {
      // Devin's inputTokens includes cache reads AND cache writes (verified on
      // gpt-6-luna: input = fresh + cachedRead + cachedWrite); Core buckets
      // are disjoint, so subtract both. SWE-2 rows omit cachedWriteTokens.
      inputTokens: Math.max(0, input - cachedRead - (cachedWrite ?? 0)),
      outputTokens: output,
      cacheReadInputTokens: cachedRead,
    };
    if (cachedWrite !== undefined) row.cacheCreationInputTokens = cachedWrite;

    const modelId =
      ctx === contract.sidekickAgentId ? SIDEKICK_MODEL_ID : this.modelId;
    this.accumulator ??= new SessionUsageAccumulator(this.newId());
    const result = this.accumulator.update(
      this.sessionId,
      `devin-request-${++this.operation}`,
      { [modelId]: row },
    );
    if (result === undefined) return undefined;

    const size = num(update["size"]);
    if (size !== undefined) result.usage.contextWindow = size;
    if (meta !== undefined) {
      const passthrough: Record<string, unknown> = {};
      for (const key of PASSTHROUGH_META) {
        if (meta[key] !== undefined) passthrough[key] = meta[key];
      }
      if (Object.keys(passthrough).length > 0) {
        result._meta = { ...result._meta, ...passthrough };
      }
    }
    return result;
  }
}
