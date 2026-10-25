# @universal-agent/client

A standalone ACP (Agent Client Protocol) host SDK for Node.js and Electron: launch Claude Code, Codex, DeepSeek, Kimi, Pi, Grok, Devin or any standard ACP agent, stream its work, answer its permission requests, and record every conversation.

```bash
npm install @universal-agent/client
```

Requires Node.js ≥ 22. The SDK never stores or refreshes credentials: it relies on each agent CLI's own login (see [Authentication](#authentication)).

## Quick start

```ts
import { startAgentSession } from '@universal-agent/client';

const session = await startAgentSession({
  target: { cliType: 'builtin', agentType: 'claude' }, // or 'codex', 'deepseek', 'kimi', 'pi', 'grok', 'devin'
  workdir: process.cwd(),
  initialConfig: { modelId: 'default' },
  onUpdateMessage: (notification) => {
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      process.stdout.write(update.content.text);
    }
  },
  onRequestPermission: async (_requestId, request) => {
    const allowOnce = request.options.find((opt) => opt.kind === 'allow_once');
    return { outcome: allowOnce ? { outcome: 'selected', optionId: allowOnce.optionId } : { outcome: 'cancelled' } };
  },
});

await session.prompt([{ type: 'text', text: 'Summarize the project structure.' }]);
console.log(session.getLatestAssistantItems());
await session.shutdown();
```

## Core capabilities

1. **Seven built-in agents plus any standard ACP agent.** Built-in deep adapters for `claude`, `codex`, `kimi`, `pi`, `deepseek`, `grok` and `devin` (bundled as `dist/*-acp.js`); `custom` spawns any local binary, `npx` or `uvx` command that speaks ACP over stdio; registry agents (e.g. `gemini`, `cursor`, `opencode`) are downloaded on demand.
2. **Binary resolution you can override.** Explicit `executablePath` → process `PATH` → cached login-shell `PATH` (3 s timeout) → common install directories (`~/.local/bin`, `~/bin`, `~/.claude/local`, `~/.kimi-code/bin`, `~/.grok/bin`).
3. **Production ACP extensions** (wire prefixes `_meta.ua` and `_meta.lody`): acknowledged mid-turn steering, subagent lifecycle and streaming, token / cost / context-window / rate-limit accounting, AskUserQuestion forms bridged into `onRequestPermission`, and ordered runtime configuration (`mode → model → dependent options`).
4. **Process and stream safety.** Detached POSIX process groups and Windows `taskkill /T` tree termination (SIGTERM → grace period → SIGKILL); Windows `cmd.exe` length limits avoided for DeepSeek Harness; loopback `NO_PROXY` injection so shell proxies never hijack local MCP connections.
5. **Conversations.** `ConversationService` adds a persistent FIFO chat queue, exclusive session ownership, permission waits, lossless message and tool records, host extensions and crash recovery on top of sessions. `ConversationRecorder` records externally scheduled calls (the workflow kit uses it for every agent step).

## Starting a session

`startAgentSession(options)` returns a `ManagedAgentSession`. The main options:

| Option | Purpose |
|---|---|
| `target` | `{ cliType: 'builtin' \| 'registry', agentType, executablePath?, extraArgs? }` or `{ cliType: 'custom', agentType, command, args? }` |
| `workdir` | Directory the agent works in (required) |
| `initialConfig` / `modelId`, `modeId`, `configOptionValues` | Model, mode and other config options to apply at start |
| `env`, `dataDir` | Extra environment (merged over the login-shell environment) and the SDK data directory (default `~/.universal-agent`) |
| `mcpServers` / `resolveMcpServers` | MCP servers to mount into the session |
| `resumeSessionId`, `forkSessionId`, `forkSessionTurnId` | Resume or fork an earlier session |
| `onUpdateMessage` | Every ACP session notification (message chunks, thoughts, tool calls, plans) |
| `onRequestPermission` | Answer tool permission requests (required) |
| `onHistoryChange`, `onUsageUpdate`, `onContextWindowUsageUpdate`, `onRateLimitUpdate` | History, usage and limits as they change |

`ManagedAgentSession` methods: `prompt(blocks, { signal, goalControl })`, `steer(blocks)` (inject into the running turn or refuse), `applyConfig({ modeId, modelId, configOptionValues })`, `cancel()`, `cancelSubagent(taskId)`, `controlGoal('pause' | 'clear')`, `getRateLimits()`, `getHistory()`, `getLatestAssistantTurn()`, `getLatestAssistantItems()`, `shutdown()`.

## Conversations

```ts
import { ConversationService } from '@universal-agent/client';

const chats = new ConversationService(); // in-memory store; inject a ConversationStore for durability
const conversation = await chats.create({ agent: { agentType: 'claude', workdir: '/path/to/project' } });
chats.subscribe(conversation.id, (event) => console.log(event.sequence, event.data.type));
const turn = await chats.send(conversation.id, { content: [{ type: 'text', text: 'Review this project.' }] });
const result = await chats.waitForTurn(conversation.id, turn.id);
console.log(result.status, await chats.getMessages(conversation.id, turn.id));
await chats.shutdown();
```

`send()` returns as soon as the input is stored; the turn runs in the background. Pending permissions are answered with `respondPermission()`. A durable SQLite assembly is `createNodeConversationService()` in `@universal-agent/workflow-node`. `@universal-agent/client/conversation` exports the message model (`projectConversationMessages`) for UIs. Details: [Conversations](../../docs/conversations.md).

## Authentication

The SDK forwards the host's `env` and relies on each CLI's local login:

| Agent (`agentType`) | Local CLI | Authentication | Launch |
| :--- | :--- | :--- | :--- |
| `claude` | `claude` | `claude login` or `ANTHROPIC_API_KEY` | `dist/claude-acp.js` with `CLAUDE_CODE_EXECUTABLE` |
| `codex` | `codex` | Codex login or `OPENAI_API_KEY` | `dist/codex-acp.js` with `CODEX_PATH` |
| `kimi` | `kimi` | Kimi Code login | `kimi acp` with `KIMI_CODE_NO_AUTO_UPDATE=1` (or `dist/kimi-acp.js`) |
| `pi` | `pi` (or bundled) | Provider credentials per `@earendil-works/pi-coding-agent` | `dist/pi-acp.js` with `UA_PI_PATH` |
| `deepseek` | `npx` | Provider credentials in `DSH_HOME` / `dataDir` | Isolated profile under `dataDir`, then `dist/deepseek-acp.js` |
| `grok` | `grok` | Grok CLI login or `XAI_API_KEY` | `dist/grok-acp.js` with `GROK_PATH`, `GROK_DISABLE_AUTOUPDATER=1` |
| `devin` | `devin` | Devin CLI login | `dist/devin-acp.js` with `DEVIN_PATH` |
| `custom` | your `command` | Managed by your host | `command` + `args` |

## Electron / ASAR

When bundling inside an Electron app with `.asar`, unpack `node_modules/@universal-agent/client/dist/**` (`asarUnpack`). `resolveBundledAdapterEntry()` rewrites `.asar/` to `.asar.unpacked/` when it spawns `dist/*-acp.js`.

## Related

- Orchestrating agents into workflows: [`@universal-agent/workflow-node`](../workflow-node) and the [workflow guide](../../docs/workflow-guide.md).
- ACP extension contracts: [`@universal-agent/acp-extension-core`](../acp-extension-core).

## License

MIT
