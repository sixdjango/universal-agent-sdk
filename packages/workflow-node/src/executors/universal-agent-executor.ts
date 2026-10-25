import {
  ConversationRecorder,
  MemoryConversationStore,
  type ConversationStore,
  isAcpThoughtLevelConfigOption,
  type ACPSessionId,
  type AgentLaunchTarget,
  type BuiltinAgentType,
  type MessageContent,
  type RegistryAgentId,
  type SessionHistoryEntry,
  startAgentSession,
  type StartAgentSessionOptions,
} from '@universal-agent/client';
import type {
  AssessmentFinding,
  AssessmentVerdict,
  ThinkingStep,
  ThinkingStepPill,
} from '@universal-agent/workflow-contract';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  Executor,
  ScriptExecutionRequest,
  ScriptExecutionResult,
} from '@universal-agent/workflow-runtime';
import { ArtifactToolHost } from '../artifact-tools/host';
import { ARTIFACT_MCP_SERVER_NAME } from '../artifact-tools/tools';
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

type AcpPermissionHandler = StartAgentSessionOptions['onRequestPermission'];
type PermissionToolCall = Parameters<AcpPermissionHandler>[1]['toolCall'];

export interface WorkflowPermissionContext {
  readonly runId: string;
  readonly scopeKey: string;
  readonly nodeId: string;
  readonly attemptId: string;
  /** Includes fields from earlier tool updates when the permission request is partial. */
  readonly toolCall: PermissionToolCall;
  readonly signal?: AbortSignal;
}

export interface ChiefPermissionOptions {
  /** Native read capabilities to allow; default ['read', 'search', 'think']. [] disables them. */
  readonly allowedToolKinds?: readonly ('read' | 'search' | 'think')[];
  /** Allow mounted, run-scoped artifact read tools (default true). */
  readonly allowArtifactReads?: boolean;
  /** Exact tool names the host guarantees are read-only, including MCP-qualified names. */
  readonly additionalReadOnlyTools?: readonly string[];
}

