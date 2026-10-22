# Universal Agent Client SDK (`@universal-agent/*`)

A standalone, zero-business-coupled **ACP (Agent Client Protocol)** Client SDK and built-in adapter suite extracted from Lody. Designed for direct integration into any Node.js, Electron, or Daemon host application.

---

## Monorepo Architecture

```text
├── packages/
│   ├── acp-extension-core/               # @universal-agent/acp-extension-core (ACP extension contract & validators)
│   ├── adapters/
│   │   ├── acp-extension-claude/         # Claude Code ACP adapter
│   │   ├── acp-extension-codex/          # OpenAI Codex ACP adapter
│   │   ├── acp-extension-pi/             # Pi Coding Agent ACP adapter
│   │   ├── acp-extension-dsh/            # DeepSeek Harness (DSH) ACP adapter
│   │   ├── acp-extension-grok/           # xAI Grok CLI ACP adapter
│   │   ├── acp-extension-devin/          # Cognition Devin CLI ACP adapter
│   │   └── acp-extension-kimi/           # Moonshot Kimi Code ACP adapter
│   └── agent-client/                     # @universal-agent/client (Host SDK + flat bundled *-acp.js entries)
└── examples/
    └── simple-chat.ts                    # Minimal host integration example
```

---

## Key Capabilities

1. **7 Built-in Agents + Custom Standard ACP Support**:
   - Built-in deep adapters: `claude`, `codex`, `kimi`, `pi`, `deepseek`, `grok`, `devin`.
   - Standard ACP (`custom`): spawn any local binary, `npx`, or `uvx` command speaking standard ACP over stdio NDJSON.
2. **BYO CLI + Path Override Resolution**:
   - Resolves agent binaries in priority order: explicit `executablePath` override $\rightarrow$ process `PATH` $\rightarrow$ cached Login Shell `PATH` (with 3s timeout protection) $\rightarrow$ common install directories (`~/.local/bin`, `~/bin`, `~/.claude/local`, `~/.kimi-code/bin`, `~/.grok/bin`).
3. **Production-Grade ACP Extensions (Dual Wire Prefix `_meta.ua` & `_meta.lody`)**:
   - Mid-turn Acknowledged Steer (`_ua/session/steer` & `_lody/session/steer`)
   - Subagent lifecycle snapshots, streaming output, and cancellation (`_ua/subagents/*`)
   - Token usage, cost accounting, context window tracking, and rate-limit queries
   - AskUserQuestion form elicitation bridged into `onRequestPermission`
   - Ordered runtime configuration application (`mode -> model -> dependent options`)
4. **Cross-Platform Process Tree & Stream Safety**:
   - Detached POSIX process groups and Windows `taskkill /T` tree termination (`SIGTERM` $\rightarrow$ grace period $\rightarrow$ `SIGKILL`).
   - Windows DeepSeek Harness `cmd.exe` 8191-char limit bypass via direct `npx-cli.js` invocation and `windowsHide: true`.
   - Outermost Loopback `NO_PROXY` (`localhost,127.0.0.1,::1`) injection so user shell proxies never hijack local HTTP MCP connections.

---

## Quick Start

```typescript
import { startAgentSession } from '@universal-agent/client';

const session = await startAgentSession({
  target: {
    cliType: 'builtin',
    agentType: 'claude',
    // Optional explicit binary path override:
    // executablePath: '/usr/local/bin/claude',
  },
  workdir: process.cwd(),
  initialConfig: {
    modelId: 'default',
  },
  onUpdateMessage: (notification) => {
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      process.stdout.write(update.content.text);
    }
  },
  onRequestPermission: async (_requestId, request) => {
    const allowOnce = request.options.find((opt) => opt.kind === 'allow_once');
    return {
      outcome: allowOnce
        ? { outcome: 'selected', optionId: allowOnce.optionId }
        : { outcome: 'cancelled' },
    };
  },
});

await session.prompt([{ type: 'text', text: 'Summarize the project structure.' }]);
await session.shutdown();
```

---

## Built-in Agent Authentication & Runtime Dependencies (Host Responsibility)

The SDK **never stores, downloads, or refreshes** user credentials. It forwards the host's `env` and relies on existing local CLI login states:

| Agent (`agentType`) | Local CLI Binary | Host Authentication / Environment Requirement | SDK Launch Behavior |
| :--- | :--- | :--- | :--- |
| `claude` | `claude` | Local Claude Code login (`claude login`) or `ANTHROPIC_API_KEY` | Spawns `dist/claude-acp.js` with `CLAUDE_CODE_EXECUTABLE` |
| `codex` | `codex` | Local Codex login or `OPENAI_API_KEY` | Spawns `dist/codex-acp.js` with `CODEX_PATH` |
| `kimi` | `kimi` | Local Kimi Code login | Spawns `kimi acp` with `KIMI_CODE_NO_AUTO_UPDATE=1` (or `dist/kimi-acp.js`) |
| `pi` | `pi` (or bundled) | Provider credentials per `@earendil-works/pi-coding-agent` | Spawns `dist/pi-acp.js` with `UA_PI_PATH` (and legacy `LODY_PI_PATH`) |
| `deepseek` | `npx` | Provider credentials in `DSH_HOME` / `dataDir` | Generates isolated Cordis profile under `dataDir` & spawns `dist/deepseek-acp.js` |
| `grok` | `grok` | Local Grok CLI login / `XAI_API_KEY` | Spawns `dist/grok-acp.js` with `GROK_PATH` and `GROK_DISABLE_AUTOUPDATER=1` |
| `devin` | `devin` | Local Devin CLI login | Spawns `dist/devin-acp.js` with `DEVIN_PATH` |
| `custom` | Custom `command` | Managed by host application | Spawns `command` + `args` directly |

---

## Electron / ASAR Packaging Note

When bundling `@universal-agent/client` inside an Electron application using `.asar`, ensure `node_modules/@universal-agent/client/dist/**` is unpacked via `asarUnpack`:
- `resolveBundledAdapterEntry()` automatically rewrites `.asar/` paths to `.asar.unpacked/` when resolving `dist/{claude,codex,kimi,deepseek,grok,devin,pi}-acp.js` for child process spawning.

---

## Development & Verification

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```
