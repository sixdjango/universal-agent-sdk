import { describe, expect, it } from 'vitest';
import {
  applyAcpSessionRunConfig,
  isSensitiveAcpConfigOptionId,
} from '../src/client/config-applier';
import { noopLogger } from '../src/process/stream';

describe('config-applier invariants (mode -> model -> dependent options)', () => {
  it('applies mode, then model, then dependent config options in strict order', async () => {
    const calls: string[] = [];

    const result = await applyAcpSessionRunConfig({
      session: {
        sessionId: 'sess-1',
        acpSessionId: 'acp-1',
        agentClient: {
          isCreated: () => true,
          getConfigOptions: () => [
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              currentValue: 'auto',
              options: [{ value: 'auto', name: 'Auto' }],
            },
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'sonnet',
              options: [{ value: 'sonnet', name: 'Sonnet' }],
            },
            {
              id: 'reasoning_effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'high',
              options: [{ value: 'high', name: 'High' }],
            },
          ],
          setSessionMode: async (_id, modeId) => {
            calls.push(`mode:${modeId}`);
          },
          unstable_setSessionModel: async (_id, modelId) => {
            calls.push(`model:${modelId}`);
          },
          setSessionConfigOption: async (_id, configId, value) => {
            calls.push(`config:${configId}=${String(value)}`);
            return undefined;
          },
        },
      },
      config: {
        cliType: 'builtin',
        agentType: 'claude',
        modeId: 'acceptEdits',
        modelId: 'opus[1m]',
        configOptionValues: {
          mode: 'acceptEdits',
          model: 'opus[1m]',
          reasoning_effort: 'max',
          fast: true,
        },
      },
      logger: noopLogger,
    });

    expect(calls).toEqual([
      'mode:acceptEdits',
      'model:opus[1m]',
      'config:reasoning_effort=max',
      'config:fast=true',
    ]);
    expect(result.rejectedSelections).toEqual([]);
  });

  it('skips disabling fast mode when switching to Claude Fable', async () => {
    const calls: string[] = [];

    await applyAcpSessionRunConfig({
      session: {
        sessionId: 'sess-fable',
        acpSessionId: 'acp-fable',
        agentClient: {
          isCreated: () => true,
          getConfigOptions: () => [],
          setSessionMode: async () => {},
          unstable_setSessionModel: async (_id, modelId) => {
            calls.push(`model:${modelId}`);
          },
          setSessionConfigOption: async (_id, configId, value) => {
            calls.push(`config:${configId}=${String(value)}`);
            return undefined;
          },
        },
      },
      config: {
        cliType: 'builtin',
        agentType: 'claude',
        modelId: 'claude-fable-5-1[1m]',
        configOptionValues: {
          fast: false,
          effort: 'high',
        },
      },
      logger: noopLogger,
    });

    expect(calls).toEqual(['model:claude-fable-5-1[1m]', 'config:effort=high']);
  });

  it('identifies sensitive config option IDs accurately', () => {
    expect(isSensitiveAcpConfigOptionId('anthropic_api_key')).toBe(true);
    expect(isSensitiveAcpConfigOptionId('bearer_token')).toBe(true);
    expect(isSensitiveAcpConfigOptionId('reasoning_effort')).toBe(false);
  });
});
