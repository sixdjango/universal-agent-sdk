import { describe, expect, it } from "vitest";
import { PiStderrDiagnostics } from "../src/diagnostics.js";

describe("Pi stderr diagnostics", () => {
  it("keeps only whitelisted load-failure diagnostics", () => {
    const diagnostics = new PiStderrDiagnostics();
    diagnostics.append(
      [
        "Loading provider settings",
        'Error: Failed to load extension "/tmp/todo.ts": Tool "todo" conflicts with "/tmp/pi.js"',
        "Hint: remove one of the conflicting extensions",
        "Hint: your API token is super-secret",
        'Unknown provider "secret-provider"',
        "token=super-secret",
      ].join("\n"),
    );
    const decorated = diagnostics.decorateError(
      new Error("Pi RPC connection closed"),
    );
    expect(decorated.message).toContain(
      'Failed to load extension "/tmp/todo.ts"',
    );
    expect(decorated.message).toContain(
      'Tool "todo" conflicts with "/tmp/pi.js"',
    );
    expect(decorated.message).toContain(
      "Hint: remove one of the conflicting extensions",
    );
    expect(decorated.message).not.toContain(
      'Unknown provider "secret-provider"',
    );
    expect(decorated.message).not.toContain("Hint: your API token");
    expect(decorated.message).not.toContain("Loading provider settings");
    expect(decorated.message).not.toContain("super-secret");
  });

  it("bounds retained diagnostics and keeps the newest lines", () => {
    const diagnostics = new PiStderrDiagnostics();
    for (let index = 0; index < 20; index++)
      diagnostics.append(`noise ${index}\nFailed to load extension ${index}\n`);
    const decorated = diagnostics.decorateError(
      new Error("Pi RPC connection closed"),
    );
    expect(decorated.message).toContain("Failed to load extension 19");
    expect(decorated.message).not.toContain("Failed to load extension 11");
  });

  it("reassembles diagnostics split across stream chunks", () => {
    const diagnostics = new PiStderrDiagnostics();
    diagnostics.append("Error: Failed to load ext");
    diagnostics.append(
      'ension "/tmp/todo.ts": Tool "todo" conflicts with pkg\n',
    );
    const decorated = diagnostics.decorateError(
      new Error("Pi RPC connection closed"),
    );
    expect(decorated.message).toContain(
      'Error: Failed to load extension "/tmp/todo.ts": Tool "todo" conflicts with pkg',
    );
  });

  it("discards diagnostics after successful startup", () => {
    const diagnostics = new PiStderrDiagnostics();
    diagnostics.append('Error: Failed to load extension "/tmp/todo.ts"\n');
    diagnostics.stop();
    diagnostics.append("Hint: run without extensions\n");
    const decorated = diagnostics.decorateError(
      new Error("Pi RPC connection closed"),
    );
    expect(decorated.message).toBe("Pi RPC connection closed");
  });

  it("does not change errors while the connection is closing", () => {
    let closing = false;
    const diagnostics = new PiStderrDiagnostics(() => !closing);
    diagnostics.append('Error: Failed to load extension "/tmp/todo.ts"\n');
    closing = true;
    const decorated = diagnostics.decorateError(
      new Error("Pi connection closed"),
    );
    expect(decorated.message).toBe("Pi connection closed");
  });
});