export interface UniversalAgentExecutorOptions {
  readonly workdir: string;
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Map from node `role` (or `node.id`) to a concrete `@universal-agent/client` launch target. */
  readonly roleBindings?: Readonly<Record<string, RoleBindingTarget>>;
  readonly defaultTarget?: RoleBindingTarget;
  /** Host policy may further restrict the chief ceiling. Existing two-argument callbacks still work. */
  readonly onRequestPermission?: (
    requestId: Parameters<AcpPermissionHandler>[0],
    request: Parameters<AcpPermissionHandler>[1],
    context: WorkflowPermissionContext,
  ) => ReturnType<AcpPermissionHandler>;
  readonly chiefPermissions?: ChiefPermissionOptions;
  /** Shared unified history. Node runtime supplies SQLite; direct executors default to memory. */
  readonly conversationStore?: ConversationStore;
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

function fileBadge(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'TSX';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'TS';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'JS';
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'MD';
  if (lower.endsWith('.css') || lower.endsWith('.scss')) return 'CSS';
  if (lower.endsWith('.py')) return 'PY';
  if (lower.endsWith('.sh') || lower.endsWith('.zsh')) return 'SH';
  if (lower.endsWith('.sql')) return 'SQL';
  return 'FILE';
}

function baseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function cleanThoughtLine(raw: string): string {
  return raw
    .replace(/^[\s#*>-]+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitThoughtLines(text: string): string[] {
  const blocks = text
    .split(/\n+/)
    .map(cleanThoughtLine)
    .filter((line) => line.length >= 6 && !line.startsWith('```') && !line.startsWith('{'));
  if (blocks.length === 0) return [];
  if (blocks.length <= 3) return blocks.map((b) => (b.length > 88 ? `${b.slice(0, 87)}…` : b));
  return [
    blocks[0]!,
    blocks[Math.floor(blocks.length / 2)]!,
    blocks[blocks.length - 1]!,
  ].map((b) => (b.length > 88 ? `${b.slice(0, 87)}…` : b));
}

function buildStepsFromHistory(
  history: readonly SessionHistoryEntry[],
  request: AgentExecutionRequest,
  startTime: number,
  finished: boolean
): ThinkingStep[] {
  const steps: ThinkingStep[] = [];
  const inputPills: ThinkingStepPill[] = request.manifest.entries.map((entry) => ({
    label: entry.portName,
    badge: entry.mode === 'artifact_ref' ? 'ART' : 'IN',
  }));
  if (request.node.id !== '$chief') {
    steps.push({
      id: `${request.attemptId}:context`,
      kind: 'read',
      status: 'done',
      label:
        inputPills.length > 0
          ? `Prepared ${inputPills.length} input${inputPills.length === 1 ? '' : 's'}`
          : 'Prepared context & workspace',
      ...(inputPills.length > 0 ? { pills: inputPills } : {}),
      startedAtMs: startTime,
      completedAtMs: startTime,
    });
  } else {
    steps.push({
      id: `${request.attemptId}:inspect`,
      kind: 'read',
      status: 'done',
      label: 'Inspected run state & active scopes',
      startedAtMs: startTime,
      completedAtMs: startTime,
    });
  }

  const latestAssistant = [...history].reverse().find((h) => h.role === 'assistant');
  const items: readonly MessageContent[] = latestAssistant?.items ?? [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isLastItem = i === items.length - 1;

    if (item.type === 'thought') {
      const lines = splitThoughtLines(item.text);
      lines.forEach((line, idx) => {
        const running = !finished && isLastItem && idx === lines.length - 1;
        steps.push({
          id: `${request.attemptId}:thought:${i}:${idx}`,
          kind: 'think',
          status: running ? 'running' : 'done',
          label: line,
        });
      });
      continue;
    }

    if (item.type === 'tool_call') {
      const kind = item.kind ?? 'other';
      // Group consecutive read tool calls into one "Reading X of Y files" / "Read Y files" step
      if (kind === 'read') {
        const group: Extract<MessageContent, { type: 'tool_call' }>[] = [item];
        while (i + 1 < items.length) {
          const next = items[i + 1]!;
          if (next.type === 'tool_call' && (next.kind ?? 'other') === 'read') {
            group.push(next);
            i += 1;
          } else {
            break;
          }
        }
        const pills: ThinkingStepPill[] = [];
        const seenPaths = new Set<string>();
        for (const call of group) {
          for (const loc of call.locations ?? []) {
            if (!seenPaths.has(loc.path)) {
              seenPaths.add(loc.path);
              pills.push({ label: baseName(loc.path), badge: fileBadge(loc.path), path: loc.path });
            }
          }
          if ((!call.locations || call.locations.length === 0) && call.title) {
            const cleaned = call.title.replace(/^(read|reading|view|viewing)\s+/i, '').trim();
            if (cleaned && !seenPaths.has(cleaned)) {
              seenPaths.add(cleaned);
              pills.push({ label: baseName(cleaned), badge: fileBadge(cleaned), path: cleaned });
            }
          }
        }
        const total = group.length;
        const completedCount = group.filter((c) => c.status === 'completed' || c.status === 'failed').length;
        const anyRunning = !finished && group.some((c) => c.status === 'pending' || c.status === 'in_progress');
        const anyFailed = group.some((c) => c.status === 'failed');
        const label = anyRunning
          ? total > 1
            ? `Reading ${Math.min(completedCount + 1, total)} of ${total} files`
            : `Reading ${pills[0]?.label ?? 'file'}`
          : total > 1
            ? `Read ${total} files`
            : `Read ${pills[0]?.label ?? (group[0]?.title || 'file')}`;
        steps.push({
          id: `${request.attemptId}:read:${group[0]!.toolCallId}`,
          kind: 'read',
          status: anyFailed ? 'failed' : anyRunning ? 'running' : 'done',
          label,
          ...(pills.length > 0 ? { pills } : {}),
        });
        continue;
      }

      const running = !finished && (item.status === 'pending' || item.status === 'in_progress');
      const failed = item.status === 'failed';
      const pills: ThinkingStepPill[] = (item.locations ?? []).map((loc) => ({
        label: baseName(loc.path),
        badge: fileBadge(loc.path),
        path: loc.path,
      }));
      const rawTitle = (item.title ?? '').trim();

      if (kind === 'search') {
        steps.push({
          id: `${request.attemptId}:search:${item.toolCallId}`,
          kind: 'search',
          status: failed ? 'failed' : running ? 'running' : 'done',
          label: running ? (rawTitle || 'Searching the codebase') : (rawTitle ? rawTitle.replace(/^Searching/i, 'Searched') : 'Searched the codebase'),
          ...(pills.length > 0 ? { pills } : {}),
        });
      } else if (kind === 'edit' || kind === 'write' || kind === 'delete' || kind === 'move') {
        steps.push({
          id: `${request.attemptId}:edit:${item.toolCallId}`,
          kind: 'edit',
          status: failed ? 'failed' : running ? 'running' : 'done',
          label: running
            ? rawTitle || `Editing ${pills[0]?.label ?? 'files'}`
            : rawTitle || `Edited ${pills[0]?.label ?? 'files'}`,
          ...(pills.length > 0 ? { pills } : {}),
        });
      } else {
        steps.push({
          id: `${request.attemptId}:tool:${item.toolCallId}`,
          kind: kind === 'execute' || kind === 'bash' ? 'execute' : 'think',
          status: failed ? 'failed' : running ? 'running' : 'done',
          label: rawTitle || (running ? 'Running tool' : 'Completed tool call'),
          ...(pills.length > 0 ? { pills } : {}),
        });
      }
      continue;
    }

    if (item.type === 'plan') {
      const anyRunning = !finished && item.entries.some((e) => e.status === 'in_progress' || e.status === 'pending');
      steps.push({
        id: `${request.attemptId}:plan:${i}`,
        kind: 'plan',
        status: anyRunning ? 'running' : 'done',
        label: anyRunning ? 'Planning execution steps' : `Planned ${item.entries.length} step${item.entries.length === 1 ? '' : 's'}`,
        subItems: item.entries.slice(0, 5).map((entry, idx) => ({
          id: `plan-${i}-${idx}`,
          text: entry.content,
          status: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'running' : 'done',
        })),
      });
      continue;
    }

    if (item.type === 'text' && item.text.trim().length > 0) {
      const running = !finished && isLastItem;
      const draftLabel =
        request.node.id === '$chief'
          ? running
            ? 'Formulating chief decision'
            : 'Formulated chief decision'
          : request.node.producesAssessment
            ? running
              ? 'Evaluating acceptance criteria & verdict'
              : 'Evaluated acceptance criteria'
            : running
              ? `Drafting ${request.node.outputs[0]?.name ?? 'output'}`
              : `Drafted ${request.node.outputs[0]?.name ?? 'output'}`;
      steps.push({
        id: `${request.attemptId}:draft:${i}`,
        kind: 'draft',
        status: running ? 'running' : 'done',
        label: draftLabel,
      });
    }
  }

  if (!finished && steps.every((s) => s.status !== 'running')) {
    steps.push({
      id: `${request.attemptId}:thinking`,
      kind: 'think',
      status: 'running',
      label:
        request.node.id === '$chief'
          ? 'Evaluating run state'
          : request.node.producesAssessment
            ? 'Checking acceptance criteria'
            : `Working on "${request.node.name}"`,
    });
  }

  return steps;
}

export class UniversalAgentExecutor implements Executor {
  readonly conversationStore: ConversationStore;
  private readonly options: UniversalAgentExecutorOptions;
  private readonly scriptExecutor: NodeScriptExecutor;
  private readonly artifactTools: ArtifactToolHost | null;
  private readonly chiefToolKinds: ReadonlySet<string>;
  private readonly chiefReadOnlyTools: ReadonlySet<string>;
  private readonly chiefArtifactReads: boolean;

  constructor(options: UniversalAgentExecutorOptions) {
    this.options = options;
    const kinds = options.chiefPermissions?.allowedToolKinds ?? ['read', 'search', 'think'];
    if (kinds.some(kind => !['read', 'search', 'think'].includes(kind))) {
      throw new TypeError('chiefPermissions.allowedToolKinds accepts only read, search and think');
    }
    this.chiefToolKinds = new Set(kinds);
    this.chiefReadOnlyTools = new Set(options.chiefPermissions?.additionalReadOnlyTools ?? []);
    this.chiefArtifactReads = options.chiefPermissions?.allowArtifactReads ?? true;
    this.conversationStore = options.conversationStore ?? new MemoryConversationStore();
    const artifactTools = options.artifactTools === false ? null : (options.artifactTools ?? new ArtifactToolHost());
    this.scriptExecutor = new NodeScriptExecutor({
      ...(artifactTools ? { tools: artifactTools } : {}),
      defaultWorkdir: options.workdir,
      defaultEnv: options.env,
      ...(options.captureChanges !== undefined ? { captureChanges: options.captureChanges } : {}),
    });
    this.artifactTools = artifactTools;
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
    let promptText = request.renderedPrompt;
    if (request.humanAnswer) {
      const answer = typeof request.humanAnswer.answer === 'string' ? request.humanAnswer.answer : JSON.stringify(request.humanAnswer.answer);
      promptText += `\n\n## Resolved Human Decision (from ${request.humanAnswer.responderId})\n${answer}`;
    }
    const recorder = await ConversationRecorder.create({
      store: this.conversationStore,
      agent: {
        target: binding.target, agentType: binding.agentType === 'dsh' ? 'deepseek' : binding.agentType,
        workdir: request.workspace?.path ?? this.options.workdir,
        modelId: request.node.modelId ?? binding.modelId, modeId: request.node.modeId ?? binding.modeId,
      },
      source: { namespace: 'workflow', identifiers: {
        runId: request.runId, scopeKey: request.scopeKey, nodeId: request.node.id,
        attemptId: request.attemptId, invocationId: request.invocationId,
        retryIndex: String(request.retryIndex ?? 0),
        ...(request.roundIndex !== undefined ? { roundIndex: String(request.roundIndex) } : {}),
      } },
      content: [{ type: 'text', text: promptText }], signal: request.signal,
    });
    return recorder.run(() => this.executeRecordedAgent(request, binding, promptText, recorder));
  }

  private async executeRecordedAgent(
    request: AgentExecutionRequest, binding: RoleBindingTarget, promptText: string, recorder: ConversationRecorder,
  ): Promise<AgentExecutionResult> {
    const startTime = Date.now();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    const writtenFiles: { path: string; bytesWritten: number }[] = [];
    // Some adapters send only the toolCallId with a permission request. Retain the
    // preceding tool update so a scoped artifact read can still be identified.
    const toolCalls = new Map<string, PermissionToolCall>();

    const modelId = request.node.modelId ?? binding.modelId;
    const effort = request.node.effort ?? binding.effort;
    const effectiveAgentType = binding.agentType === 'dsh' ? 'deepseek' : binding.agentType;
    const workdir = request.workspace?.path ?? this.options.workdir;
    // Only writing steps can change the workspace (read-only ones are refused writes).
    const before =
      this.options.captureChanges !== false && !request.isolated && request.node.writeScopes.length > 0
        ? await snapshotWorkingTree(workdir)
        : null;
    // Step tools: its artifacts and its data, as MCP tools and, for its shell, the CLI.
    const tools =
      this.artifactTools && (request.data || request.manifest.authorizedArtifactIds.length > 0)
        ? this.artifactTools.register({
            manifest: request.manifest,
            reader: request.artifactReader,
            ...(request.data ? { data: request.data } : {}),
          })
        : null;
    const artifactTools = this.artifactTools;
    const toolEnv =
      tools && artifactTools
        ? await artifactTools.cliEnv(tools.token, binding.env?.PATH ?? this.options.env?.PATH ?? process.env.PATH ?? '')
        : {};
    let session: Awaited<ReturnType<typeof startAgentSession>>;
    try {
      session = await startAgentSession(recorder.wrapSessionOptions({
        target: binding.target,
        agentType: effectiveAgentType,
        executablePath: binding.executablePath,
        workdir,
        dataDir: this.options.dataDir,
        concurrency: 6,
        ...(tools && artifactTools
          ? { resolveMcpServers: (capabilities: { http: boolean }) => artifactTools.mcpServers(tools.token, capabilities) }
          : {}),
        env: {
          ...this.options.env,
          ...binding.env,
          ...toolEnv,
        },
        modelId,
        modeId: request.node.modeId ?? binding.modeId,
        resumeSessionId: request.resumeSessionBinding?.acpSessionId as ACPSessionId | undefined,
        signal: request.signal,
        onRequestPermission: async (reqId, permReq) => {
          const reject = () => {
            const option = permReq.options?.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');
            return option
              ? { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
              : { outcome: { outcome: 'cancelled' as const } };
          };
          const toolCall = { ...toolCalls.get(permReq.toolCall.toolCallId), ...permReq.toolCall };
          const toolKind = toolCall.kind;
          if (request.node.id === '$chief') {
            // A chief delegates repairs through runtime commands. Empty writeScopes alone
            // would still allow shell commands and unknown MCP tools to mutate the workspace.
            const name = (toolCall as { name?: string }).name ?? toolCall.title;
            const raw = toolCall.rawInput as { server?: string; tool?: string } | undefined;
            const artifactRead = ['list_context_inputs', 'read_artifact'].some(tool =>
              name === `${ARTIFACT_MCP_SERVER_NAME}.${tool}` || name === `mcp__${ARTIFACT_MCP_SERVER_NAME}__${tool}`
              || (name === `mcp.${ARTIFACT_MCP_SERVER_NAME}.${tool}` && raw?.server === ARTIFACT_MCP_SERVER_NAME && raw.tool === tool));
            const toolInvocation = toolKind === 'other' || toolKind === 'execute' || toolKind == null;
            const nativeRead = toolKind != null && this.chiefToolKinds.has(toolKind);
            const namedRead = toolInvocation || toolKind === 'read' || toolKind === 'search' || toolKind === 'think';
            const readOnly = artifactRead
              ? Boolean(tools && this.chiefArtifactReads && namedRead)
              : nativeRead || (namedRead && name != null && this.chiefReadOnlyTools.has(name));
            if (!readOnly) return reject();
          }
          if (this.options.onRequestPermission) return this.options.onRequestPermission(reqId, permReq, {
            runId: request.runId, scopeKey: request.scopeKey, nodeId: request.node.id,
            attemptId: request.attemptId, toolCall, ...(request.signal ? { signal: request.signal } : {}),
          });
          const isReadOnlyNode = request.node.writeScopes.length === 0;
          if (isReadOnlyNode && (toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move')) {
            return reject();
          }
          const allowOpt = permReq.options?.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
          return allowOpt
            ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
            : { outcome: { outcome: 'cancelled' } };
        },
        onUpdateMessage: ({ update }) => {
          if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            toolCalls.set(update.toolCallId, { ...toolCalls.get(update.toolCallId), ...update });
          }
        },
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
        onHistoryChange: (history) => {
          if (request.onProgress) {
            request.onProgress(buildStepsFromHistory(history, request, startTime, false));
          }
        },
        onWriteTextFile: (evidence) => {
          writtenFiles.push({ path: evidence.path, bytesWritten: evidence.newText.length });
        },
      }));
    } catch (err) {
      tools?.release();
      throw err;
    }

    try {
      await recorder.attach(session, request.resumeSessionBinding?.acpSessionId);
      if (effort) await applyEffort(session, effort);
      recorder.beginPrompt();
      const response = await session.prompt([{ type: 'text', text: promptText }], {
        signal: recorder.signal,
      });
      recorder.setResponse(response);
      recorder.signal.throwIfAborted();

      // Streamed content can look complete even when the turn was cancelled or truncated.
      // Only a confirmed end_turn may publish outputs, assessments, or a wait request.
      if (request.signal?.aborted || response?.stopReason === 'cancelled') {
        throw new DOMException(`AgentNode "${request.node.id}" prompt aborted`, 'AbortError');
      }
      if (!response) {
        throw new Error(`AgentNode "${request.node.id}" ended without a prompt response`);
      }
      if (response.stopReason !== 'end_turn') {
        throw new Error(
          `AgentNode "${request.node.id}" did not complete its turn (stopReason: ${response.stopReason})`
        );
      }

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
      const finalSteps = buildStepsFromHistory(session.getHistory(), request, startTime, true);
      const receipt = {
        attemptId: request.attemptId,
        conversationId: recorder.conversationId,
        conversationTurnId: recorder.turnId,
        sessionId: session.sessionId,
        acpSessionId: session.acpSessionId,
        agentType: binding.agentType ?? binding.target?.agentType ?? request.node.role,
        ...(modelId ? { modelId } : {}),
        ...(effort ? { effort } : {}),
        ...(totalInputTokens > 0 ? { inputTokens: totalInputTokens } : {}),
        ...(totalOutputTokens > 0 ? { outputTokens: totalOutputTokens } : {}),
        ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
        ...(finalSteps.length > 0 ? { steps: finalSteps } : {}),
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
      // Cancellation can also arrive while capturing changes or shutting down the session.
      request.signal?.throwIfAborted();
    }
  }

  async executeScript(request: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    return await this.scriptExecutor.executeScript(request);
  }
}
