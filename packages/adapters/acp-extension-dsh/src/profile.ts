/**
 * DeepSeek Harness composition contract for the Lody ACP host.
 *
 * Lody runs the DeepSeek Harness profile/bundle launcher: `dsh --profile <name>`
 * composes the pinned `@deepseek-ai/dsh-base` bundle under
 * `$DSH_HOME/profiles/<name>` and then applies the generated
 * `cordis.patch.yml` overlay. That overlay removes product/telemetry rows and
 * mounts this package's adapter as the ACP entry point, so the host keeps the
 * upstream base composition without inheriting the web product surface.
 */

import { pathToFileURL } from 'node:url';

import {
  DEEPSEEK_HARNESS_DEFAULT_PERMISSION_PRESET,
  DEEPSEEK_HARNESS_PERMISSION_PRESETS,
  DEEPSEEK_HARNESS_OFFICIAL_BASE_URL,
  DEEPSEEK_HARNESS_OFFICIAL_BASE_URL_PATTERN,
} from './capabilities.js';

export const ACP_EXTENSION_DSH_VERSION = '0.2.0';
export const DEEPSEEK_HARNESS_VERSION = '0.2.1-rc.2';
export const DEEPSEEK_HARNESS_PI_AI_VERSION = '1.3.0';
export const DEEPSEEK_HARNESS_SCHEMASTERY_VERSION = '3.18.5';
export const ACP_EXTENSION_DSH_PROFILE_REVISION = 'v20';
export const ACP_EXTENSION_DSH_SESSION_ROOT_ENV = 'ACP_EXTENSION_DSH_SESSION_ROOT';
export const ACP_EXTENSION_DSH_QUERY_PATH_ENV = 'ACP_EXTENSION_DSH_QUERY_PATH';
export const DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION = 'zstd';

/** Profile directory name resolved under `$DSH_HOME/profiles`. */
export const DEEPSEEK_HARNESS_PROFILE_NAME = 'lody-acp';
/** Bundle layers the generated profile composes, in order. */
export const DEEPSEEK_HARNESS_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base'] as const;
/** Provider route and default model pinned for new sessions. */
export const DEEPSEEK_HARNESS_PROVIDER = 'deepseek-official';
export const DEEPSEEK_HARNESS_DEFAULT_MODEL = 'deepseek-flash';

export type DeepSeekHarnessSessionCompression = 'zstd' | 'none';

export const ACP_EXTENSION_DSH_CAPABILITY_SOURCE_VERSION = `acp-extension-dsh@${ACP_EXTENSION_DSH_VERSION}:dsh@${DEEPSEEK_HARNESS_VERSION}:profile-${ACP_EXTENSION_DSH_PROFILE_REVISION}`;

/**
 * Exact same-version package closure for the launcher install. The Harness
 * packages and their peers are pinned together, so every package the composed
 * profile or a shipped Agent preset can resolve uses the same release; the
 * first entry owns the `dsh` binary.
 */
