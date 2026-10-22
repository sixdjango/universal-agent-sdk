import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  DEEPSEEK_HARNESS_CORDIS_PACKAGE_VERSIONS,
  DEEPSEEK_HARNESS_NPX_PACKAGES,
  DEEPSEEK_HARNESS_PI_AI_VERSION,
  DEEPSEEK_HARNESS_SCHEMASTERY_VERSION,
  DEEPSEEK_HARNESS_PROFILE_BUNDLES,
  DEEPSEEK_HARNESS_PROFILE_NAME,
  DEEPSEEK_HARNESS_VERSION,
  createDeepSeekHarnessNpxSpecifiers,
  createDeepSeekHarnessProfileFiles,
  toAdapterModuleSpecifier,
} from './profile.js';
describe('DeepSeek Harness profile', () => {
  it.each([
    ['https://api.deepseek.com', undefined, 'https://api.deepseek.com/anthropic'],
    ['https://api.deepseek.com/v1/', undefined, 'https://api.deepseek.com/anthropic'],
    ['https://api.deepseek.com/anthropic/v1', undefined, 'https://api.deepseek.com/anthropic'],
    [
      'https://api.deepseek.com',
      { baseURL: 'https://gateway.example/v1' },
      'https://gateway.example/v1',
    ],
    [
      'https://gateway.example/v1',
      { baseURL: 'https://api.deepseek.com/v1' },
      'https://api.deepseek.com/anthropic',
    ],
    ['https://gateway.example/v1', undefined, undefined],
    ['https://api.deepseek.com.evil.example', undefined, undefined],
    ['https://api.deepseek.com:8443', undefined, undefined],
    ['https://api.deepseek.com?token=synthetic', undefined, undefined],
    ['https://synthetic@api.deepseek.com', undefined, undefined],
    [undefined, undefined, undefined],
  ])(
    'resolves native provider config from env %s and settings %j',
    (endpoint, section, expected) => {
      const files = createDeepSeekHarnessProfileFiles({
        adapterPath: '/synthetic/adapter.js',
        presetRoot: '/synthetic/presets',
      });
      // Execute the generated Cordis expression, including its missing-file path.
      const row = files.cordisPatchYml.split('- id: llm-deepseek\n')[1]!.split('\n')[0]!;
      const expression = JSON.parse(row.slice(row.indexOf('!!js ') + 5));
      const config = runInNewContext(expression, {
        baseUrl: 'file:///synthetic/profile/',
        process: {
          env: { DEEPSEEK_BASE_URL: endpoint },
          getBuiltinModule: (name: string) => {
            if (name === 'node:fs')
              return {
                readFileSync: () => {
                  if (!section) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                  return 'synthetic YAML';
                },
              };
            if (name === 'node:path') return { join: (...parts: string[]) => parts.join('/') };
            if (name === 'node:os') return { homedir: () => '/synthetic' };
            return { createRequire: () => () => ({ load: () => ({ 'llm-deepseek': section }) }) };
          },
        },
      });
      expect(config.baseURL).toBe(expected);
    }
  );

  it('pins the launcher, base bundle, and same-release package closure', () => {
    expect(DEEPSEEK_HARNESS_VERSION).toBe('0.2.1-rc.2');
    expect(DEEPSEEK_HARNESS_PROFILE_NAME).toBe('lody-acp');
    expect(DEEPSEEK_HARNESS_PROFILE_BUNDLES).toEqual(['@deepseek-ai/dsh-base']);
    expect(new Set(DEEPSEEK_HARNESS_NPX_PACKAGES).size).toBe(DEEPSEEK_HARNESS_NPX_PACKAGES.length);
    expect(DEEPSEEK_HARNESS_NPX_PACKAGES[0]).toBe('@deepseek-ai/dsh');
    expect(DEEPSEEK_HARNESS_NPX_PACKAGES).toEqual(
      expect.arrayContaining([
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-agent-preset-registry',
        '@deepseek-ai/dsh-mcp-client',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-agent-tool-presentation',
        '@deepseek-ai/dsh-attachment-local',
        '@deepseek-ai/dsh-tool-str-replace-editor',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-working-directory',
        '@deepseek-ai/dsh-tool-schedule',
        '@deepseek-ai/dsh-plugin-market',
      ])
    );
    for (const removed of [
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-subagent-in-process-driver',
      '@deepseek-ai/dsh-experimental-schedule-bundle',
    ]) {
      expect(DEEPSEEK_HARNESS_NPX_PACKAGES).not.toContain(removed);
    }
    expect(DEEPSEEK_HARNESS_NPX_PACKAGES).not.toContain('@deepseek-ai/dsh-acp-demo');
    expect(DEEPSEEK_HARNESS_NPX_PACKAGES).not.toContain('@deepseek-ai/dsh-agent-spine-demo');
  });

  it('pins the Cordis ecosystem at its own releases instead of the Harness release', () => {
    const specifiers = createDeepSeekHarnessNpxSpecifiers();

    expect(specifiers).toHaveLength(DEEPSEEK_HARNESS_NPX_PACKAGES.length + 2);
    expect(specifiers).toEqual(
      expect.arrayContaining([
        '@deepseek-ai/cordis@4.0.5',
        '@deepseek-ai/cordis-plugin-group@1.0.5',
        '@deepseek-ai/cordis-plugin-include@1.0.10',
        '@deepseek-ai/cordis-plugin-loader@1.0.6',
        '@deepseek-ai/cordis-plugin-timer@1.1.7',
      ])
    );
    // No Cordis package publishes a `DEEPSEEK_HARNESS_VERSION` release, so a
    // specifier built from it fails the cold install with ETARGET.
    for (const name of Object.keys(DEEPSEEK_HARNESS_CORDIS_PACKAGE_VERSIONS)) {
      expect(DEEPSEEK_HARNESS_NPX_PACKAGES).toContain(name);
      expect(specifiers).not.toContain(`${name}@${DEEPSEEK_HARNESS_VERSION}`);
    }
    expect(specifiers).toContain(`@earendil-works/pi-ai@${DEEPSEEK_HARNESS_PI_AI_VERSION}`);
    expect(specifiers).toContain(
      `@deepseek-ai/schemastery@${DEEPSEEK_HARNESS_SCHEMASTERY_VERSION}`
    );
    for (const specifier of specifiers.slice(0, DEEPSEEK_HARNESS_NPX_PACKAGES.length)) {
      const separator = specifier.lastIndexOf('@');
      const name = specifier.slice(0, separator);
      const version = specifier.slice(separator + 1);
      expect(DEEPSEEK_HARNESS_NPX_PACKAGES).toContain(name);
      expect(version).toBe(
        DEEPSEEK_HARNESS_CORDIS_PACKAGE_VERSIONS[name] ?? DEEPSEEK_HARNESS_VERSION
      );
    }
  });

  it('renders a Windows adapter path as a file URL module specifier', () => {
    // A raw `C:\...` path parses as the `c:` URL scheme and fails the ESM
    // loader on Windows; the override pins that conversion from any CI OS.
    expect(toAdapterModuleSpecifier('C:\\Program Files\\Lody\\deepseek-acp.js', true)).toBe(
      'file:///C:/Program%20Files/Lody/deepseek-acp.js'
    );
  });

  it('leaves an already-file adapter specifier untouched', () => {
    expect(toAdapterModuleSpecifier('file:///opt/acp-extension-dsh.js', true)).toBe(
      'file:///opt/acp-extension-dsh.js'
    );
  });
});
