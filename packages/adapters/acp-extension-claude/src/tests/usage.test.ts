import { describe, expect, it } from "vitest";
import {
  accountingDelta,
  getUsage,
  resultUsageIncrement,
  toAccountingModelUsage,
  type UsageApiDeps,
} from "../usage.js";

const resetAt = "2026-09-07T00:00:00Z";
const shared = {
  five_hour: { utilization: 12, resets_at: resetAt },
  seven_day: { utilization: 30, resets_at: resetAt },
};
const scoped = (name: string, percent: number, resets_at: string | null = resetAt) => ({
  kind: "weekly_scoped",
  group: "weekly",
  percent,
  resets_at,
  is_active: resets_at !== null,
  scope: { model: { id: null, display_name: name } },
});

const usage = (response: Awaited<ReturnType<UsageApiDeps["fetchApi"]>>) =>
  getUsage({
    homeDir: () => "/synthetic-unused-home",
    now: () => Date.parse("2026-09-05T00:00:00Z"),
    readKeychain: () => ({ accessToken: "synthetic-test-token", subscriptionType: "max" }),
    fetchApi: async () => response,
  });

describe("OAuth usage windows", () => {
  it("scopes one result's growth and treats a restarted reading as new work", () => {
    const row = (inputTokens: number, costUSD?: number) => ({
      inputTokens,
      outputTokens: 10,
      cacheReadInputTokens: 20,
      ...(costUSD === undefined ? {} : { costUSD }),
    });
    const previous = { main: row(100, 0.1), idle: row(5, 0) };
    const grown = resultUsageIncrement({ main: row(150, 0.3), idle: row(5, 0) }, previous);
    expect(Object.keys(grown?.modelUsage ?? {})).toEqual(["main"]);
    expect(grown?.modelUsage.main).toMatchObject({
      inputTokens: 50,
      outputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(grown?.usage.costUSD).toBeCloseTo(0.2);
    // Counters below the previous reading mean a new query() started from zero.
    expect(resultUsageIncrement({ main: row(20) }, previous)?.modelUsage.main.inputTokens).toBe(20);
    expect(resultUsageIncrement(previous, previous)).toBeUndefined();
  });
  it("differences query-wide model usage, keeping unknown cost and resets explicit", () => {
    const row = (inputTokens: number) => ({
      inputTokens,
      outputTokens: 10,
      cacheReadInputTokens: 20,
    });
    const previous = { main: row(100) };
    const next = { main: row(150), child: row(30) };
    expect(accountingDelta(next, previous)?.usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 10,
    });
    expect(accountingDelta(next, previous)?.usage.costUSD).toBeUndefined();
    expect(accountingDelta(next, next)?.usage.inputTokens).toBe(0);
    expect(accountingDelta({ main: row(20) }, previous)).toBeUndefined();
    expect(
      accountingDelta({ main: { ...row(150), costUSD: 1 } }, previous)?.usage.costUSD,
    ).toBeUndefined();
  });
  it("splits SDK thinking without double counting and omits guessed cost", () => {
    const raw = {
      inputTokens: 10,
      outputTokens: 100,
      thinkingTokens: 40,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 30,
      webSearchRequests: 2,
      costUSD: 0.5,
      contextWindow: 200000,
      maxOutputTokens: 1000,
    };
    expect(toAccountingModelUsage(raw)).toEqual({
      inputTokens: 10,
      outputTokens: 60,
      reasoningOutputTokens: 40,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 30,
      webSearchRequests: 2,
      costUSD: 0.5,
      contextWindow: 200000,
    });
    expect(toAccountingModelUsage({ ...raw, costBasis: "unknown" }).costUSD).toBeUndefined();
    const legacy = { ...raw, thinkingTokens: undefined };
    expect(toAccountingModelUsage(legacy).outputTokens).toBe(100);
    expect(toAccountingModelUsage(legacy).reasoningOutputTokens).toBeUndefined();
  });
  it("keeps Fable weekly usage beside the shared 5h and weekly constraints", async () => {
    const result = await usage({ ...shared, limits: [scoped("Fable", 67)] });
    expect(result).toEqual({
      fetchedAtEpochSeconds: Date.parse("2026-09-05T00:00:00Z") / 1000,
      rateLimits: [
        {
          limitId: "claude",
          scope: { providerId: "claude" },
          planName: "Max",
          windows: [
            {
              usedPercent: 12,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: Date.parse(resetAt) / 1000,
            },
            {
              usedPercent: 30,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: Date.parse(resetAt) / 1000,
            },
            {
              label: "Fable",
              usedPercent: 67,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: Date.parse(resetAt) / 1000,
            },
          ],
        },
      ],
    });
  });

  it("preserves distinct zero-use scoped windows with no reset", async () => {
    const result = await usage({
      seven_day: { utilization: 0 },
      limits: [scoped("Fable", 0, null), scoped("Future Model", 0, null)],
    });
    expect(result?.rateLimits[0]?.windows).toEqual([
      { usedPercent: 0, windowDurationSeconds: 604_800, resetsAtEpochSeconds: null },
      {
        label: "Fable",
        usedPercent: 0,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: null,
      },
      {
        label: "Future Model",
        usedPercent: 0,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: null,
      },
    ]);
  });

  it.each([undefined, null, {}, []])("keeps legacy quotas when limits is %j", async (limits) => {
    const result = await usage({ ...shared, limits });
    expect(result?.rateLimits[0]?.windows).toHaveLength(2);
    expect(result?.rateLimits[0]?.windows.map((window) => window.usedPercent)).toEqual([12, 30]);
  });

  it("skips malformed and unrelated rows without hiding valid quotas", async () => {
    const result = await usage({
      ...shared,
      limits: [
        null,
        {},
        scoped("", 2),
        scoped("Bad", NaN),
        scoped("Bad", Infinity),
        { ...scoped("Spend", 10), kind: "spend" },
        { ...scoped("Bad", 10), percent: "10" },
        scoped(" Fable ", 120, "invalid-date"),
      ],
    });
    expect(result?.rateLimits[0]?.windows).toHaveLength(3);
    expect(result?.rateLimits[0]?.windows[2]).toEqual({
      label: "Fable",
      usedPercent: 100,
      windowDurationSeconds: 604_800,
      resetsAtEpochSeconds: null,
    });
  });

  it("omits a scoped quota when a later snapshot no longer reports it", async () => {
    await usage({ ...shared, limits: [scoped("Fable", 50)] });
    const next = await usage(shared);
    expect(next?.rateLimits[0]?.windows).toHaveLength(2);
  });
});
