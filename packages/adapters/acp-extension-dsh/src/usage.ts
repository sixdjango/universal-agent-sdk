import { SessionUsageAccumulator, type ModelUsage } from 'acp-extension-core';

export type HarnessTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

// Official USD / million tokens, checked 2026-09-13:
// https://api-docs.deepseek.com/quick_start/pricing/
// [cache miss, cache hit, output], OFF-PEAK; weekday peak rates are twice these.
const prices: Record<string, readonly [number, number, number]> = {
  'deepseek-flash': [0.15, 0.003, 0.6],
  // Official aliases now served and billed as DeepSeek-V4.1-Flash.
  'deepseek-v4-flash': [0.15, 0.003, 0.6],
  'deepseek-v4-pro': [0.66, 0.022, 1.98],
  'deepseek-v4-flash-vision-exp': [0.15, 0.003, 0.6],
};

export function deepSeekCostUSD(
  model: string,
  usage: ModelUsage,
  epochMs: number
): number | undefined {
  const price = Object.hasOwn(prices, model) ? prices[model] : undefined;
  if (!price || !Number.isFinite(epochMs)) return undefined;
  const date = new Date(epochMs);
  const weekday = date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
  const hour = date.getUTCHours();
  const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  // This is a list-price estimate at request completion, not an invoice or a
  // reprice of the cumulative session using the clock at flush time.
  return (
    (((usage.inputTokens + (usage.cacheCreationInputTokens ?? 0)) * price[0] +
      usage.cacheReadInputTokens * price[1] +
      (usage.outputTokens + (usage.reasoningOutputTokens ?? 0)) * price[2]) *
      (peak ? 2 : 1)) /
    1_000_000
  );
}

export class HarnessUsageTracker {
  private accumulator = new SessionUsageAccumulator();
  private route?: { provider: string; model: string };
  private seen = new Set<number>();

  constructor(private readonly officialEndpoint: boolean) {}

  setRoute(provider: string, model: string) {
    this.route = { provider, model };
  }

  record(sessionId: string, seq: number, time: number, raw: HarnessTokenUsage) {
    if (!this.route || !Number.isSafeInteger(seq) || seq < 0) return undefined;
    if (this.seen.has(seq)) return undefined;
    if (
      [raw.inputTokens, raw.outputTokens, ...Object.values(raw)].some(
        (value) => !Number.isFinite(value) || value < 0
      )
    )
      return undefined;
    const usage: ModelUsage = {
      // Pinned dsh-llm-deepseek already subtracts cache hits from inputTokens.
      inputTokens: raw.inputTokens,
      outputTokens: Math.max(0, raw.outputTokens - (raw.reasoningTokens ?? 0)),
      cacheReadInputTokens: raw.cacheReadTokens ?? 0,
      cacheCreationInputTokens: raw.cacheWriteTokens ?? 0,
      reasoningOutputTokens: raw.reasoningTokens ?? 0,
    };
    if (this.officialEndpoint && this.route.provider === 'deepseek-official') {
      const costUSD = deepSeekCostUSD(this.route.model, usage, time);
      if (costUSD !== undefined) usage.costUSD = costUSD;
    }
    this.seen.add(seq);
    return this.accumulator.update(sessionId, String(seq), { [this.route.model]: usage });
  }
}
