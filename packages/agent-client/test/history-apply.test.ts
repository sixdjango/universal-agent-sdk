import { describe, expect, it } from 'vitest';
import {
  type AcpSessionNotification,
  type SessionHistoryEntry,
  SessionHistoryAccumulator,
  applyNotificationOnHistory,
  applyNotificationOnHistoryWithChange,
  buildMessageContentFromNotification,
} from '../src';

describe('Unified Message & Turn History Materializer', () => {
  it('merges adjacent streaming text and thought chunks and extracts <thinking> / <proposed_plan> tags', () => {
    const history: SessionHistoryEntry[] = [];
    const notifications: AcpSessionNotification[] = [
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Let me ' },
        },
      },
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'check the repo.' },
        },
      },
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '<thinking>Deep Claude ' },
        },
      },
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'thought</thinking>\nHere is the answer.\n<proposed_plan>\n1. Step one\n2. Step two\n</proposed_plan>\nDone!',
          },
        },
      },
    ];

    const { history: result, changed } = applyNotificationOnHistoryWithChange(
      history,
      notifications,
      { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { createId: () => 'turn-1', now: () => '2026-10-23T00:00:00.000Z' }
    );

    expect(changed).toBe(true);
    expect(result).toHaveLength(1);
    const turn = result[0]!;
    expect(turn.id).toBe('turn-1');
    expect(turn.role).toBe('assistant');
    expect(turn.modelInfo?.modelId).toBe('claude-sonnet-4-5');
    expect(turn.items).toEqual([
      {
        type: 'thought',
        text: 'Let me check the repo.Deep Claude thought',
      },
      {
        type: 'text',
        text: '\nHere is the answer.\n',
      },
      {
        type: 'proposed_plan',
        turnId: 'turn-1',
        markdown: '1. Step one\n2. Step two',
        status: 'completed',
        isLatest: true,
      },
      {
        type: 'text',
        text: '\nDone!',
      },
    ]);
  });

  it('merges tool_call and tool_call_update by toolCallId and extracts terminal_command & terminal_output', () => {
    const history: SessionHistoryEntry[] = [];
    const notifications: AcpSessionNotification[] = [
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'pnpm', args: ['test'], cwd: '/workspace' },
        },
      },
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          rawOutput: {
            aggregated_output: 'PASS all tests\n',
            exit_code: 0,
          },
        },
      },
    ];

    applyNotificationOnHistory(history, notifications);
    expect(history).toHaveLength(1);
    expect(history[0]?.items).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        title: 'Run tests',
        kind: 'execute',
        status: 'completed',
        content: [
          {
            type: 'terminal_command',
            command: 'pnpm',
            args: ['test'],
            cwd: '/workspace',
          },
          {
            type: 'terminal_output',
            output: 'PASS all tests\n',
            stream: 'combined',
            truncated: false,
            exitStatus: { exitCode: 0, signal: null },
          },
        ],
        locations: undefined,
        rawInput: undefined,
        rawOutput: undefined,
        schedulingTimeZone: undefined,
        recordedAtMs: undefined,
        toolName: undefined,
        activityKind: undefined,
      },
    ]);
  });

  it('materializes _meta.ua.task, _meta.lody.task, and subagent_event into unified subagent_task items', () => {
    const history: SessionHistoryEntry[] = [];
    const notifications: AcpSessionNotification[] = [
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'task-call-1',
          title: 'Spawn subagent',
          _meta: {
            ua: {
              task: {
                version: 1,
                taskId: 'sub-1',
                kind: 'subagent',
                status: 'in_progress',
                actor: 'Codebase Researcher',
                description: 'Inspect launcher',
              },
            },
          },
        },
      },
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'task-call-1',
          _meta: {
            lody: {
              task: {
                version: 1,
                taskId: 'sub-1',
                kind: 'subagent',
                status: 'completed',
                summary: 'Found all 46 engines',
              },
            },
          },
        },
      },
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'subagent_event',
          event: {
            version: 1,
            type: 'snapshot',
            sessionId: 'sess-1',
            runId: 'run-2',
            snapshot: {
              state: 'running',
              name: 'Verifier',
              description: 'Verify build',
              support: {
                stream: ['text', 'thought', 'tool', 'plan'],
                progress: true,
                outputRead: 'live_tail',
                cancel: false,
              },
            },
          },
        },
      },
      {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'subagent_event',
          event: {
            version: 1,
            type: 'output',
            sessionId: 'sess-1',
            runId: 'run-2',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Build succeeded!' },
            },
          },
        },
      },
    ];

    applyNotificationOnHistory(history, notifications, undefined, {
      targetAssistantEntryId: 'assistant-1',
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.items).toHaveLength(2);
    expect(history[0]?.items?.[0]).toMatchObject({
      type: 'subagent_task',
      taskId: 'sub-1',
      taskKind: 'subagent',
      status: 'completed',
      actor: 'Codebase Researcher',
      description: 'Inspect launcher',
      summary: 'Found all 46 engines',
    });
    expect(history[0]?.items?.[1]).toMatchObject({
      type: 'subagent_task',
      taskId: 'run-2',
      taskKind: 'subagent',
      status: 'in_progress',
      actor: 'Verifier',
      description: 'Verify build',
      run: {
        sessionId: 'sess-1',
        items: [{ type: 'text', text: 'Build succeeded!' }],
      },
    });
  });

  it('tracks multi-turn user + assistant conversations via SessionHistoryAccumulator', () => {
    const snapshots: number[] = [];
    const accumulator = new SessionHistoryAccumulator({
      onChange: (h) => snapshots.push(h.length),
    });

    accumulator.appendUserTurn('1+1等于几？');
    accumulator.applyNotification({
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '1+1 等于 ' },
      },
    });
    accumulator.applyNotification({
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '2。' },
      },
    });
    accumulator.completeActiveAssistantTurn();

    accumulator.appendUserTurn('那 2+2 呢？');
    accumulator.applyNotification({
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '4。' },
      },
    });

    const history = accumulator.getHistory();
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({
      role: 'user',
      finished: true,
      items: [{ type: 'text', text: '1+1等于几？' }],
    });
    expect(history[1]).toMatchObject({
      role: 'assistant',
      finished: true,
      items: [{ type: 'text', text: '1+1 等于 2。' }],
    });
    expect(history[2]).toMatchObject({
      role: 'user',
      finished: true,
      items: [{ type: 'text', text: '那 2+2 呢？' }],
    });
    expect(history[3]).toMatchObject({
      role: 'assistant',
      items: [{ type: 'text', text: '4。' }],
    });
    expect(accumulator.getLatestAssistantItems()).toEqual([{ type: 'text', text: '4。' }]);
    expect(snapshots.length).toBeGreaterThanOrEqual(5);
  });

  it('supports single-notification projection via buildMessageContentFromNotification', () => {
    const items = buildMessageContentFromNotification({
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });
    expect(items).toEqual([{ type: 'text', text: 'Hello' }]);
  });
});
