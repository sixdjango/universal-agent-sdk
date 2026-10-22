# Upstream Synchronization & Provenance

This repository extracts and decouples the ACP (Agent Client Protocol) client SDK and built-in agent adapters from the Lody monorepo into a standalone, brand-neutral `@universal-agent/*` SDK.

## Source Provenance

| Target Package / Module | Upstream Source | Upstream Commit |
| :--- | :--- | :--- |
| `packages/acp-extension-core` | `packages/acp-extension-core` | `11e0708df0669568f44e287f17626a3944921dc5` (`v0.2.0`) |
| `packages/adapters/acp-extension-claude` | `packages/acp-extension-claude` | `269960a27ef6679813c569cc0c73bf501114a23a` |
| `packages/adapters/acp-extension-codex` | `packages/acp-extension-codex` | `df464ab94e3028ce49a95ae0a9377957c54d8b93` |
| `packages/adapters/acp-extension-devin` | `packages/acp-extension-devin` | `d49d35789adc3cd089bf51b28df9e6e6b945241b` |
| `packages/adapters/acp-extension-dsh` | `packages/acp-extension-dsh` | `fed5474fa2f259df6cc94d935c8139d81aeee699` |
| `packages/adapters/acp-extension-grok` | `packages/acp-extension-grok` | `2fc653bde0b1cc2570c9da308d4585526ed55591` |
| `packages/adapters/acp-extension-pi` | `packages/acp-extension-pi` | `70c2a28385f6f67e3a72c953aa132ed9dac03dfa` |
| `packages/adapters/acp-extension-kimi` | `packages/acp-extension-kimi` (Lightweight ACP bridge) | `6a72b37485e95cbda37a86bae6fe4a918686b46b` |
| `packages/agent-client` | `apps/cli/src/agent/*` & `apps/cli/src/session/*` | `957b513ee391c5b69101ae3d22ee353f1d6f4b20` |

## Synchronization & Versioning Rules

1. **Zero `@lody/*` Dependency Constraint**: No package in this workspace may depend on `@lody/*` packages, private R2/CDN runtime manifests, or credential vaults.
2. **Dual Wire Prefix Compatibility**: `@universal-agent/acp-extension-core` and `@universal-agent/client` accept both `_meta.ua` / `_ua/*` and `_meta.lody` / `_lody/*` on the wire so upstream adapters remain byte-compatible. Public TypeScript exports use brand-neutral names (`ExtensionCapabilities`, `SubagentEvent`, etc.) with deprecated `Lody*` aliases for transition.
3. **Lockstep SemVer Upgrades**: Any breaking change in `@universal-agent/acp-extension-core` must bump its major version and update all built-in adapters (`packages/adapters/*`) and `packages/agent-client` in the same PR.
