import { describe, expect, it } from "vitest";

import {
  clientSupportsLodyElicitation,
  foldElicitationResponse,
  rewriteElicitationParams,
} from "../src/elicitation.js";
import { DevinAcpProxy, type JsonRpcMessage } from "../src/proxy.js";

const ALLOW_OTHER = "cognition.ai/allowOther";

function caps(elicitation: unknown): Record<string, unknown> {
  return {
    clientCapabilities: {
      _meta: { lody: { elicitation } },
    },
  };
}

function devinElicitationParams(): Record<string, unknown> {
  return {
    mode: "form",
    sessionId: "sess-1",
    message: "What is your favorite color?",
    requestedSchema: {
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: "Favorite color",
          description: "What is your favorite color?",
          oneOf: [
            { const: "red", title: "Red" },
            { const: "green", title: "Green" },
          ],
        },
        q1: {
          type: "array",
          title: "Work days",
          description: "Which days do you work?",
          minItems: 1,
          items: {
            anyOf: [
              { const: "mon", title: "Monday" },
              { const: "tue", title: "Tuesday" },
            ],
          },
        },
      },
      required: ["q0", "q1"],
    },
    _meta: { [ALLOW_OTHER]: true },
  };
}

describe("clientSupportsLodyElicitation", () => {
  it("detects the Core capability", () => {
    expect(
      clientSupportsLodyElicitation({
        _meta: { lody: { elicitation: { version: 1 } } },
      }),
    ).toBe(true);
  });

  it.each([
    [{}, "no _meta"],
    [{ _meta: {} }, "no lody"],
    [{ _meta: { lody: {} } }, "no elicitation"],
    [{ _meta: { lody: { elicitation: { version: 2 } } } }, "wrong version"],
    [{ _meta: { lody: { elicitation: true } } }, "boolean capability"],
    [undefined, "missing capabilities"],
  ])("returns false for %s", (capabilities) => {
    expect(clientSupportsLodyElicitation(capabilities)).toBe(false);
  });
});

describe("rewriteElicitationParams", () => {
  it("returns undefined without the private allowOther flag", () => {
    const params = devinElicitationParams();
    params["_meta"] = {};
    expect(rewriteElicitationParams(params)).toBeUndefined();
  });

  it("returns undefined when allowOther is not true", () => {
    const params = devinElicitationParams();
    params["_meta"] = { [ALLOW_OTHER]: false };
    expect(rewriteElicitationParams(params)).toBeUndefined();

    params["_meta"] = { [ALLOW_OTHER]: "true" };
    expect(rewriteElicitationParams(params)).toBeUndefined();
  });

  it("injects custom-answer companion fields and Core question metadata", () => {
    const params = devinElicitationParams();
    const rewrite = rewriteElicitationParams(params);
    expect(rewrite).toBeDefined();

    const schema = rewrite!.params["requestedSchema"] as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual([
      "q0",
      "q0__other",
      "q1",
      "q1__other",
    ]);
    expect(schema.properties["q0__other"]).toEqual({
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above.",
      _meta: {
        lody: {
          elicitation: {
            version: 1,
            customAnswerFor: "q0",
            secret: false,
          },
        },
      },
    });
    expect(schema.properties["q1__other"]).toEqual({
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing options above.",
      _meta: {
        lody: {
          elicitation: {
            version: 1,
            customAnswerFor: "q1",
            secret: false,
          },
        },
      },
    });

    const meta = rewrite!.params["_meta"] as Record<string, unknown>;
    expect(meta[ALLOW_OTHER]).toBe(true);
    const lody = meta["lody"] as Record<string, unknown>;
    const elicitation = lody["elicitation"] as {
      version: number;
      questions: unknown[];
    };
    expect(elicitation.version).toBe(1);
    expect(elicitation.questions).toEqual([
      {
        id: "q0",
        question: "What is your favorite color?",
        header: "Favorite color",
        options: [
          { label: "red", description: "Red" },
          { label: "green", description: "Green" },
        ],
        multiSelect: false,
        allowCustomAnswer: true,
      },
      {
        id: "q1",
        question: "Which days do you work?",
        header: "Work days",
        options: [
          { label: "mon", description: "Monday" },
          { label: "tue", description: "Tuesday" },
        ],
        multiSelect: true,
        allowCustomAnswer: true,
      },
    ]);

    expect([...rewrite!.customFields.entries()]).toEqual([
      ["q0__other", { target: "q0", multiSelect: false }],
      ["q1__other", { target: "q1", multiSelect: true }],
    ]);
  });

  it("avoids companion key collisions with existing properties", () => {
    const params = devinElicitationParams();
    const schema = params["requestedSchema"] as {
      properties: Record<string, unknown>;
    };
    schema.properties["q0__other"] = { type: "string" };

    const rewrite = rewriteElicitationParams(params);
    expect(rewrite).toBeDefined();
    expect(rewrite!.customFields.has("q0__other_2")).toBe(true);
    expect(rewrite!.customFields.get("q0__other_2")?.target).toBe("q0");
  });

  it("handles a schema without properties", () => {
    const params = devinElicitationParams();
    params["requestedSchema"] = { type: "object" };
    const rewrite = rewriteElicitationParams(params);
    expect(rewrite).toBeDefined();
    const lody = (rewrite!.params["_meta"] as Record<string, unknown>)[
      "lody"
    ] as { elicitation: { questions: unknown[] } };
    expect(lody.elicitation.questions).toEqual([]);
    expect(rewrite!.customFields.size).toBe(0);
  });

  it("merges with existing _meta.lody content", () => {
    const params = devinElicitationParams();
    params["_meta"] = {
      [ALLOW_OTHER]: true,
      lody: { elicitation: { extra: "kept" }, other: 1 },
    };
    const rewrite = rewriteElicitationParams(params);
    expect(rewrite).toBeDefined();
    const meta = rewrite!.params["_meta"] as Record<string, unknown>;
    expect(meta[ALLOW_OTHER]).toBe(true);
    const lody = meta["lody"] as Record<string, unknown>;
    expect(lody["other"]).toBe(1);
    expect((lody["elicitation"] as Record<string, unknown>)["extra"]).toBe(
      "kept",
    );
    expect((lody["elicitation"] as Record<string, unknown>)["version"]).toBe(1);
  });
});

