import {
  isAcpThoughtLevelConfigOption,
  type ACPSessionId,
  type AgentLaunchTarget,
  type BuiltinAgentType,
  type RegistryAgentId,
  startAgentSession,
  type StartAgentSessionOptions,
} from '@universal-agent/client';
import type { AssessmentFinding, AssessmentVerdict } from '@universal-agent/workflow-contract';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  Executor,
  ScriptExecutionRequest,
  ScriptExecutionResult,
} from '@universal-agent/workflow-runtime';
import { ArtifactToolHost } from '../artifact-tools/host';
import { diffSinceSnapshot, snapshotWorkingTree } from '../workspace/change-capture';
import { NodeScriptExecutor } from './script-executor';

export interface RoleBindingTarget {
  readonly target?: AgentLaunchTarget;
  readonly agentType?: BuiltinAgentType | RegistryAgentId | 'custom' | (string & {});
  readonly executablePath?: string;
  readonly modelId?: string;
  readonly modeId?: string;
  /** Reasoning effort, applied to the session's thought-level option. */
  readonly effort?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface UniversalAgentExecutorOptions {
  readonly workdir: string;
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Map from node `role` (or `node.id`) to a concrete `@universal-agent/client` launch target. */
  readonly roleBindings?: Readonly<Record<string, RoleBindingTarget>>;
  readonly defaultTarget?: RoleBindingTarget;
  readonly onRequestPermission?: StartAgentSessionOptions['onRequestPermission'];
  /**
   * Serves artifacts handed to a step as `ua-workflow` MCP tools (`read_artifact`, ...).
   * Defaults to a private host; pass `false` to not mount the tools.
   */
  readonly artifactTools?: ArtifactToolHost | false;
  /** Record a git diff of what writing steps changed in their workspace (default true). */
  readonly captureChanges?: boolean;
}

interface ParsedWorkflowEnvelope {
  outputs?: Record<string, unknown>;
  artifacts?: Record<string, { content: string; mediaType?: string; summary?: string }>;
  assessment?: {
    verdict: AssessmentVerdict;
    summary: string;
    findings?: AssessmentFinding[];
  };
  waitRequest?: {
    prompt: string;
    options?: { value: string; label: string; description?: string }[];
    requiredRole?: string;
  };
}

function tryParseEnvelopeJson(candidate: string): ParsedWorkflowEnvelope | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      'outputs' in parsed ||
      'artifacts' in parsed ||
      'assessment' in parsed ||
      'waitRequest' in parsed
    ) {
      return parsed as ParsedWorkflowEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts either a fenced ```ua-workflow-result ... ``` JSON block (prioritizing the last
 * explicit `ua-workflow-result` block, then the last `json` block) or a raw JSON envelope
 * if the Agent emitted structured workflow output, falling back to plain assistant text.
 */
function parseStructuredWorkflowResponse(assistantText: string): ParsedWorkflowEnvelope | null {
  const explicitMatches = [
    ...assistantText.matchAll(/```ua-workflow-result[^\r\n]*\r?\n([\s\S]*?)\r?\n```/gi),
  ];
  for (let i = explicitMatches.length - 1; i >= 0; i--) {
    const env = tryParseEnvelopeJson(explicitMatches[i]![1] ?? '');
    if (env) return env;
  }

  const jsonMatches = [
    ...assistantText.matchAll(/```json[^\r\n]*\r?\n([\s\S]*?)\r?\n```/gi),
  ];
  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    const env = tryParseEnvelopeJson(jsonMatches[i]![1] ?? '');
    if (env) return env;
  }

  return tryParseEnvelopeJson(assistantText);
}

/**
 * Sets reasoning effort through the session's thought-level option, whatever the engine
 * calls it (`effort` on claude, `reasoning_effort` on codex, ...). Engines without one, or
 * that reject the value, keep their default rather than failing the step.
 */
async function applyEffort(
  session: { getConfigOptions(): { id: string; category?: string | null }[]; setConfigOption(id: string, value: string): Promise<unknown> },
  effort: string
): Promise<void> {
  const option = session.getConfigOptions().find((o) => isAcpThoughtLevelConfigOption({ id: o.id, ...(o.category ? { category: o.category } : {}) }));
  if (!option) return;
  await session.setConfigOption(option.id, effort).catch(() => undefined);
}

