import type {
  AgentNode,
  ArtifactReadReceipt,
  CompiledGraphScope,
  ContextManifest,
  ContextPortEntry,
  ManifestWorkspace,
} from '@universal-agent/workflow-contract';
import type {
  ArtifactPageSlice,
  ArtifactStore,
  Clock,
  GraphScopeState,
  IdGenerator,
  PinnedAgent,
  PortValueRecord,
  ScopedArtifactReader,
} from '../ports';

export class UnauthorizedArtifactReadError extends Error {
  readonly attemptId: string;
  readonly artifactId: string;

  constructor(attemptId: string, artifactId: string) {
    super(
      `Attempt "${attemptId}" is not authorized to read artifact "${artifactId}". Only artifacts connected via incoming DataEdges in ContextManifest may be read.`
    );
    this.name = 'UnauthorizedArtifactReadError';
    this.attemptId = attemptId;
    this.artifactId = artifactId;
  }
}

export class ArtifactQuotaExceededError extends Error {
  readonly attemptId: string;
  readonly requestedBytes: number;
  readonly remainingQuotaBytes: number;

  constructor(attemptId: string, requestedBytes: number, remainingQuotaBytes: number) {
    super(
      `Attempt "${attemptId}" exceeded stage artifact read quota (requested ${requestedBytes} bytes, remaining ${remainingQuotaBytes} bytes)`
    );
    this.name = 'ArtifactQuotaExceededError';
    this.attemptId = attemptId;
    this.requestedBytes = requestedBytes;
    this.remainingQuotaBytes = remainingQuotaBytes;
  }
}

const DEFAULT_INITIAL_BUNDLE_BYTES = 32 * 1024;
const DEFAULT_PAGE_READ_BYTES = 8 * 1024;

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function serializeValue(val: unknown): string {
  if (typeof val === 'string') return val;
  return JSON.stringify(val, null, 2) ?? '';
}

export interface BuildContextBundleInput {
  readonly runId: string;
  readonly scopeKey: string;
  readonly attemptId: string;
  readonly node: AgentNode;
  readonly compiledScope: CompiledGraphScope;
  readonly scopeState: GraphScopeState;
  readonly artifactStore: ArtifactStore;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Agent the node is delegated to; its charter and instructions are always kept verbatim. */
  readonly agent?: PinnedAgent;
  readonly chiefGuidance?: readonly string[];
  /** Where the attempt works; rendered so the agent knows its root and what it may touch. */
  readonly workspace?: ManifestWorkspace;
  readonly priorRoundFeedback?: {
    readonly roundIndex: number;
    readonly verdict: string;
    readonly summary: string;
    readonly findings: readonly { severity: string; message: string; filePath?: string }[];
  };
}

export interface BuiltContextBundle {
  readonly manifest: ContextManifest;
  readonly resolvedInputs: Record<string, unknown>;
  readonly renderedPrompt: string;
}

/**
 * Builds an immutable `ContextManifest` and structured prompt by inspecting ONLY
 * the incoming `DataEdge`s declared for `node` in `compiledScope`.
 *
 * - Never truncates `goal`, `acceptanceCriteria`, or `constraints`.
 * - Enforces `initialBundleBytes`: values or artifacts that exceed remaining inline budget
 *   or specify `delivery: 'artifact_ref'` are converted into structured `ArtifactRef` cards
 *   with SHA-256, byte size, summary, and section index.
 */
