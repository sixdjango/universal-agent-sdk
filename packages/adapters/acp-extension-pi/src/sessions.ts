import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { createInterface } from "node:readline";
import type * as acp from "@agentclientprotocol/sdk";

/** Inspect identity without opening a native manager (which can migrate files). */
export async function validateNativeSessionPath(
  sessionId: string,
): Promise<{ cwd: string }> {
  if (!isAbsolute(sessionId))
    throw new Error(
      "Pi sessionId must be an absolute native session file path",
    );
  if (!(await stat(sessionId)).isFile())
    throw new Error("Pi sessionId must identify a native session file");
  const input = createReadStream(sessionId, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const header = JSON.parse(line);
      if (
        header?.type !== "session" ||
        typeof header.id !== "string" ||
        !header.id ||
        typeof header.timestamp !== "string" ||
        !Number.isFinite(Date.parse(header.timestamp)) ||
        typeof header.cwd !== "string" ||
        !isAbsolute(header.cwd) ||
        (header.version !== undefined &&
          (!Number.isInteger(header.version) ||
            header.version < 1 ||
            header.version > 3))
      )
        throw new Error("Invalid native Pi session header");
      return { cwd: header.cwd };
    }
    throw new Error("Missing native Pi session header");
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Resume keeps the native primary workspace; extra roots are activation config. */
export async function validateSessionCwd(
  sessionId: string,
  cwd: string,
): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error("Pi cwd must be absolute");
  const header = await validateNativeSessionPath(sessionId);
  const canonical = (value: string) =>
    realpath(value).catch(() => normalize(value));
  const [requested, stored] = await Promise.all([
    canonical(cwd),
    canonical(header.cwd),
  ]);
  if (requested !== stored)
    throw new Error("Pi session cwd does not match the requested cwd");
}

/** Native fork creates a new identity and preserves history without touching the source runtime. */
export async function forkPiSession(
  sourcePath: string,
  targetCwd: string,
): Promise<string> {
  if (!isAbsolute(targetCwd)) throw new Error("Pi cwd must be absolute");
  await validateNativeSessionPath(sourcePath);
  const cwd = await realpath(targetCwd);
  if (!(await stat(cwd)).isDirectory())
    throw new Error("Pi cwd must be a directory");
  const { SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const sessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ||
    SettingsManager.create(cwd).getSessionDir();
  const child = SessionManager.forkFrom(sourcePath, cwd, sessionDir);
  const sessionFile = child.getSessionFile();
  if (!sessionFile)
    throw new Error("Native Pi fork did not create a session file");
  return sessionFile;
}

/** Lists Pi's native session files without starting Pi. */
export async function listPiSessions(
  request: acp.ListSessionsRequest,
): Promise<acp.ListSessionsResponse> {
  const { SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const cwd = request.cwd ?? process.cwd();
  // Same precedence as the Pi CLI started by this adapter (it passes no --session-dir).
  const sessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ||
    SettingsManager.create(cwd).getSessionDir();
  // Pi records process.cwd(): symlink-resolved on POSIX, as spawned on Windows.
  const candidates = new Set([cwd, await realpath(cwd).catch(() => cwd)]);
  const sessions = request.cwd
    ? (
        await Promise.all(
          [...candidates].map((candidate) =>
            SessionManager.list(candidate, sessionDir),
          ),
        )
      ).flat()
    : await SessionManager.listAll(sessionDir);
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  return {
    sessions: [...byPath.values()].map((session) => ({
      sessionId: session.path,
      cwd: session.cwd || cwd,
      title: session.name || session.firstMessage || null,
      updatedAt: session.modified.toISOString(),
    })),
  };
}
