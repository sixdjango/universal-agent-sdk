import { startAgentSession, type ManagedAgentSession, type StartAgentSessionOptions } from '@universal-agent/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentNodeSchema } from '@universal-agent/workflow-contract';
import type { AgentExecutionRequest } from '@universal-agent/workflow-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UniversalAgentExecutor } from '../src/executors/universal-agent-executor';
import { createNodeWorkflowRuntime, openWorkflowDatabase, resolveWorkflowStoragePaths } from '../src/index';

vi.mock('@universal-agent/client', async importOriginal => ({
  ...await importOriginal<typeof import('@universal-agent/client')>(), startAgentSession: vi.fn(),
}));

const request = (): AgentExecutionRequest => ({
  runId: 'run', scopeKey: '$root', attemptId: 'chief-1', invocationId: 'chief-1',
  node: AgentNodeSchema.parse({ id: '$chief', kind: 'agent', name: 'Chief', role: 'chief', goal: 'Diagnose and delegate' }),
  manifest: {
    manifestId: 'manifest', runId: 'run', scopeKey: '$root', nodeId: '$chief', attemptId: 'chief-1',
    goal: 'Diagnose', acceptanceCriteria: [], constraints: [], entries: [], authorizedArtifactIds: ['artifact'],
    totalInlineBytes: 0, initialBudgetBytes: 0, pageReadBytes: 8192, createdAtMs: 0,
  },
  renderedPrompt: 'Read the artifact and guide the original producer.', inputs: {},
  artifactReader: { async readPage() { throw new Error('unused'); }, getReceipts: () => [], getRemainingQuotaBytes: () => null },
});
type PermissionRequest = Parameters<StartAgentSessionOptions['onRequestPermission']>[1];
const permission = (toolCall: PermissionRequest['toolCall'], options?: PermissionRequest['options']): PermissionRequest => ({
  sessionId: 'acp', toolCall,
  options: options ?? [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
});
const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });

function sessionWith(check: (options: StartAgentSessionOptions) => Promise<void>) {
  vi.mocked(startAgentSession).mockImplementation(async options => ({
    sessionId: 'session', acpSessionId: 'acp',
    async prompt() { await check(options); return { stopReason: 'end_turn' }; },
    getLatestAssistantItems: () => [{ type: 'text', text: 'Diagnosis complete' }],
    getHistory: () => [], shutdown: async () => {},
  } as unknown as ManagedAgentSession));
}