export async function buildDataEdgeContextBundle(
  input: BuildContextBundleInput
): Promise<BuiltContextBundle> {
  const { node, compiledScope, scopeState, artifactStore, clock, idGenerator } = input;
  const budgetConfig = node.contextBudget;
  const initialBudgetBytes = budgetConfig?.initialBundleBytes ?? DEFAULT_INITIAL_BUNDLE_BYTES;
  const pageReadBytes = budgetConfig?.pageReadBytes ?? DEFAULT_PAGE_READ_BYTES;
  const stageReadQuotaBytes = budgetConfig?.stageReadQuotaBytes;

  // Fixed header cost (identity, goal, criteria, constraints and chief guidance are 100% preserved)
  const fixedHeaderText = [
    input.agent?.profile.charter ?? '',
    ...(input.agent?.profile.instructions ?? []),
    ...(input.chiefGuidance ?? []),
    node.goal,
    ...node.acceptanceCriteria,
    ...node.constraints,
    node.promptTemplate ?? '',
  ].join('\n');
  let usedInlineBytes = utf8ByteLength(fixedHeaderText);

  const incomingEdges = compiledScope.incomingDataEdges[node.id] ?? [];
  const entries: ContextPortEntry[] = [];
  const authorizedArtifactIds = new Set<string>();
  const resolvedInputs: Record<string, unknown> = {};

  for (const dataEdge of incomingEdges) {
    let sourcePortRecord: PortValueRecord | undefined;
    if (dataEdge.fromNodeId === '$input') {
      sourcePortRecord = scopeState.inputs[dataEdge.fromPort];
    } else {
      const upstreamNodeState = scopeState.nodes[dataEdge.fromNodeId];
      sourcePortRecord = upstreamNodeState?.outputs[dataEdge.fromPort];
    }

    if (!sourcePortRecord) {
      const portDef = node.inputs.find((p) => p.name === dataEdge.toPort);
      if (portDef?.defaultValue !== undefined) {
        sourcePortRecord = { value: portDef.defaultValue };
      } else {
        continue;
      }
    }

    resolvedInputs[dataEdge.toPort] = sourcePortRecord.value;

    let artifactId = sourcePortRecord.artifactId;
    if (artifactId) {
      authorizedArtifactIds.add(artifactId);
    }

    const serialized = serializeValue(sourcePortRecord.value);
    const valueBytes = utf8ByteLength(serialized);
    const remainingBudget = Math.max(0, initialBudgetBytes - usedInlineBytes);

    const shouldForceRef =
      dataEdge.delivery === 'artifact_ref' ||
      (dataEdge.delivery === 'auto' && valueBytes > remainingBudget);

    if (shouldForceRef) {
      let meta = artifactId ? await artifactStore.getMeta(artifactId) : null;
      if (!meta) {
        meta = await artifactStore.put({
          content: serialized,
          mediaType: typeof sourcePortRecord.value === 'string' ? 'text/plain' : 'application/json',
          producerRunId: input.runId,
          producerNodeId: dataEdge.fromNodeId,
          producerAttemptId: input.attemptId,
          portName: dataEdge.fromPort,
          summary: serialized.slice(0, 200),
        });
        artifactId = meta.artifactId;
      }
      authorizedArtifactIds.add(meta.artifactId);

      const refCard = {
        artifactId: meta.artifactId,
        sha256: meta.sha256,
        sizeBytes: meta.sizeBytes,
        summary: meta.summary,
        sections: meta.sections,
      };
      const refBytes = utf8ByteLength(JSON.stringify(refCard));
      usedInlineBytes += refBytes;

      entries.push({
        portName: dataEdge.toPort,
        sourceNodeId: dataEdge.fromNodeId,
        sourcePort: dataEdge.fromPort,
        mode: 'artifact_ref',
        artifactRef: refCard,
        byteSize: refBytes,
        selectionReason:
          dataEdge.delivery === 'artifact_ref'
            ? 'explicit_artifact_ref_policy'
            : `exceeded_inline_budget(${valueBytes}>${remainingBudget})`,
      });
    } else {
      usedInlineBytes += valueBytes;
      entries.push({
        portName: dataEdge.toPort,
        sourceNodeId: dataEdge.fromNodeId,
        sourcePort: dataEdge.fromPort,
        mode: 'inline',
        inlineValue: sourcePortRecord.value,
        ...(artifactId
          ? {
              artifactRef: {
                artifactId,
                sha256: 'inline',
                sizeBytes: valueBytes,
              },
            }
          : {}),
        byteSize: valueBytes,
        selectionReason: 'within_inline_budget',
      });
    }
  }

  const manifest: ContextManifest = {
    manifestId: idGenerator.nextId('manifest'),
    ...(input.agent ? { agent: { ref: input.agent.ref, digest: input.agent.digest } } : {}),
    ...(input.chiefGuidance?.length ? { chiefGuidance: [...input.chiefGuidance] } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    runId: input.runId,
    nodeId: node.id,
    attemptId: input.attemptId,
    scopeKey: input.scopeKey,
    goal: node.goal,
    acceptanceCriteria: [...node.acceptanceCriteria],
    constraints: [...node.constraints],
    entries,
    authorizedArtifactIds: Array.from(authorizedArtifactIds).sort(),
    totalInlineBytes: usedInlineBytes,
    initialBudgetBytes,
    pageReadBytes,
    ...(stageReadQuotaBytes !== undefined ? { stageReadQuotaBytes } : {}),
    createdAtMs: clock.nowMs(),
  };

  const renderedPrompt = renderContextPrompt(
    node,
    manifest,
    input.agent,
    input.priorRoundFeedback
  );

  return {
    manifest,
    resolvedInputs,
    renderedPrompt,
  };
}

function renderContextPrompt(
  node: AgentNode,
  manifest: ContextManifest,
  agent: PinnedAgent | undefined,
  priorRoundFeedback?: BuildContextBundleInput['priorRoundFeedback']
): string {
  const lines: string[] = [];
  if (agent) {
    const { profile } = agent;
    lines.push(`# You are ${profile.name} (${agent.agentId}@${agent.version})`);
    lines.push(`## Responsibilities\n${profile.charter}`);
    if (profile.instructions.length > 0) {
      lines.push(`## Working Rules\n${profile.instructions.map((r) => `- ${r}`).join('\n')}`);
    }
  }
  lines.push(`# Task Node: ${node.name} (${node.id})`);
  lines.push(`## Goal\n${manifest.goal}`);

  if (manifest.acceptanceCriteria.length > 0) {
    lines.push(
      `## Acceptance Criteria (Mandatory)\n${manifest.acceptanceCriteria
        .map((c, idx) => `${idx + 1}. ${c}`)
        .join('\n')}`
    );
  }

  if (manifest.constraints.length > 0) {
    lines.push(
      `## Constraints (Do Not Violate)\n${manifest.constraints
        .map((c) => `- ${c}`)
        .join('\n')}`
    );
  }

  if (manifest.workspace) {
    const { workspace } = manifest;
    const parts = [`You work in \`${workspace.path}\` (workspace slot "${workspace.slot}").`];
    parts.push(
      workspace.writeScopes.length > 0
        ? `Only modify files under: ${workspace.writeScopes.map((w) => `\`${w}\``).join(', ')}.`
        : 'Do not modify any files there.'
    );
    if (workspace.readOnly.length > 0) {
      parts.push(
        `For reference only (read, never write):\n${workspace.readOnly
          .map((r) => `- ${r.slot}: \`${r.path}\``)
          .join('\n')}`
      );
    }
    lines.push(`## Workspace\n${parts.join('\n')}`);
  }

  if (manifest.chiefGuidance?.length) {
    lines.push(
      `## Guidance From The Chief Agent\n${manifest.chiefGuidance.map((g) => `- ${g}`).join('\n')}`
    );
  }

  if (priorRoundFeedback) {
    lines.push(
      `## Prior Loop Round Feedback (Round ${priorRoundFeedback.roundIndex} -> ${priorRoundFeedback.verdict})`
    );
    lines.push(`Summary: ${priorRoundFeedback.summary}`);
    if (priorRoundFeedback.findings.length > 0) {
      lines.push('Findings to fix:');
      for (const f of priorRoundFeedback.findings) {
        lines.push(`- [${f.severity}] ${f.filePath ? `(${f.filePath}) ` : ''}${f.message}`);
      }
    }
  }

  if (manifest.entries.length > 0) {
    lines.push(
      manifest.entries.some((e) => e.mode !== 'inline')
        ? '## Bound Context Inputs (Data Edges)\nSome inputs are too large to include here; read them with the `ua-workflow` tools (`list_context_inputs`, `read_artifact`).'
        : '## Bound Context Inputs (Data Edges)'
    );
    for (const entry of manifest.entries) {
      if (entry.mode === 'inline') {
        const formatted =
          typeof entry.inlineValue === 'string'
            ? entry.inlineValue
            : JSON.stringify(entry.inlineValue, null, 2);
        lines.push(
          `### Port \`${entry.portName}\` (from \`${entry.sourceNodeId}.${entry.sourcePort}\` [inline, ${entry.byteSize}B])\n\`\`\`\n${formatted}\n\`\`\``
        );
      } else if (entry.artifactRef) {
        lines.push(
          `### Port \`${entry.portName}\` (from \`${entry.sourceNodeId}.${entry.sourcePort}\` [artifact_ref])\n- Artifact ID: \`${entry.artifactRef.artifactId}\`\n- SHA-256: \`${entry.artifactRef.sha256}\`\n- Total Size: ${entry.artifactRef.sizeBytes} bytes\n- Summary: ${entry.artifactRef.summary ?? '(none)'}\n- Read it: call the \`read_artifact\` tool (MCP server \`ua-workflow\`) with \`{ "artifactId": "${entry.artifactRef.artifactId}" }\`; pages are up to ${manifest.pageReadBytes} bytes, continue from \`nextOffsetBytes\` while \`hasMore\` is true${entry.artifactRef.sections?.length ? `, or pass \`section\` (one of: ${entry.artifactRef.sections.map((t) => `"${t}"`).join(', ')})` : ''}.`
        );
      }
    }
  }

  if (node.promptTemplate) {
    lines.push(`## Instructions\n${node.promptTemplate}`);
  }

  lines.push(
    [
      '## Step Data',
      'You can keep intermediate data (progress, partial results, notes, metrics) for this step and read what other steps saved:',
      '- `ua-workflow` tools: `data_put` (collection, key, value), `data_append` (collection, value), `data_get` (collection, key, optional nodeId), `data_list` (optional collection, nodeId); pass `shared: true` for data every step of the run can see.',
      '- Or, from a shell: `ua-workflow data put <collection> <key> <json>`, `ua-workflow data get <collection> <key>`, `ua-workflow data list` (see `ua-workflow help`).',
      '- If you knowingly leave a problem for later, log it so it is handed over: `log_issue` (message, severity, file) or `ua-workflow issue "<message>" --severity minor --file <path>`. `list_findings` / `ua-workflow findings` lists everything still open in the run.',
      'Saved data is not your result: still finish with the output block below.',
    ].join('\n')
  );

  lines.push(renderOutputContract(node));

  return lines.join('\n\n');
}

/**
 * Tells the agent exactly how to hand back results. Reviewer nodes must return a verdict;
 * the runtime treats a missing one as a failed attempt, never as a pass.
 */
function renderOutputContract(node: AgentNode): string {
  const lines = [
    '## Output Contract',
    'Finish your reply with exactly one fenced block:',
  ];
  const envelope: Record<string, unknown> = {};
  if (node.outputs.length > 0) {
    envelope.outputs = Object.fromEntries(
      node.outputs
        .filter((p) => p.type !== 'artifact' && p.type !== 'assessment')
        .map((p) => [p.name, `<${p.type}>`])
    );
    const artifactPorts = node.outputs.filter((p) => p.type === 'artifact');
    if (artifactPorts.length > 0) {
      envelope.artifacts = Object.fromEntries(
        artifactPorts.map((p) => [p.name, { content: '<full text>', summary: '<one line>' }])
      );
    }
  }
  if (node.producesAssessment) {
    envelope.assessment = {
      verdict: 'PASS | NEEDS_FIX | FAIL | BLOCKED',
      summary: '<one paragraph>',
      findings: [{ id: 'f1', severity: 'critical | major | minor | info', message: '<what to fix>', filePath: '<optional>' }],
    };
  }
  lines.push(`\`\`\`ua-workflow-result\n${JSON.stringify(envelope, null, 2)}\n\`\`\``);
  if (node.producesAssessment) {
    lines.push(
      'The `assessment.verdict` is mandatory. Use PASS only when every acceptance criterion is verified; use BLOCKED when you could not complete the review. A reply without a valid verdict is treated as a failed review, not a pass.'
    );
  }
  return lines.join('\n');
}

export function createScopedArtifactReader(options: {
  manifest: ContextManifest;
  artifactStore: ArtifactStore;
  clock: Clock;
  idGenerator: IdGenerator;
}): ScopedArtifactReader {
  const authorizedSet = new Set(options.manifest.authorizedArtifactIds);
  const receipts: ArtifactReadReceipt[] = [];
  let cumulativeBytesRead = 0;

  return {
    async readPage(artifactId, readOptions): Promise<ArtifactPageSlice> {
      if (!authorizedSet.has(artifactId)) {
        throw new UnauthorizedArtifactReadError(options.manifest.attemptId, artifactId);
      }
      const requestedMaxBytes = Math.min(
        readOptions?.maxBytes ?? options.manifest.pageReadBytes,
        options.manifest.pageReadBytes
      );
      const remaining = options.manifest.stageReadQuotaBytes === undefined
        ? null
        : options.manifest.stageReadQuotaBytes - cumulativeBytesRead;
      if (remaining !== null && remaining <= 0) {
        throw new ArtifactQuotaExceededError(
          options.manifest.attemptId,
          requestedMaxBytes,
          remaining
        );
      }

      const effectiveMaxBytes = remaining === null
        ? requestedMaxBytes
        : Math.min(requestedMaxBytes, remaining);
      const slice = await options.artifactStore.readSlice(artifactId, {
        offsetBytes: readOptions?.offsetBytes ?? 0,
        maxBytes: effectiveMaxBytes,
        section: readOptions?.section,
      });

      if (remaining !== null && slice.readBytes > remaining) {
        throw new ArtifactQuotaExceededError(
          options.manifest.attemptId,
          slice.readBytes,
          remaining
        );
      }

      cumulativeBytesRead += slice.readBytes;
      receipts.push({
        receiptId: options.idGenerator.nextId('read'),
        attemptId: options.manifest.attemptId,
        artifactId,
        offsetBytes: slice.offsetBytes,
        readBytes: slice.readBytes,
        ...(slice.section ? { section: slice.section } : {}),
        timestampMs: options.clock.nowMs(),
      });

      return slice;
    },

    getRemainingQuotaBytes(): number | null {
      return options.manifest.stageReadQuotaBytes === undefined
        ? null
        : Math.max(0, options.manifest.stageReadQuotaBytes - cumulativeBytesRead);
    },

    getReceipts(): readonly ArtifactReadReceipt[] {
      return [...receipts];
    },
  };
}
