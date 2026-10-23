import {
  type AgentNode,
  type ChiefCommand,
  type ChiefDecision,
  ChiefDecisionSchema,
  type ContextManifest,
} from '@universal-agent/workflow-contract';
import {
  type ChiefReviewInput,
  type ChiefSupervisor,
  computeRunUsage,
  type ScopedArtifactReader,
} from '@universal-agent/workflow-runtime';

const COMMAND_SHAPES: Readonly<Record<ChiefCommand['kind'], string>> = {
  report: '{"kind":"report","summary":"..."}',
  inject_guidance: '{"kind":"inject_guidance","nodeId":"...","scopeKey":"(optional)","text":"..."}',
  retry_node: '{"kind":"retry_node","scopeKey":"...","nodeId":"..."}',
  rerun_from_node: '{"kind":"rerun_from_node","scopeKey":"...","nodeId":"..."}',
  swap_agent: '{"kind":"swap_agent","nodeId":"...","scopeKey":"(optional)","agentRef":"agentId[@version]"}',
  answer_wait: '{"kind":"answer_wait","requestId":"...","answer":"..."}',
  extend_loop: '{"kind":"extend_loop","scopeKey":"...","nodeId":"...","extraRounds":1}',
  escalate: '{"kind":"escalate","prompt":"question for a human","options":[{"value":"...","label":"..."}]}',
};

/** Compact, deterministic run briefing used as the chief's prompt. */
export function renderChiefBriefing(input: Omit<ChiefReviewInput, 'adapter' | 'signal'>): string {
  const { state, policy, trigger, chiefAgent } = input;
  const lines: string[] = [];

  if (chiefAgent) {
    lines.push(`# You are ${chiefAgent.profile.name}, chief agent of this workflow run`);
    lines.push(`## Responsibilities\n${chiefAgent.profile.charter}`);
    if (chiefAgent.profile.instructions.length > 0) {
      lines.push(`## Working Rules\n${chiefAgent.profile.instructions.map((r) => `- ${r}`).join('\n')}`);
    }
  } else {
    lines.push('# You are the chief agent supervising this workflow run');
  }

  const conversation = state.events
    .flatMap((e) =>
      e.type === 'chief.user_message' && e.messageId !== trigger.messageId
        ? [`- Human: ${e.text}`]
        : e.type === 'chief.intervened' && (e.reply || e.applied.length > 0)
          ? [`- You${e.trigger === 'user.message' ? '' : ` (on ${e.trigger})`}: ${e.reply ?? e.rationale}${e.applied.length > 0 ? ` [did: ${e.applied.map((c) => c.kind).join(', ')}]` : ''}`]
          : []
    )
    .slice(-12);
  if (conversation.length > 0) {
    lines.push(`## Conversation So Far\n${conversation.join('\n')}`);
  }
  if (trigger.kind === 'user.message') {
    lines.push(`## The Human Writes\n${trigger.detail}`);
  }

  lines.push(
    `## Trigger\n- kind: ${trigger.kind}\n- ${trigger.detail}${trigger.scopeKey ? `\n- scopeKey: ${trigger.scopeKey}` : ''}${trigger.nodeId ? `\n- nodeId: ${trigger.nodeId}` : ''}${trigger.requestId ? `\n- requestId: ${trigger.requestId}` : ''}`
  );

  const usage = computeRunUsage(state);
  lines.push(
    `## Run\n- workflow: ${state.definition.name} (${state.definition.id})\n- runId: ${state.runId}\n- status: ${state.status}\n- usage: ${usage.totalTokens} tokens, $${usage.costUsd.toFixed(4)}\n- interventions used: ${state.chief.interventionCount}/${policy.maxInterventionsPerRun}`
  );

  const scopeLines: string[] = [];
  for (const scope of Object.values(state.scopes)) {
    const nodes = Object.values(scope.nodes)
      .map((n) => {
        const agent = n.latestAttemptId ? state.attempts[n.latestAttemptId]?.agent : undefined;
        return `  - ${n.nodeId}: ${n.status}${n.latestVerdict ? ` (${n.latestVerdict})` : ''}${agent ? ` [agent ${agent.ref}]` : ''}${n.error ? ` error="${n.error}"` : ''}`;
      })
      .join('\n');
    scopeLines.push(`- scope ${scope.scopeKey} [${scope.status}]\n${nodes}`);
  }
  lines.push(`## Scopes\n${scopeLines.join('\n')}`);

  const assessments = Object.values(state.assessments).filter((a) => !a.stale).slice(-5);
  if (assessments.length > 0) {
    lines.push(
      `## Recent Assessments\n${assessments
        .map(
          (a) =>
            `- ${a.nodeId}: ${a.verdict} - ${a.summary}${a.findings
              .slice(0, 5)
              .map((f) => `\n  - [${f.severity}] ${f.filePath ? `(${f.filePath}) ` : ''}${f.message}`)
              .join('')}`
        )
        .join('\n')}`
    );
  }

  const pendingWaits = Object.values(state.waitRequests).filter((w) => w.status === 'PENDING');
  if (pendingWaits.length > 0) {
    lines.push(
      `## Pending Questions\n${pendingWaits
        .map((w) => `- requestId=${w.requestId} node=${w.nodeId}: ${w.prompt}`)
        .join('\n')}`
    );
  }

  lines.push(
    `## Allowed Commands (max level: ${policy.maxLevel})\n${input.allowedCommands
      .map((kind) => `- ${COMMAND_SHAPES[kind]}`)
      .join('\n')}`
  );
  lines.push(
    [
      '## Rules',
      '- You control HOW work proceeds, never WHAT counts as done: acceptance criteria, verdicts, human gates and write scopes are out of your reach.',
      '- Prefer the least invasive command; return no commands when no intervention is needed.',
      '- Escalate to a human when the problem needs a product or risk decision.',
      ...(trigger.kind === 'user.message'
        ? [
            '- A human is talking to you: always answer them in `reply`, briefly and in their language, based on the run state above.',
            '- Only issue commands when they ask for an action or the run clearly needs one; say in `reply` what you did or could not do.',
          ]
        : []),
    ].join('\n')
  );
  lines.push(
    'Respond with exactly one fenced block:\n```ua-chief-decision\n{"rationale":"why","reply":"what you tell the human (optional unless answering a message)","commands":[...]}\n```'
  );

  return lines.join('\n\n');
}

