import { describe, expect, it } from 'vitest';
import {
  buildAskUserQuestionElicitationResponse,
  createAskUserQuestionPermissionOutcome,
  getBuiltinToolPermissionOutcome,
  getExtensionMetaContainer,
  parseAskUserQuestionElicitationRequest,
  parseExtensionCapabilities,
  parseExtensionMessage,
} from '../src/client/extension-parser';

describe('extension-parser dual wire compatibility (_meta.ua & _meta.lody)', () => {
  it('prefers _meta.ua and falls back to _meta.lody', () => {
    expect(
      getExtensionMetaContainer({
        ua: { sessionTitle: { version: 1 } },
        lody: { sessionTitle: { version: 0 } },
      })
    ).toEqual({ sessionTitle: { version: 1 } });

    expect(
      getExtensionMetaContainer({
        lody: { sessionTitle: { version: 1 } },
      })
    ).toEqual({ sessionTitle: { version: 1 } });
  });

  it('parses ExtensionCapabilities from both _meta.ua and _meta.lody', () => {
    const uaCaps = parseExtensionCapabilities({
      ua: {
        sessionTitle: { version: 1 },
        steering: {
          version: 1,
          transport: 'request',
          upstreamTurn: 'same',
          configPolicy: 'active',
        },
        subagentEvents: { version: 1 },
      },
    });
    expect(uaCaps.sessionTitle).toEqual({ version: 1 });
    expect(uaCaps.steering).toEqual({
      version: 1,
      transport: 'request',
      upstreamTurn: 'same',
      configPolicy: 'active',
    });
    expect(uaCaps.subagentEvents).toEqual({ version: 1 });

    const lodyCaps = parseExtensionCapabilities({
      lody: {
        rateLimits: { version: 1, query: true },
        forkAtTurn: { version: 1 },
      },
    });
    expect(lodyCaps.rateLimits?.query).toBe(true);
    expect(lodyCaps.forkAtTurn).toEqual({ version: 1 });
  });

  it('parses extension messages across _ua/* and _lody/* wire prefixes', () => {
    const usagePayload = {
      sessionId: 'sess-1',
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 0,
      },
      _meta: {
        ua: {
          usageScopeId: 'acc-1',
        },
      },
    };

    const fromUa = parseExtensionMessage({
      method: '_ua/session/usage_update',
      params: usagePayload,
      sessionId: 'sess-1',
      provider: 'claude',
    });
    expect(fromUa?.type).toBe('usage');
    if (fromUa?.type === 'usage') {
      expect(fromUa.update.usage.inputTokens).toBe(120);
      expect(fromUa.accountingId).toBe('sess-1:scope:acc-1');
    }

    const fromLody = parseExtensionMessage({
      method: '_lody/session/usage_update',
      params: usagePayload,
      sessionId: 'sess-1',
      provider: 'claude',
    });
    expect(fromLody?.type).toBe('usage');
  });

  it('automatically approves Grok tool calls when permission_mode is always-approve', () => {
    const outcome = getBuiltinToolPermissionOutcome({
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      configOptions: [
        {
          id: 'permission_mode',
          name: 'Permission Mode',
          category: '_permission',
          type: 'select',
          currentValue: 'always-approve',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'always-approve', name: 'Always Approve' },
          ],
        },
      ],
      request: {
        sessionId: 'sess-grok',
        toolCall: {
          toolCallId: 'tc-1',
          title: 'Edit file',
          kind: 'edit',
          status: 'pending',
        },
        options: [
          { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
        ],
      },
      pending: false,
    });
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow-1' });
  });

  it('bridges AskUserQuestion form elicitation to permission request and back', () => {
    const elicitation = parseAskUserQuestionElicitationRequest({
      mode: 'form',
      sessionId: 'sess-1',
      message: 'Please answer',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: {
            type: 'string',
            title: 'Environment',
            description: 'Which environment should we deploy to?',
            oneOf: [
              { const: 'staging', title: 'Staging (Recommended)' },
              { const: 'prod', title: 'Production' },
            ],
          },
        },
        required: ['q1'],
      },
    } as never);

    expect(elicitation).not.toBeNull();
    expect(elicitation?.meta.questions).toHaveLength(1);
    const questionText = elicitation?.meta.questions[0]?.question!;
    expect(questionText).toBe('Please answer');

    const permissionOutcome = createAskUserQuestionPermissionOutcome('answer', {
      [questionText]: 'staging',
    });
    const elicitationResponse = buildAskUserQuestionElicitationResponse(elicitation!, {
      outcome: permissionOutcome,
    });
    expect(elicitationResponse).toEqual({
      action: 'accept',
      content: {
        q1: 'staging',
      },
    });
  });
});
