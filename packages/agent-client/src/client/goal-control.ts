import type * as acp from '@agentclientprotocol/sdk';
import type { GoalCapability } from '@universal-agent/acp-extension-core';
import type { SessionGoalAction } from '../types';

export type GoalActionTransport = 'request' | 'promptMeta' | 'slashCommand';

export type GoalPromptControl = {
  action: SessionGoalAction;
  objective?: string;
};

export function resolveGoalActionTransport(
  capability: GoalCapability | undefined,
  action: SessionGoalAction,
  context: 'control' | 'prompt' = 'control'
): GoalActionTransport | null {
  if (!capability?.actions.includes(action)) {
    return null;
  }
  if (
    context === 'control' &&
    capability.controlActions?.includes(action) &&
    (action === 'pause' || action === 'clear')
  ) {
    return 'request';
  }
  if (capability.promptActions?.includes(action)) {
    return 'promptMeta';
  }
  return capability.controlActions || capability.promptActions ? null : 'slashCommand';
}

export function buildGoalPromptMeta(control: GoalPromptControl): acp.PromptRequest['_meta'] {
  const goalControl = {
    version: 1 as const,
    action: control.action,
    ...(control.action === 'set' ? { objective: control.objective ?? '' } : {}),
  };
  return {
    ua: { goalControl },
    lody: { goalControl },
  };
}

export function buildGoalSlashCommandText(control: GoalPromptControl): string {
  return control.action === 'set'
    ? `/goal ${(control.objective ?? '').trim()}`
    : `/goal ${control.action}`;
}