export class UniversalAgentExecutor implements Executor {
  private readonly options: UniversalAgentExecutorOptions;
  private readonly scriptExecutor: NodeScriptExecutor;
  private readonly artifactTools: ArtifactToolHost | null;

  constructor(options: UniversalAgentExecutorOptions) {
    this.options = options;
    this.scriptExecutor = new NodeScriptExecutor({
      defaultWorkdir: options.workdir,
      defaultEnv: options.env,
      ...(options.captureChanges !== undefined ? { captureChanges: options.captureChanges } : {}),
    });
    this.artifactTools = options.artifactTools === false ? null : (options.artifactTools ?? new ArtifactToolHost());
  }

  private resolveBinding(request: AgentExecutionRequest): RoleBindingTarget {
    const byId = this.options.roleBindings?.[request.node.id];
    if (byId) return byId;
    // A step can pick another client than its agent's; the agent's model belongs to the
    // agent's own client, so it is not carried over.
    if (request.agent && request.node.agentType && request.node.agentType !== request.agent.profile.runtime.agentType) {
      return { agentType: request.node.agentType };
    }
    // A delegated agent brings its own engine choice; host bindings keyed by agent id
    // (executable paths, env) still win when present.
    if (request.agent) {
      const agentRuntime = request.agent.profile.runtime;
      const byAgent = this.options.roleBindings?.[request.agent.agentId];
      if (byAgent) {
        return {
          ...byAgent,
          modelId: byAgent.modelId ?? agentRuntime.modelId,
          modeId: byAgent.modeId ?? agentRuntime.modeId,
          effort: byAgent.effort ?? agentRuntime.effort,
        };
      }
      if (agentRuntime.agentType) {
        return {
          agentType: agentRuntime.agentType,
          modelId: agentRuntime.modelId,
          modeId: agentRuntime.modeId,
          effort: agentRuntime.effort,
        };
      }
    }
    const byRole = this.options.roleBindings?.[request.node.role];
    if (byRole) return byRole;
    if (request.node.agentType) {
      return {
        agentType: request.node.agentType,
        modelId: request.node.modelId,
        modeId: request.node.modeId,
      };
    }
    if (this.options.defaultTarget) {
      return this.options.defaultTarget;
    }
    return {
      agentType: request.node.role,
      modelId: request.node.modelId,
      modeId: request.node.modeId,
    };
  }

