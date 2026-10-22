import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { validateWorkspace, workspaceContext } from "../src/workspace.js";

describe("activation workspace context", () => {
  it("requires absolute cwd and every root, without coercion", () => {
    for (const input of [
      { cwd: "relative" },
      { cwd: resolve("."), additionalDirectories: ["relative"] },
      { cwd: resolve("."), additionalDirectories: null },
      { cwd: resolve("."), additionalDirectories: [1] },
      { cwd: resolve(".") + "\0" },
    ])
      expect(() => validateWorkspace(input)).toThrow();
  });
  it("normalizes and deduplicates in order, with omission equivalent to empty", () => {
    const cwd = resolve(".");
    const a = resolve("A");
    const b = resolve("B");
    expect(
      validateWorkspace({ cwd, additionalDirectories: [a, b, a] }),
    ).toEqual({ cwd, additionalDirectories: [a, b] });
    expect(validateWorkspace({ cwd })).toEqual(
      validateWorkspace({ cwd, additionalDirectories: [] }),
    );
  });
  it("encodes unusual directory names as data and states native tool semantics", () => {
    const workspace = {
      cwd: resolve("."),
      additionalDirectories: [resolve('quote"\nroot')],
    };
    const context = workspaceContext(workspace);
    expect(JSON.parse(context.split("\n")[1])).toEqual(workspace);
    expect(context).toContain("base for relative paths");
    expect(context).toContain("not a sandbox");
  });
});