export const DEEPSEEK_HARNESS_NPX_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-acp',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-agent-tool-presentation',
  '@deepseek-ai/dsh-anonymous-user-id',
  '@deepseek-ai/dsh-api-account-controller',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-job-controller',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-settings-controller',
  '@deepseek-ai/dsh-api-terminal-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-api-workspace-files',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-chunked-list',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-product-analytics',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-deepseek-model-label-1017',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-ui-plugin-market',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-schedule',
  '@deepseek-ai/dsh-client-ui-secret-mask',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-account',
  '@deepseek-ai/dsh-client-ui-settings-agent-loop',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-session-log',
  '@deepseek-ai/dsh-client-ui-settings-shell',
  '@deepseek-ai/dsh-client-ui-settings-subagent',
  '@deepseek-ai/dsh-client-ui-settings-web-search',
  '@deepseek-ai/dsh-client-ui-shortcuts',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar-browser',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-command-feedback',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-image-offload',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-config-editor',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-deepseek-account',
  '@deepseek-ai/dsh-deepseek-account-platform',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  '@deepseek-ai/dsh-deque',
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-api-speech-to-text',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-client-ui-agent-team',
  '@deepseek-ai/dsh-experimental-client-ui-cot-translation',
  '@deepseek-ai/dsh-experimental-client-ui-voice-input',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-inspector',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-session-inspector',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-speech-to-text',
  '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-tool-agent-team',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-translator',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-worktree',
  '@deepseek-ai/dsh-file-reference',
  '@deepseek-ai/dsh-file-reference-local',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-goal',
  '@deepseek-ai/dsh-goal-round-driver',
  '@deepseek-ai/dsh-harness-dev-context',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-hmr',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-hook-protocol',
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-hooks-codex',
  '@deepseek-ai/dsh-host-directory-picker',
  '@deepseek-ai/dsh-host-directory-picker-auto',
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-host-open-in-app',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-host-product-telemetry-otel',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-http-proxy',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-lazy-require',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-deepseek-account',
  '@deepseek-ai/dsh-llm-deepseek-api-key',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-mcp-resources',
  '@deepseek-ai/dsh-message-feedback',
  '@deepseek-ai/dsh-native-command',
  '@deepseek-ai/dsh-office-to-pdf',
  '@deepseek-ai/dsh-otel',
  '@deepseek-ai/dsh-output-retention',
  '@deepseek-ai/dsh-package-manifest',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-plugin-market',
  '@deepseek-ai/dsh-plugin-market-index',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  '@deepseek-ai/dsh-ptc-runtime',
  '@deepseek-ai/dsh-ptc-runtime-node',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-repeat-tool-reminder',
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-schedule',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-sdk-protocol',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v0-to-v1',
  '@deepseek-ai/dsh-session-format-v1-to-v2',
  '@deepseek-ai/dsh-session-format-v2-to-v3',
  '@deepseek-ai/dsh-session-format-v3-to-v4',
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-session-log-export',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-reference',
  '@deepseek-ai/dsh-session-stats',
  '@deepseek-ai/dsh-session-telemetry',
  '@deepseek-ai/dsh-session-telemetry-otel',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-session-title-all-prompts-llm',
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
  '@deepseek-ai/dsh-session-title-llm',
  '@deepseek-ai/dsh-session-turn-outline',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-shell',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-badge',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-skill-office',
  '@deepseek-ai/dsh-spill',
  '@deepseek-ai/dsh-spill-local',
  '@deepseek-ai/dsh-spill-policy',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-tmux-context',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-present',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-schedule',
  '@deepseek-ai/dsh-tool-session-query',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-terminal',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-working-directory',
  '@deepseek-ai/dsh-tool-workspace-dependencies',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-loader',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-util-code-language',
  '@deepseek-ai/dsh-util-crypto',
  '@deepseek-ai/dsh-util-time',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/dsh-util-workspace-path',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-web-deepseek-api',
  '@deepseek-ai/dsh-web-fetch-http',
  '@deepseek-ai/dsh-web-frontend',
  '@deepseek-ai/dsh-web-search-deepseek',
  '@deepseek-ai/dsh-webhook',
  '@deepseek-ai/dsh-webhook-github',
  '@deepseek-ai/dsh-win32-process',
  '@deepseek-ai/dsh-workflow',
  '@deepseek-ai/dsh-workflow-ptc',
  '@deepseek-ai/dsh-working-directory',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-workspace-changes',
] as const;

/** Cordis and Cosmokit releases are independent of the Harness package family. */
export const DEEPSEEK_HARNESS_CORDIS_PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis': '4.0.5',
  '@deepseek-ai/cordis-plugin-group': '1.0.5',
  '@deepseek-ai/cordis-plugin-include': '1.0.10',
  '@deepseek-ai/cordis-plugin-loader': '1.0.6',
  '@deepseek-ai/cordis-plugin-timer': '1.1.7',
  '@deepseek-ai/cosmokit': '1.8.6',
};

/**
 * Exact `name@version` specifiers the launcher installs: Harness-family
 * packages take `DEEPSEEK_HARNESS_VERSION`, the Cordis-ecosystem exceptions
 * take their own release.
 */