  async executeAgent(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const binding = this.resolveBinding(request);
    const startTime = Date.now();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    const writtenFiles: { path: string; bytesWritten: number }[] = [];

    const modelId = request.node.modelId ?? binding.modelId;
    const effort = request.node.effort ?? binding.effort;
    const effectiveAgentType = binding.agentType === 'dsh' ? 'deepseek' : binding.agentType;
    const workdir = request.workspace?.path ?? this.options.workdir;
    // Only writing steps can change the workspace (read-only ones are refused writes).
    const before =
      this.options.captureChanges !== false && !request.isolated && request.node.writeScopes.length > 0
        ? await snapshotWorkingTree(workdir)
        : null;
    const tools =
      this.artifactTools && request.manifest.authorizedArtifactIds.length > 0
        ? this.artifactTools.register({ manifest: request.manifest, reader: request.artifactReader })
        : null;
    const artifactTools = this.artifactTools;
    let session: Awaited<ReturnType<typeof startAgentSession>>;
    try {
      session = await startAgentSession({
        target: binding.target,
        agentType: effectiveAgentType,
        executablePath: binding.executablePath,
        workdir,
        dataDir: this.options.dataDir,
        ...(tools && artifactTools
          ? { resolveMcpServers: (capabilities: { http: boolean }) => artifactTools.mcpServers(tools.token, capabilities) }
          : {}),
        env: {
          ...this.options.env,
          ...binding.env,
        },
        modelId,
        modeId: request.node.modeId ?? binding.modeId,
        resumeSessionId: request.resumeSessionBinding?.acpSessionId as ACPSessionId | undefined,
        signal: request.signal,
        onRequestPermission:
          this.options.onRequestPermission ??
          (async (_reqId, permReq) => {
            const isReadOnlyNode = request.node.writeScopes.length === 0;
            const toolKind = permReq.toolCall?.kind;
            if (
              isReadOnlyNode &&
              (toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move')
            ) {
              const rejectOpt = permReq.options?.find(
                (o) => o.kind === 'reject_once' || o.kind === 'reject_always'
              );
              if (rejectOpt) {
                return { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } };
              }
              return { outcome: { outcome: 'cancelled' } };
            }
            const allowOpt = permReq.options?.find(
              (o) => o.kind === 'allow_once' || o.kind === 'allow_always'
            );
            if (allowOpt) {
              return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
            }
            return { outcome: { outcome: 'cancelled' } };
          }),
        onUsageUpdate: (usage) => {
          if (typeof usage.usage?.inputTokens === 'number') {
            totalInputTokens = Math.max(totalInputTokens, usage.usage.inputTokens);
          }
          if (typeof usage.usage?.outputTokens === 'number') {
            totalOutputTokens = Math.max(totalOutputTokens, usage.usage.outputTokens);
          }
          if (typeof usage.usage?.costUSD === 'number') {
            totalCostUsd = Math.max(totalCostUsd, usage.usage.costUSD);
          }
        },
        onWriteTextFile: (evidence) => {
          writtenFiles.push({ path: evidence.path, bytesWritten: evidence.newText.length });
        },
      });
    } catch (err) {
      tools?.release();
      throw err;
    }

    try {
      if (effort) await applyEffort(session, effort);
      let promptText = request.renderedPrompt;
      if (request.humanAnswer) {
        const formattedAnswer =
          typeof request.humanAnswer.answer === 'string'
            ? request.humanAnswer.answer
            : JSON.stringify(request.humanAnswer.answer);
        promptText += `\n\n## Resolved Human Decision (from ${request.humanAnswer.responderId})\n${formattedAnswer}`;
      }

      await session.prompt([{ type: 'text', text: promptText }]);

      if (request.node.writeScopes.length === 0 && writtenFiles.length > 0) {
        throw new Error(
          `Read-only AgentNode "${request.node.id}" (writeScopes: []) attempted to modify file(s): ${writtenFiles
            .map((f) => f.path)
            .join(', ')}`
        );
      }

      const assistantItems = session.getLatestAssistantItems();
      const assistantText = assistantItems
        .filter(
          (item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text'
        )
        .map((item) => item.text)
        .join('\n')
        .trim();

      const durationMs = Math.max(0, Date.now() - startTime);
      const receipt = {
        attemptId: request.attemptId,
        sessionId: session.sessionId,
        acpSessionId: session.acpSessionId,
        agentType: binding.agentType ?? binding.target?.agentType ?? request.node.role,
        ...(modelId ? { modelId } : {}),
        ...(effort ? { effort } : {}),
        ...(totalInputTokens > 0 ? { inputTokens: totalInputTokens } : {}),
        ...(totalOutputTokens > 0 ? { outputTokens: totalOutputTokens } : {}),
        ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
        durationMs,
      };

      const changesCaptured = before ? await diffSinceSnapshot(before) : null;
      const changes = changesCaptured ? { changes: changesCaptured } : {};
      const structured = parseStructuredWorkflowResponse(assistantText);
      if (structured?.waitRequest) {
        return {
          status: 'WAIT_REQUESTED',
          waitRequest: structured.waitRequest,
          receipt,
          ...changes,
        };
      }

      if (structured) {
        return {
          status: 'COMPLETED',
          outputs: structured.outputs,
          artifacts: structured.artifacts,
          assessment: structured.assessment,
          receipt,
          ...changes,
        };
      }

      // Default mapping when Agent returns plain text/markdown: bind it to the first declared
      // output port. Verdicts are never guessed from free text; a reviewer that skipped the
      // structured block has no assessment, which the runtime treats as a failed review.
      const defaultOutPort = request.node.outputs[0]?.name ?? 'output';
      const defaultOutputs: Record<string, unknown> = {
        [defaultOutPort]: assistantText,
      };
      const defaultArtifacts: Record<
        string,
        { content: string; mediaType?: string; summary?: string }
      > = {};
      for (const outPort of request.node.outputs) {
        if (outPort.type === 'artifact') {
          defaultArtifacts[outPort.name] = {
            content: assistantText,
            mediaType: 'text/markdown',
            summary: assistantText.slice(0, 200),
          };
        }
      }

      return {
        status: 'COMPLETED',
        outputs: defaultOutputs,
        ...(Object.keys(defaultArtifacts).length > 0 ? { artifacts: defaultArtifacts } : {}),
        receipt,
        ...changes,
      };
    } finally {
      tools?.release();
      await session.shutdown();
    }
  }

  async executeScript(request: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    return await this.scriptExecutor.executeScript(request);
  }
}
