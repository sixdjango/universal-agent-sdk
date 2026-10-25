import { createWorkflowBuilder, type AgentNode } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  ArtifactQuotaExceededError,
  createScopedArtifactReader,
  createWorkflowRuntime,
  DeterministicClock,
  InMemoryArtifactStore,
  SequentialIdGenerator,
  UnauthorizedArtifactReadError,
  type AgentExecutionRequest,
} from '../src/index';

const report = '# Report\n' + 'x'.repeat(200 * 1024);

function createReaderRuntime(
  consume: (request: AgentExecutionRequest) => Promise<void>,
  contextBudget?: AgentNode['contextBudget']
) {
  const artifacts = new InMemoryArtifactStore();
  const definition = createWorkflowBuilder('context-quota')
    .addAgent({
      id: 'writer', name: 'Writer', role: 'writer', goal: 'Produce reports',
      outputs: [
        { name: 'report', type: 'artifact', required: true },
        { name: 'notes', type: 'artifact', required: true },
      ],
    })
    .addAgent({
      id: 'reader', name: 'Reader', role: 'reader', goal: 'Read the reports',
      contextBudget,
      inputs: [
        { name: 'report', type: 'artifact', required: true },
        { name: 'notes', type: 'artifact', required: true },
      ],
    })
    .connectData({ fromNodeId: 'writer', fromPort: 'report', toNodeId: 'reader', toPort: 'report', withControl: true })
    .connectData({ fromNodeId: 'writer', fromPort: 'notes', toNodeId: 'reader', toPort: 'notes', withControl: true })
    .buildDefinition();
  const runtime = createWorkflowRuntime({
    artifacts,
    executor: {
      async executeAgent(request) {
        if (request.node.id === 'writer') {
          return {
            status: 'COMPLETED',
            artifacts: { report: { content: report }, notes: { content: 'Additional notes' } },
          };
        }
        await consume(request);
        return { status: 'COMPLETED' };
      },
      async executeScript() { throw new Error('Unused'); },
    },
  });
  return { runtime, definition, artifacts };
}

describe('cumulative artifact read quotas', () => {
  it.each([
    { name: 'default settings', contextBudget: undefined, pageBytes: 8 * 1024 },
    { name: 'custom paging without a quota', contextBudget: { initialBundleBytes: 32 * 1024, pageReadBytes: 4096 }, pageBytes: 4096 },
  ])('reads beyond 128 KiB with $name while preserving references and page limits', async ({ contextBudget, pageBytes }) => {
    const { runtime, definition } = createReaderRuntime(async (request) => {
      const entry = request.manifest.entries.find((entry) => entry.portName === 'report')!;
      expect(entry.mode).toBe('artifact_ref');
      expect(request.renderedPrompt).not.toContain(report);
      expect(request.manifest.initialBudgetBytes).toBe(32 * 1024);
      expect(request.manifest.pageReadBytes).toBe(pageBytes);
      expect(request.manifest.stageReadQuotaBytes).toBeUndefined();
      expect(request.artifactReader.getRemainingQuotaBytes()).toBeNull();
      await expect(request.artifactReader.readPage('art_not_authorized'))
        .rejects.toBeInstanceOf(UnauthorizedArtifactReadError);

      let offsetBytes = 0;
      let reconstructed = '';
      while (true) {
        const page = await request.artifactReader.readPage(entry.artifactRef!.artifactId, {
          offsetBytes,
          maxBytes: report.length, // Requesting the whole report must still respect the page size.
        });
        expect(page.readBytes).toBeGreaterThan(0);
        expect(page.readBytes).toBeLessThanOrEqual(pageBytes);
        reconstructed += page.content;
        expect(request.artifactReader.getRemainingQuotaBytes()).toBeNull();
        if (!page.hasMore) break;
        expect(page.nextOffsetBytes).toBeGreaterThan(offsetBytes);
        offsetBytes = page.nextOffsetBytes!;
      }
      expect(reconstructed).toBe(report);
    }, contextBudget);

    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status, done.scopes.$root!.nodes.reader!.error).toBe('SUCCEEDED');
    expect(done.readReceipts.length).toBeGreaterThan(16);
    expect(done.readReceipts.reduce((total, receipt) => total + receipt.readBytes, 0)).toBe(report.length);
  });

  it('enforces an explicit quota across artifacts, clamps the last page and persists the quota', async () => {
    const { runtime, definition, artifacts } = createReaderRuntime(async (request) => {
      const reportId = request.manifest.entries.find((entry) => entry.portName === 'report')!.artifactRef!.artifactId;
      const notesId = request.manifest.entries.find((entry) => entry.portName === 'notes')!.artifactRef!.artifactId;
      expect(request.manifest.stageReadQuotaBytes).toBe(10);
      expect(request.artifactReader.getRemainingQuotaBytes()).toBe(10);
      expect((await request.artifactReader.readPage(reportId)).readBytes).toBe(8);
      expect(request.artifactReader.getRemainingQuotaBytes()).toBe(2);
      expect((await request.artifactReader.readPage(notesId)).readBytes).toBe(2);
      expect(request.artifactReader.getRemainingQuotaBytes()).toBe(0);
      await expect(request.artifactReader.readPage(reportId, { offsetBytes: 8 }))
        .rejects.toBeInstanceOf(ArtifactQuotaExceededError);

      // A stored manifest must retain the configured quota after a JSON round trip.
      const restored = createScopedArtifactReader({
        manifest: JSON.parse(JSON.stringify(request.manifest)),
        artifactStore: artifacts,
        clock: new DeterministicClock(),
        idGenerator: new SequentialIdGenerator(),
      });
      expect(restored.getRemainingQuotaBytes()).toBe(10);
      await restored.readPage(reportId);
      expect((await restored.readPage(reportId)).readBytes).toBe(2); // Re-reading counts too.
      await expect(restored.readPage(notesId)).rejects.toBeInstanceOf(ArtifactQuotaExceededError);
    }, { initialBundleBytes: 32 * 1024, pageReadBytes: 8, stageReadQuotaBytes: 10 });

    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status, done.scopes.$root!.nodes.reader!.error).toBe('SUCCEEDED');
    expect(done.readReceipts.map((receipt) => receipt.readBytes)).toEqual([8, 2]);
  });
});