export function createDeepSeekHarnessNpxSpecifiers(
  versions: Readonly<Record<string, string>> = DEEPSEEK_HARNESS_CORDIS_PACKAGE_VERSIONS
): string[] {
  return [
    ...DEEPSEEK_HARNESS_NPX_PACKAGES.map(
      (packageName) => `${packageName}@${versions[packageName] ?? DEEPSEEK_HARNESS_VERSION}`
    ),
    `@earendil-works/pi-ai@${DEEPSEEK_HARNESS_PI_AI_VERSION}`,
    `@deepseek-ai/schemastery@${DEEPSEEK_HARNESS_SCHEMASTERY_VERSION}`,
  ];
}

/** Generated files written into the profile directory before launch. */
export type DeepSeekHarnessProfileFiles = {
  packageJson: string;
  cordisYml: string;
  cordisPatchYml: string;
  pnpmWorkspaceYaml: string;
};

export type DeepSeekHarnessProfileConfig = {
  /** Absolute path of the bundled ACP adapter entry (`deepseek-acp.js`). */
  adapterPath: string;
  /** Root holding the pinned standard/PTC/minimal/creator Agent presets. */
  presetRoot: string;
  sessionCompression?: DeepSeekHarnessSessionCompression;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

/**
 * The Cordis loader resolves each plugin's `name` as a module specifier, so the
 * adapter must be a `file:` URL: a raw Windows path (`C:\...`) parses as the
 * `c:` URL scheme and fails the ESM loader before ACP can initialize. The
 * `windows` flag mirrors the platform default and lets the Windows conversion
 * be regression-tested from any CI OS.
 */
export function toAdapterModuleSpecifier(
  adapterPath: string,
  windows: boolean = process.platform === 'win32'
): string {
  if (adapterPath.startsWith('file:')) return adapterPath;
  return pathToFileURL(adapterPath, { windows }).href;
}

const PROFILE_PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n';

/** Read the existing Lody settings document before provider construction, without migration. */
function legacySettingsExpression(namespace: string): string {
  return JSON.stringify(`(() => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const home = process.env.DSH_HOME || path.join(process.getBuiltinModule('node:os').homedir(), '.dsh');
    const file = path.join(home, 'settings.yaml');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
    const document = process.getBuiltinModule('node:module').createRequire(baseUrl)('js-yaml').load(text) ?? {};
    if (typeof document !== 'object' || Array.isArray(document)) throw new Error('settings.yaml must be a mapping');
    const section = document[${JSON.stringify(namespace)}] ?? {};
    if (typeof section !== 'object' || Array.isArray(section)) throw new Error('settings.yaml section must be a mapping');
    ${
      namespace === 'llm-deepseek'
        ? `
    const endpoint = section.baseURL ?? process.env.DEEPSEEK_BASE_URL;
    if (typeof endpoint === 'string' && new RegExp(${JSON.stringify(DEEPSEEK_HARNESS_OFFICIAL_BASE_URL_PATTERN.source)}, 'i').test(endpoint.trim())) {
      return { ...section, baseURL: ${JSON.stringify(DEEPSEEK_HARNESS_OFFICIAL_BASE_URL)} };
    }`
        : ''
    }
    return section;
  })()`);
}

/** Build the profile files without touching the filesystem. */
export function createDeepSeekHarnessProfileFiles(
  config: DeepSeekHarnessProfileConfig
): DeepSeekHarnessProfileFiles {
  const provider = config.provider?.trim() || DEEPSEEK_HARNESS_PROVIDER;
  const model = config.model?.trim() || DEEPSEEK_HARNESS_DEFAULT_MODEL;
  const compression = config.sessionCompression ?? DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION;
  const adapterPath = JSON.stringify(toAdapterModuleSpecifier(config.adapterPath));
  // Rendered from the shared permission vocabulary so the labels a host shows
  // in the ACP selector and the presets Harness enforces are the same text.
  const permissionPresets = DEEPSEEK_HARNESS_PERMISSION_PRESETS.map(
    (preset) =>
      `      ${preset.id}:\n` +
      `        sandbox: ${preset.sandbox}\n` +
      `        approval: ${preset.approval}\n` +
      `        name: ${preset.name}\n` +
      `        description: ${preset.description}`
  ).join('\n');

  const packageJson =
    JSON.stringify(
      {
        name: `dsh-profile-${DEEPSEEK_HARNESS_PROFILE_NAME}`,
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: [...DEEPSEEK_HARNESS_PROFILE_BUNDLES],
            patchReload: 'startup',
          },
        },
      },
      null,
      2
    ) + '\n';

  const cordisYml = '[]\n';

  const cordisPatchYml = `# Generated by acp-extension-dsh ${ACP_EXTENSION_DSH_VERSION} for DeepSeek Harness ${DEEPSEEK_HARNESS_VERSION}.
# API credentials stay in the host environment; never inline them here.

# The ACP host owns no telemetry or product inventory rows.
- id: session-telemetry-otel
  disabled: true

- id: plugin-package-inventory-deepseek
  disabled: true

- id: session-log-deepseek
  disabled: true

# Keep account-backed routes and automatic settings migration out of this profile.
- id: deepseek-account
  disabled: true

- id: llm-deepseek-account
  disabled: true

- id: settings
  disabled: true

# Presets own these model-facing rows; their registries stay on the host.
- id: tool-plugin-manager
  disabled: true

- id: tool-bash
  disabled: true

- id: tool-pwsh
  disabled: true

- id: tool-jobs
  disabled: true

- id: tool-fs
  disabled: true

- id: tool-fs-search
  disabled: true

- id: skill-filesystem
  disabled: true

- id: tool-skill
  disabled: true

- id: command-goal
  disabled: true

- id: tool-goal
  disabled: true

- id: plan-mode
  disabled: true

- id: compaction-basic
  disabled: true

- id: command-compact
  disabled: true

- id: tool-result-pruner
  disabled: true

- id: tool-subagent-control
  disabled: true

- id: tool-subagent-list-agents
  disabled: true

- id: tool-subagent
  disabled: true

- id: tool-subagent-fork
  disabled: true

- id: workflow-ptc
  disabled: true

- id: tool-workflow
  disabled: true

- id: tool-ralph
  disabled: true

- id: agent-instructions
  disabled: true

- id: tool-todo
  disabled: true

- id: tool-web
  disabled: true

# Keep sessions and the exact-read query index on Lody's own roots.
- id: session-persistence-jsonl
  config:
    root: !!js process.env.${ACP_EXTENSION_DSH_SESSION_ROOT_ENV}
    compression: ${compression}

- id: session-query-sqlite
  config:
    path: !!js process.env.${ACP_EXTENSION_DSH_QUERY_PATH_ENV}
    openAt: never

# The agent factory default for any preset-created child.
- id: agent-default-model
  config:
    provider: ${JSON.stringify(provider)}
    model: ${JSON.stringify(model)}

# Read legacy model configuration without migrating or rewriting the user's file.
- id: llm-deepseek
  config: !!js ${legacySettingsExpression('llm-deepseek')}

- id: llm-pi-ai
  config: !!js ${legacySettingsExpression('llm-pi-ai')}

# Preserve the product's three permission modes with client-facing labels.
- id: permission
  config:
    defaultPreset: ${DEEPSEEK_HARNESS_DEFAULT_PERMISSION_PRESET}
    presets:
${permissionPresets}

- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard

    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'

    - id: cordis-inspect-providers
      name: '@deepseek-ai/dsh-tool-cordis/host'

    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

    - id: acp-agent
      name: ${adapterPath}
      config:
        presetRoot: ${JSON.stringify(config.presetRoot)}
        settingsPath: !!js dshHomePath('settings.yaml')
        projectMetadataRoot: !!js dshHomePath('lody-projects')
        userPresetRoot: !!js dshHomePath('.agent-presets')
        provider: ${JSON.stringify(provider)}
        model: ${JSON.stringify(model)}${config.reasoningEffort ? `\n        reasoningEffort: ${JSON.stringify(config.reasoningEffort)}` : ''}
`;

  return { packageJson, cordisYml, cordisPatchYml, pnpmWorkspaceYaml: PROFILE_PNPM_WORKSPACE };
}

/**
 * A profile directory must exist before the launcher resolves it. The caller
 * writes these files under `$DSH_HOME/profiles/<DEEPSEEK_HARNESS_PROFILE_NAME>`.
 */
export const DEEPSEEK_HARNESS_PROFILE_FILENAMES = {
  packageJson: 'package.json',
  cordisYml: 'cordis.yml',
  cordisPatchYml: 'cordis.patch.yml',
  pnpmWorkspaceYaml: 'pnpm-workspace.yaml',
} as const;