describe("foldElicitationResponse", () => {
  const fields = new Map([
    ["q0__other", { target: "q0", multiSelect: false }],
    ["q1__other", { target: "q1", multiSelect: true }],
  ]);

  it("writes a single-select custom answer into its question field", () => {
    const result = {
      action: "accept",
      content: { q0__other: "chartreuse" },
    };
    expect(foldElicitationResponse(result, fields)).toEqual({
      action: "accept",
      content: { q0: "chartreuse" },
    });
  });

  it("wraps a multi-select custom answer back into an array", () => {
    const result = {
      action: "accept",
      content: { q1: ["mon"], q1__other: "sunday" },
    };
    expect(foldElicitationResponse(result, fields)).toEqual({
      action: "accept",
      content: { q1: ["sunday"] },
    });
  });

  it("removes an empty companion and keeps the chosen option", () => {
    const result = {
      action: "accept",
      content: { q0: "red", q0__other: "  " },
    };
    expect(foldElicitationResponse(result, fields)).toEqual({
      action: "accept",
      content: { q0: "red" },
    });
  });

  it("returns undefined when nothing needs folding", () => {
    expect(
      foldElicitationResponse(
        { action: "accept", content: { q0: "red" } },
        fields,
      ),
    ).toBeUndefined();
    expect(
      foldElicitationResponse({ action: "cancel" }, fields),
    ).toBeUndefined();
    expect(
      foldElicitationResponse({ action: "accept" }, fields),
    ).toBeUndefined();
    expect(foldElicitationResponse("nope", fields)).toBeUndefined();
    expect(
      foldElicitationResponse({ action: "accept", content: {} }, new Map()),
    ).toBeUndefined();
  });
});

describe("DevinAcpProxy elicitation translation", () => {
  function initialize(proxy: DevinAcpProxy, capabilities: unknown) {
    proxy.handleClient({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: capabilities,
    });
    proxy.handleRuntime({
      jsonrpc: "2.0",
      id: 0,
      result: { agentCapabilities: {} },
    });
  }

  function createRequest(): JsonRpcMessage {
    return {
      jsonrpc: "2.0",
      id: 7,
      method: "elicitation/create",
      params: devinElicitationParams(),
    };
  }

  it("rewrites elicitation/create when the client advertised lody elicitation", () => {
    const proxy = new DevinAcpProxy();
    initialize(proxy, caps({ version: 1 }));
    const out = proxy.handleRuntime(createRequest());
    const params = (out.toClient[0] as { params: Record<string, unknown> })
      .params;
    const schema = params["requestedSchema"] as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties["q0__other"]).toBeDefined();
    const meta = params["_meta"] as Record<string, unknown>;
    expect(
      (meta["lody"] as Record<string, unknown>)["elicitation"],
    ).toBeDefined();
  });

  it("passes elicitation/create verbatim without the client capability", () => {
    const proxy = new DevinAcpProxy();
    initialize(proxy, { clientCapabilities: {} });
    const out = proxy.handleRuntime(createRequest());
    const params = (out.toClient[0] as { params: Record<string, unknown> })
      .params;
    const schema = params["requestedSchema"] as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties["q0__other"]).toBeUndefined();
    const meta = params["_meta"] as Record<string, unknown>;
    expect(meta["lody"]).toBeUndefined();
  });

  it("folds the client response back onto Devin's field keys", () => {
    const proxy = new DevinAcpProxy();
    initialize(proxy, caps({ version: 1 }));
    proxy.handleRuntime(createRequest());

    const out = proxy.handleClient({
      jsonrpc: "2.0",
      id: 7,
      result: { action: "accept", content: { q0__other: "purple" } },
    });
    expect(out.toRuntime[0]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { action: "accept", content: { q0: "purple" } },
    });
    expect(out.toClient).toEqual([]);
  });

  it("forwards non-translated elicitation responses verbatim", () => {
    const proxy = new DevinAcpProxy();
    initialize(proxy, caps({ version: 1 }));

    const response = {
      jsonrpc: "2.0" as const,
      id: 9,
      result: { action: "accept", content: { answer: "x" } },
    };
    const out = proxy.handleClient(response);
    expect(out.toRuntime[0]).toEqual(response);
  });
});
