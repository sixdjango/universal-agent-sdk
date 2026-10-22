import { describe, expect, it } from 'vitest';
import { deepSeekCostUSD, HarnessUsageTracker } from './usage.js';

describe('DeepSeek request accounting', () => {
  const time = Date.parse('2026-09-14T01:00:00Z');
  it('sums steps and turns, deduplicates durable events, and retains models', () => {
    const tracker = new HarnessUsageTracker(true);
    tracker.setRoute('deepseek-official', 'deepseek-v4-flash');
    const raw = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, reasoningTokens: 20 };
    const first = tracker.record('s', 1, time, raw);
    expect(first?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 30,
      reasoningOutputTokens: 20,
    });
    expect(tracker.record('s', 1, time, raw)).toBeUndefined();
    const second = tracker.record('s', 2, time, raw);
    expect(second?.modelUsage?.['deepseek-v4-flash'].inputTokens).toBe(200);
    expect(second?.delta?.usage.inputTokens).toBe(100);
    tracker.setRoute('deepseek-official', 'deepseek-v4-pro');
    expect(tracker.record('s', 1, time, raw)).toBeUndefined();
    const next = tracker.record('s', 3, time, raw);
    expect(Object.keys(next?.modelUsage ?? {})).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(next?.modelUsage?.['deepseek-v4-flash'].costUSD).toBeCloseTo(
      (2 * (100 * 0.3 + 30 * 0.006 + 50 * 1.2)) / 1e6,
      12
    );
  });
  it('prices UTC peak boundaries and weekends at request time', () => {
    const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadInputTokens: 1e6 };
    for (const [timestamp, multiplier] of [
      ['2026-09-14T00:59:59Z', 1],
      ['2026-09-14T01:00:00Z', 2],
      ['2026-09-14T04:00:00Z', 1],
      ['2026-09-14T06:00:00Z', 2],
      ['2026-09-14T10:00:00Z', 1],
      ['2026-09-13T02:00:00Z', 1],
    ] as const) {
      expect(deepSeekCostUSD('deepseek-v4-pro', usage, Date.parse(timestamp))).toBeCloseTo(
        (0.66 + 0.022 + 1.98) * multiplier
      );
    }
    expect(deepSeekCostUSD('unknown', usage, time)).toBeUndefined();
    for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(deepSeekCostUSD(model, usage, time)).toBeCloseTo((0.15 + 0.003 + 0.6) * 2);
    }
  });
  it('keeps custom endpoint and missing timestamp costs unknown', () => {
    for (const [official, timestamp] of [
      [false, time],
      [true, NaN],
    ] as const) {
      const tracker = new HarnessUsageTracker(official);
      tracker.setRoute('deepseek-official', 'deepseek-v4-pro');
      expect(
        tracker.record('s', 1, timestamp, { inputTokens: 100, outputTokens: 20 })?.usage.costUSD
      ).toBeUndefined();
    }
  });

  it('does not reprice older requests when the next step crosses into off-peak', () => {
    const tracker = new HarnessUsageTracker(true);
    tracker.setRoute('deepseek-official', 'deepseek-flash');
    const usage = { inputTokens: 1e6, outputTokens: 0 };
    tracker.record('s', 1, Date.parse('2026-09-14T03:59:59Z'), usage);
    const next = tracker.record('s', 2, Date.parse('2026-09-14T04:00:00Z'), usage);
    expect(next?.modelUsage?.['deepseek-flash'].costUSD).toBeCloseTo(0.45);
    expect(next?.delta?.usage.costUSD).toBeCloseTo(0.15);
  });
});