describe('chief ACP permission ceiling', () => {
  beforeEach(() => vi.mocked(startAgentSession).mockReset());

  it('refuses write, shell, mode changes and unknown tools even when the host would allow them', async () => {
    const host = vi.fn<StartAgentSessionOptions['onRequestPermission']>().mockResolvedValue(selected('yes') as Awaited<ReturnType<StartAgentSessionOptions['onRequestPermission']>>);
    sessionWith(async options => {
      for (const kind of ['edit', 'delete', 'move', 'execute', 'switch_mode', 'other'] as const) {
        expect(await options.onRequestPermission(kind, permission({ toolCallId: kind, kind }))).toEqual(selected('no'));
      }
      expect(host).not.toHaveBeenCalled();
      expect(await options.onRequestPermission('read', permission({ toolCallId: 'read', kind: 'read' }))).toEqual(selected('yes'));
      expect(host).toHaveBeenCalledTimes(1);
    });
    const executor = new UniversalAgentExecutor({ workdir: process.cwd(), captureChanges: false, onRequestPermission: host });
    await executor.executeAgent(request());
  });

  it('allows native reads and scoped MCP artifact tools, including a partial Codex permission request', async () => {
    sessionWith(async options => {
      for (const kind of ['read', 'search', 'think'] as const) {
        expect(await options.onRequestPermission(kind, permission({ toolCallId: kind, kind }))).toEqual(selected('yes'));
      }
      expect(await options.onRequestPermission('claude', permission({ toolCallId: 'claude', kind: 'other', title: 'mcp__ua-workflow__read_artifact' }))).toEqual(selected('yes'));
      expect(await options.onRequestPermission('list', permission({ toolCallId: 'list', kind: 'other', title: 'ua-workflow.list_context_inputs' }))).toEqual(selected('yes'));
      options.onUpdateMessage!({ sessionId: 'acp', update: {
        sessionUpdate: 'tool_call', toolCallId: 'codex', kind: 'execute', status: 'pending',
        title: 'mcp.ua-workflow.read_artifact', rawInput: { server: 'ua-workflow', tool: 'read_artifact', arguments: { artifactId: 'artifact' } },
      } });
      expect(await options.onRequestPermission('codex', permission({ toolCallId: 'codex', kind: 'execute' }))).toEqual(selected('yes'));
      // A different MCP server cannot gain the artifact tool's privileges.
      expect(await options.onRequestPermission('other-server', permission({ toolCallId: 'other-server', kind: 'other', title: 'mcp__another-server__read_artifact' }))).toEqual(selected('no'));
      // New tools on the same server are not implicitly granted to the chief.
      expect(await options.onRequestPermission('write-data', permission({ toolCallId: 'write-data', kind: 'other', title: 'mcp__ua-workflow__data_put' }))).toEqual(selected('no'));
    });
    await new UniversalAgentExecutor({ workdir: process.cwd(), captureChanges: false }).executeAgent(request());
  });

  it('does not grant an unmounted artifact tool or an unknown operation lacking a reject option', async () => {
    sessionWith(async options => {
      expect(await options.onRequestPermission('unmounted', permission({ toolCallId: 'tool', kind: 'other', title: 'ua-workflow.read_artifact' }))).toEqual(selected('no'));
      expect(await options.onRequestPermission('unknown', permission({ toolCallId: 'unknown' }, [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]))).toEqual({ outcome: { outcome: 'cancelled' } });
    });
    await new UniversalAgentExecutor({ workdir: process.cwd(), artifactTools: false, captureChanges: false }).executeAgent(request());
  });

  it('lets the host restrict chief reads further and preserves regular node permissions', async () => {
    sessionWith(async options => {
      expect(await options.onRequestPermission('read', permission({ toolCallId: 'read', kind: 'read' }))).toEqual(selected('no'));
    });
    await new UniversalAgentExecutor({ workdir: process.cwd(), captureChanges: false,
      onRequestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'no' } }),
    }).executeAgent(request());
    sessionWith(async options => {
      expect(await options.onRequestPermission('shell', permission({ toolCallId: 'shell', kind: 'execute' }))).toEqual(selected('yes'));
    });
    const regular = request();
    await new UniversalAgentExecutor({ workdir: process.cwd(), captureChanges: false }).executeAgent({
      ...regular, node: { ...regular.node, id: 'worker', role: 'worker' },
      manifest: { ...regular.manifest, nodeId: 'worker' },
    });
  });

  it('allows hosts to disable native reads and scoped artifact reads independently', async () => {
    sessionWith(async options => {
      expect(await options.onRequestPermission('read', permission({ toolCallId: 'read', kind: 'read' }))).toEqual(selected('no'));
      expect(await options.onRequestPermission('search', permission({ toolCallId: 'search', kind: 'search' }))).toEqual(selected('yes'));
      expect(await options.onRequestPermission('artifact', permission({ toolCallId: 'artifact', kind: 'other', title: 'ua-workflow.read_artifact' }))).toEqual(selected('no'));
      expect(await options.onRequestPermission('artifact-read', permission({ toolCallId: 'artifact-read', kind: 'read', title: 'ua-workflow.read_artifact' }))).toEqual(selected('no'));
    });
    await new UniversalAgentExecutor({ workdir: process.cwd(), captureChanges: false,
      chiefPermissions: { allowedToolKinds: ['search'], allowArtifactReads: false },
    }).executeAgent(request());
  });

  it('permits only exact host-declared read-only tools and still applies the host callback', async () => {
    const host = vi.fn<StartAgentSessionOptions['onRequestPermission']>().mockResolvedValue(selected('no') as Awaited<ReturnType<StartAgentSessionOptions['onRequestPermission']>>);
    sessionWith(async options => {
      for (const toolCall of [
        { toolCallId: 'similar', kind: 'other', title: 'host.read_run_extra' },
        { toolCallId: 'write', kind: 'edit', title: 'host.read_run' },
        { toolCallId: 'unknown', kind: 'execute', title: 'shell' },
      ] as const) {
        expect(await options.onRequestPermission(toolCall.toolCallId, permission(toolCall))).toEqual(selected('no'));
      }
      expect(host).not.toHaveBeenCalled();
      expect(await options.onRequestPermission('host-read', permission({ toolCallId: 'host-read', kind: 'other', title: 'host.read_run' }))).toEqual(selected('no'));
      expect(host).toHaveBeenCalledTimes(1);
    });
    await new UniversalAgentExecutor({ workdir: process.cwd(), captureChanges: false, onRequestPermission: host,
      chiefPermissions: { additionalReadOnlyTools: ['host.read_run'] },
    }).executeAgent(request());
  });

  it('forwards host settings through the Node factory and supplies workflow identity and complete tool metadata', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ua-chief-permissions-'));
    const db = openWorkflowDatabase(resolveWorkflowStoragePaths(home).databasePath);
    const contexts: unknown[] = [];
    try {
      const runtime = createNodeWorkflowRuntime({ workdir: home, homeDir: home, db, captureChanges: false, artifactTools: false,
        chiefPermissions: { allowedToolKinds: [], additionalReadOnlyTools: ['host.read_run'] },
        onRequestPermission: async (_id, _request, context) => {
          contexts.push(context);
          return { outcome: { outcome: 'selected', optionId: 'yes' } };
        },
      });
      sessionWith(async options => {
        options.onUpdateMessage!({ sessionId: 'acp', update: {
          sessionUpdate: 'tool_call', toolCallId: 'host-read', kind: 'execute', status: 'pending',
          title: 'host.read_run', rawInput: { runId: 'run' },
        } });
        expect(await options.onRequestPermission('host-read', permission({ toolCallId: 'host-read' }))).toEqual(selected('yes'));
        expect(await options.onRequestPermission('read', permission({ toolCallId: 'read', kind: 'read' }))).toEqual(selected('no'));
        expect(await options.onRequestPermission('artifact', permission({ toolCallId: 'artifact', kind: 'other', title: 'ua-workflow.read_artifact' }))).toEqual(selected('no'));
      });
      await runtime.executor.executeAgent(request());
      expect(contexts).toEqual([expect.objectContaining({
        runId: 'run', scopeKey: '$root', nodeId: '$chief', attemptId: 'chief-1',
        toolCall: expect.objectContaining({ kind: 'execute', title: 'host.read_run', rawInput: { runId: 'run' } }),
      })]);
      sessionWith(async options => {
        expect(await options.onRequestPermission('named-native-read', permission({ toolCallId: 'host-read', kind: 'read', title: 'host.read_run' }))).toEqual(selected('yes'));
      });
      await runtime.executor.executeAgent({ ...request(), attemptId: 'chief-2', invocationId: 'chief-2' });
    } finally {
      db.$client.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects native write or shell capabilities accidentally supplied by an untyped host', () => {
    expect(() => new UniversalAgentExecutor({ workdir: process.cwd(),
      chiefPermissions: { allowedToolKinds: ['execute'] as never },
    })).toThrow('chiefPermissions.allowedToolKinds');
  });
});