function extractDecisionJson(text: string): unknown {
  const fenced = [
    ...text.matchAll(/```(?:ua-chief-decision|json)[^\r\n]*\r?\n([\s\S]*?)\r?\n```/gi),
  ];
  const candidates = [...fenced.map((m) => m[1] ?? '').reverse(), text];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Parses a chief reply; anything unusable becomes a no-op decision explaining why. */
export function parseChiefDecision(raw: unknown): ChiefDecision {
  const value = typeof raw === 'string' ? extractDecisionJson(raw) : raw;
  const parsed = ChiefDecisionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return {
    rationale: `Chief reply could not be parsed as a decision: ${
      typeof raw === 'string' ? raw.slice(0, 200) : JSON.stringify(raw)?.slice(0, 200)
    }`,
    commands: [],
  };
}

const DENY_ALL_READER: ScopedArtifactReader = {
  async readPage(artifactId) {
    throw new Error(`The chief cannot read artifact "${artifactId}"; use the briefing instead`);
  },
  getRemainingQuotaBytes: () => 0,
  getReceipts: () => [],
};

/**
 * Runs the chief as an ordinary agent: renders the briefing, executes it on the chief's
 * adapter as a read-only task, and parses the `ua-chief-decision` block from the reply.
 */
export class AgentChiefSupervisor implements ChiefSupervisor {
  async review(input: ChiefReviewInput): Promise<ChiefDecision> {
    const prompt = renderChiefBriefing(input);
    const node: AgentNode = {
      kind: 'agent',
      id: '$chief',
      name: input.chiefAgent?.profile.name ?? 'Chief',
      role: 'chief',
      ...(input.chiefAgent ? { agentRef: input.chiefAgent.ref } : {}),
      goal: 'Decide whether and how to intervene in the workflow run',
      inputs: [],
      outputs: [{ name: 'decision', type: 'json', required: true }],
      writeScopes: [],
      maxTechnicalRetries: 0,
      acceptanceCriteria: [],
      constraints: [],
      producesAssessment: false,
      readWorkspaces: [],
    };
    const attemptId = `chief_${input.state.runId}_${input.state.revision}`;
    const manifest: ContextManifest = {
      manifestId: `${attemptId}_manifest`,
      ...(input.chiefAgent
        ? { agent: { ref: input.chiefAgent.ref, digest: input.chiefAgent.digest } }
        : {}),
      runId: input.state.runId,
      nodeId: node.id,
      attemptId,
      scopeKey: '$root',
      goal: node.goal,
      acceptanceCriteria: [],
      constraints: [],
      entries: [],
      authorizedArtifactIds: [],
      totalInlineBytes: 0,
      initialBudgetBytes: 0,
      pageReadBytes: 0,
      stageReadQuotaBytes: 0,
      createdAtMs: 0,
    };

    const result = await input.adapter.executeAgent({
      runId: input.state.runId,
      scopeKey: '$root',
      attemptId,
      invocationId: attemptId,
      node,
      ...(input.chiefAgent ? { agent: input.chiefAgent } : {}),
      manifest,
      renderedPrompt: prompt,
      inputs: {},
      artifactReader: DENY_ALL_READER,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parseChiefDecision(result.outputs?.decision ?? result.outputs?.output);
  }
}
