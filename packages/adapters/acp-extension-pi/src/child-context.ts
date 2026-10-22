import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readWorkspace, workspaceContext } from "./workspace.js";

/** Context only: no parent tools, MCP clients, questions or subagent execution. */
export default function childContext(pi: ExtensionAPI): void {
  const workspace = readWorkspace();
  pi.on("before_agent_start", (event) => ({
    systemPrompt: [
      event.systemPrompt,
      "You are a subagent. Complete the delegated task. If information is missing, report it to the parent; do not ask the user. Do not start other agents.",
      workspaceContext(workspace),
    ].join("\n\n"),
  }));
}
