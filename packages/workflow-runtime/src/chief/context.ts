import type { ContextManifest, ContextPortEntry } from '@universal-agent/workflow-contract';
import { createScopedArtifactReader } from '../context/bundle-builder';
import type { ArtifactStore, Clock, IdGenerator, PinnedAgent, PortValueRecord, RunSnapshotState, WorkflowRunState } from '../ports';
import type { ChiefReviewContext } from './supervisor';
import type { ChiefContextOptions } from './options';

/** Freeze a read-only diagnostic view of artifacts already referenced by this run. */
export async function buildChiefReviewContext(options: {
  state: WorkflowRunState;
  artifacts: ArtifactStore;
  clock: Clock;
  idGenerator: IdGenerator;
  agent?: PinnedAgent;
  context?: ChiefContextOptions;
}): Promise<ChiefReviewContext> {
  const { state, artifacts, clock, idGenerator } = options;
  const refs = new Map<string, { scopeKey: string; nodeId: string; port: string }>();
  const addPorts = (scopeKey: string, nodeId: string, ports: Readonly<Record<string, PortValueRecord>>) => {
    for (const [port, value] of Object.entries(ports)) {
      if (value.artifactId) refs.set(value.artifactId, { scopeKey, nodeId, port });
    }
  };
  for (const scope of options.context?.enabled === false ? [] : Object.values(state.scopes)) {
    addPorts(scope.scopeKey, '$input', scope.inputs);
    for (const node of Object.values(scope.nodes)) {
      addPorts(scope.scopeKey, node.nodeId, node.outputs);
      const attempt = node.latestAttemptId ? state.attempts[node.latestAttemptId] : undefined;
      if (!attempt) continue;
      // Failed steps may have a log/diff or a frozen input which is not an output port.
      const manifest = attempt.contextManifestId ? state.manifests[attempt.contextManifestId] : undefined;
      for (const id of [...attempt.producedArtifactIds, ...(manifest?.authorizedArtifactIds ?? []), ...(attempt.changes?.artifactId ? [attempt.changes.artifactId] : [])]) {
        if (!refs.has(id)) refs.set(id, { scopeKey: scope.scopeKey, nodeId: node.nodeId, port: 'diagnostic' });
      }
    }
  }
  const entries: ContextPortEntry[] = [];
  for (const [id, source] of refs) {
    const meta = await artifacts.getMeta(id);
    // A shared store can contain other runs. A model-supplied ID never grants access.
    if (!meta || meta.producerRunId !== state.runId) continue;
    if (options.context?.includeArtifact && !await options.context.includeArtifact({ runId: state.runId, artifact: meta, source })) continue;
    entries.push({
      portName: `${source.scopeKey}/${source.nodeId}.${source.port}`,
      sourceNodeId: meta.producerNodeId,
      sourcePort: meta.portName,
      mode: 'artifact_ref',
      artifactRef: { artifactId: id, sha256: meta.sha256, sizeBytes: meta.sizeBytes,
        ...(meta.summary ? { summary: meta.summary } : {}), ...(meta.sections ? { sections: meta.sections } : {}) },
      byteSize: meta.sizeBytes,
      selectionReason: 'chief_run_diagnostics',
    });
  }
  const attemptId = `chief_${state.runId}_${state.revision}`;
  const manifest: ContextManifest = {
    manifestId: `${attemptId}_manifest`, runId: state.runId, scopeKey: '$root', nodeId: '$chief', attemptId,
    ...(options.agent ? { agent: { ref: options.agent.ref, digest: options.agent.digest } } : {}),
    goal: 'Diagnose this run and delegate repairs to the original workflow nodes',
    acceptanceCriteria: [], constraints: [], entries,
    authorizedArtifactIds: entries.map(entry => entry.artifactRef!.artifactId),
    totalInlineBytes: 0, initialBudgetBytes: 0, pageReadBytes: options.context?.pageReadBytes ?? 8 * 1024,
    ...(options.context?.stageReadQuotaBytes !== undefined ? { stageReadQuotaBytes: options.context.stageReadQuotaBytes } : {}),
    createdAtMs: clock.nowMs(),
  };
  return { manifest, artifactReader: createScopedArtifactReader({ manifest, artifactStore: artifacts, clock, idGenerator }) };
}

/** Persist the frozen authorization and read receipts with the corresponding decision. */
export function recordChiefReviewContext(state: RunSnapshotState, context?: ChiefReviewContext): RunSnapshotState {
  return context ? {
    ...state,
    manifests: { ...state.manifests, [context.manifest.manifestId]: context.manifest },
    readReceipts: [...state.readReceipts, ...context.artifactReader.getReceipts()],
  } : state;
}
