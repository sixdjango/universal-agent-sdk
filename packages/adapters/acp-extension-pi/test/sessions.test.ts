import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  forkPiSession,
  validateSessionCwd,
  listPiSessions,
} from "../src/sessions.js";

const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
let directory: string | undefined;
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function session(name: string, cwd: string, lines: object[]) {
  const file = join(directory!, name);
  writeFileSync(
    file,
    [
      {
        type: "session",
        version: 3,
        id: name,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      },
      ...lines,
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return file;
}
const user = (id: string, content: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "user", content, timestamp: 1 },
});

describe("native Pi session listing", () => {
  it("lists the configured directory's sessions for one resolved cwd by native file path", async () => {
    directory = realpathSync.native(
      mkdtempSync(join(tmpdir(), "lody-pi-sessions-")),
    );
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
    const work = join(directory, "work");
    mkdirSync(work);
    symlinkSync(work, join(directory, "link"));
    const first = session("first.jsonl", work, [user("u1", "fix the build")]);
    const named = session("named.jsonl", work, [
      user("u1", "hello"),
      {
        type: "session_info",
        id: "i1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:02.000Z",
        name: "Release prep",
      },
    ]);
    session("other.jsonl", directory, [user("u1", "unrelated")]);

    const { sessions } = await listPiSessions({
      cwd: join(directory, "link"),
    });

    expect(
      sessions
        .map(({ sessionId, cwd, title }) => ({ sessionId, cwd, title }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    ).toEqual([
      { sessionId: first, cwd: work, title: "fix the build" },
      { sessionId: named, cwd: work, title: "Release prep" },
    ]);
    expect(
      sessions.every((item) => !Number.isNaN(Date.parse(item.updatedAt!))),
    ).toBe(true);
  });
});

describe("native Pi session identity and fork", () => {
  function fixture() {
    directory = realpathSync.native(
      mkdtempSync(join(tmpdir(), "lody-pi-fork-")),
    );
    const cwd = join(directory, "source");
    const target = join(directory, "target");
    mkdirSync(cwd);
    mkdirSync(target);
    process.env.PI_CODING_AGENT_SESSION_DIR = join(directory, "sessions");
    const manager = SessionManager.create(
      cwd,
      process.env.PI_CODING_AGENT_SESSION_DIR,
    );
    manager.appendMessage({
      role: "user",
      content: "synthetic history",
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "synthetic response" }],
      api: "openai-completions",
      provider: "synthetic",
      model: "local",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    manager.appendCustomEntry("synthetic", { state: "preserved" });
    return { cwd, target, manager, file: manager.getSessionFile()! };
  }

  it("validates cwd read-only, accepting a symlink to the same workspace", async () => {
    const { cwd, target, file } = fixture();
    const before = readFileSync(file);
    const alias = join(directory!, "alias");
    symlinkSync(cwd, alias);
    await expect(validateSessionCwd(file, alias)).resolves.toBeUndefined();
    await expect(validateSessionCwd(file, target)).rejects.toThrow(
      "does not match",
    );
    await expect(validateSessionCwd(file, "relative")).rejects.toThrow(
      "absolute",
    );
    await expect(validateSessionCwd("relative.jsonl", cwd)).rejects.toThrow(
      "absolute",
    );
    await expect(
      validateSessionCwd(join(directory!, "missing.jsonl"), cwd),
    ).rejects.toThrow();
    expect(readFileSync(file)).toEqual(before);
  });

  it("forks complete native history to a new cwd and independent identity without changing source", async () => {
    const { cwd, target, file, manager } = fixture();
    const before = readFileSync(file);
    const childPath = await forkPiSession(file, target);
    expect(childPath).not.toBe(file);
    expect(childPath.startsWith(process.env.PI_CODING_AGENT_SESSION_DIR!)).toBe(
      true,
    );
    const child = SessionManager.open(childPath);
    expect(child.getSessionId()).not.toBe(manager.getSessionId());
    expect(child.getHeader()).toMatchObject({
      cwd: target,
      parentSession: file,
    });
    expect(child.getEntries()).toEqual(manager.getEntries());
    child.appendMessage({ role: "user", content: "child only", timestamp: 3 });
    expect(readFileSync(file)).toEqual(before);
    await expect(validateSessionCwd(file, cwd)).resolves.toBeUndefined();
    await expect(
      validateSessionCwd(childPath, target),
    ).resolves.toBeUndefined();
    await expect(validateSessionCwd(childPath, cwd)).rejects.toThrow(
      "does not match",
    );
  });

  it("rejects invalid paths and headers before creating a fork", async () => {
    const { target } = fixture();
    const invalid = join(directory!, "invalid.jsonl");
    writeFileSync(
      invalid,
      JSON.stringify({ type: "message", id: "invalid" }) + "\n",
    );
    await expect(forkPiSession(invalid, target)).rejects.toThrow("header");
    await expect(forkPiSession("relative.jsonl", target)).rejects.toThrow(
      "absolute",
    );
    await expect(forkPiSession(invalid, "relative")).rejects.toThrow(
      "absolute",
    );
    await expect(forkPiSession(target, target)).rejects.toThrow("file");
  });

  it("uses target project sessionDir settings when no environment override is set", async () => {
    const { target, file } = fixture();
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    const destination = join(directory!, "project-sessions");
    mkdirSync(join(target, ".pi"));
    writeFileSync(
      join(target, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: destination }),
    );
    const child = await forkPiSession(file, target);
    expect(child.startsWith(destination)).toBe(true);
  });
});
