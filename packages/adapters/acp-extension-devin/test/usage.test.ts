import { describe, expect, it } from "vitest";

import { DevinSessionUsage } from "../src/usage.js";

let counter = 0;
const newId = () => `scope-${++counter}`;

const usageUpdate = (
  meta: Record<string, unknown>,
  used = 100,
  size = 262000,
) => ({
  sessionUpdate: "usage_update",
  used,
  size,
  _meta: meta,
});

const modelOption = (value: string) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: value,
    options: [],
  },
];

describe("DevinSessionUsage", () => {
  // Real gpt-6-luna cold request: inputTokens includes the cache-write share,
  // so only the ~3-token fresh suffix stays in the input bucket.
  it("subtracts cache writes from input on cache-write-only rows", () => {
    const usage = new DevinSessionUsage("s1", newId);
    const result = usage.record(
      usageUpdate({
        "cognition.ai/inputTokens": 10884,
        "cognition.ai/outputTokens": 32,
        "cognition.ai/cachedWriteTokens": 10881,
      }),
    );
    expect(result?.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 32,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 10881,
    });
  });

  it("translates cognition token counters into disjoint Core buckets", () => {
    const usage = new DevinSessionUsage("s1", newId);
    const result = usage.record(
      usageUpdate({
        "cognition.ai/inputTokens": 11820,
        "cognition.ai/outputTokens": 19,
        "cognition.ai/cachedReadTokens": 11706,
      }),
    );
    expect(result).toMatchObject({
      sessionId: "s1",
      usage: {
        inputTokens: 114,
        outputTokens: 19,
        cacheReadInputTokens: 11706,
      },
      modelUsage: {
        devin: {
          inputTokens: 114,
          outputTokens: 19,
          cacheReadInputTokens: 11706,
        },
      },
      delta: {
        usage: {
          inputTokens: 114,
          outputTokens: 19,
          cacheReadInputTokens: 11706,
        },
        modelUsage: {
          devin: {
            inputTokens: 114,
            outputTokens: 19,
            cacheReadInputTokens: 11706,
          },
        },
      },
      _meta: { lody: { usageScopeId: result?._meta?.lody?.usageScopeId } },
    });
    expect(result?._meta?.lody?.usageScopeId.length).toBeGreaterThan(0);
  });

  it("deduplicates the context-tagged twin of a counted request", () => {
    const usage = new DevinSessionUsage("s1", newId);
    const untagged = usageUpdate({
      "cognition.ai/inputTokens": 100,
      "cognition.ai/outputTokens": 10,
    });
    const tagged = usageUpdate({
      "cognition.ai/inputTokens": 100,
      "cognition.ai/outputTokens": 10,
      "cognition.ai/subagent_context": { parentAgentId: "root" },
    });
    expect(usage.record(untagged)).toBeDefined();
    expect(usage.record(tagged)).toBeUndefined();
    const next = usage.record(
      usageUpdate({
        "cognition.ai/inputTokens": 120,
        "cognition.ai/outputTokens": 5,
      }),
    );
    expect(next?.modelUsage?.devin).toMatchObject({
      inputTokens: 220,
      outputTokens: 15,
      cacheReadInputTokens: 0,
    });
  });

  it("accumulates per model and keeps totals across a model switch", () => {
    const usage = new DevinSessionUsage("s1", newId);
    usage.observeConfigOptions(modelOption("swe-2-high"));
    usage.record(
      usageUpdate({
        "cognition.ai/inputTokens": 100,
        "cognition.ai/outputTokens": 10,
      }),
    );
    usage.observeConfigOptions(modelOption("claude-fable-5-1-medium"));
    const second = usage.record(
      usageUpdate({
        "cognition.ai/inputTokens": 50,
        "cognition.ai/outputTokens": 5,
        "cognition.ai/cachedReadTokens": 20,
        "cognition.ai/cachedWriteTokens": 7,
      }),
    );
    expect(second?.modelUsage).toMatchObject({
      "swe-2-high": {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 0,
      },
      // disjoint: 50 input − 20 cache-read − 7 cache-write
      "claude-fable-5-1-medium": {
        inputTokens: 23,
        outputTokens: 5,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 7,
      },
    });
    expect(second?.delta?.modelUsage).toMatchObject({
      "swe-2-high": {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
      },
      "claude-fable-5-1-medium": {
        inputTokens: 23,
        outputTokens: 5,
        cacheReadInputTokens: 20,
      },
    });
  });

  it("copies contextWindow onto the aggregate usage only", () => {
    const usage = new DevinSessionUsage("s1", newId);
    const result = usage.record(
      usageUpdate(
        {
          "cognition.ai/inputTokens": 10,
          "cognition.ai/outputTokens": 1,
        },
        11,
        262000,
      ),
    );
    expect(result?.usage.contextWindow).toBe(262000);
    expect(result?.usage.inputTokens).toBe(10);
    expect(result?.delta?.usage.contextWindow).toBeUndefined();
    expect(result?.modelUsage?.devin?.contextWindow).toBeUndefined();
  });

  it("passes private cost and dimension meta through verbatim", () => {
    const usage = new DevinSessionUsage("s1", newId);
    const dims = [
      { uid: "model", kind: { type: "metric", value: "SWE-2 High" } },
    ];
    const result = usage.record(
      usageUpdate({
        "cognition.ai/inputTokens": 10,
        "cognition.ai/outputTokens": 1,
        "cognition.ai/totalCreditCost": 0.4,
        "cognition.ai/totalAcuCost": 0.2,
        "cognition.ai/responseDimensions": dims,
      }),
    );
    expect(result?._meta).toMatchObject({
      "cognition.ai/totalCreditCost": 0.4,
      "cognition.ai/totalAcuCost": 0.2,
      "cognition.ai/responseDimensions": dims,
    });
    expect(result?.usage.costUSD).toBeUndefined();
  });

  it("skips rows without private token counters", () => {
    const usage = new DevinSessionUsage("s1", newId);
    expect(
      usage.record({ sessionUpdate: "usage_update", used: 5, size: 1 }),
    ).toBeUndefined();
  });

  it("excludes child-run usage from session accounting", () => {
    const usage = new DevinSessionUsage("s1", newId);
    expect(
      usage.record(
        usageUpdate({
          "cognition.ai/inputTokens": 50,
          "cognition.ai/outputTokens": 3,
          "cognition.ai/subagent_context": { parentAgentId: "agent-42" },
        }),
      ),
    ).toBeUndefined();
  });

  it("accounts sidekick usage under its own agent bucket", () => {
    const usage = new DevinSessionUsage("s1", newId);
    usage.observeConfigOptions(modelOption("claude-fable-5-1-medium"));
    const result = usage.record(
      usageUpdate({
        "cognition.ai/inputTokens": 30,
        "cognition.ai/outputTokens": 4,
        "cognition.ai/subagent_context": { parentAgentId: "sidekick" },
      }),
    );
    expect(result?.modelUsage).toMatchObject({
      sidekick: {
        inputTokens: 30,
        outputTokens: 4,
        cacheReadInputTokens: 0,
      },
    });
  });
});
