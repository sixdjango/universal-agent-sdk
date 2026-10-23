import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient } from '../src/client/agent-client';
import { startAgentSession } from '../src/launcher/runner';
import { noopLogger } from '../src/process/stream';
import { LocalTerminalManager } from '../src/process/terminal-manager';
import type { AcpSessionNotification } from '../src/types';

describe('AgentClient & startAgentSession end-to-end protocol invariants', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('maps ENOENT in readTextFile to ACP resourceNotFound (-32002)', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ua-read-'));
    tempDirs.push(workdir);

    const client = new AgentClient({
      sessionId: 'sess-read',
      logger: noopLogger,
      terminalManager: new LocalTerminalManager(),
      onUpdateMessage: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });

    // Adopt a mock session so ensureSessionMatch passes
    client.adoptPreparedSession({ sessionId: 'acp-sess-1' });

    const missingPath = join(workdir, 'non-existent-plan.md');
    await expect(
      client.readTextFile({
        sessionId: 'acp-sess-1',
        path: missingPath,
      })
    ).rejects.toMatchObject({
      code: -32002,
    });
  });

  it('starts a custom ACP agent session, exchanges prompts, receives streaming chunks, and shuts down cleanly', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'ua-mock-acp-'));
    tempDirs.push(workdir);

    const mockServerScript = join(workdir, 'mock-acp-server.mjs');
    writeFileSync(
      mockServerScript,
      `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {}, resume: {}, fork: {} },
          _meta: {
            ua: {
              sessionTitle: { version: 1 },
              steering: {
                version: 1,
                transport: 'request',
                upstreamTurn: 'same',
                configPolicy: 'active',
              },
            },
          },
        },
      },
    });
  } else if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'mock-session-123',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'mock-v1',
            options: [{ value: 'mock-v1', name: 'Mock V1' }],
          },
        ],
      },
    });
  } else if (msg.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'mock-session-123',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from Universal Agent SDK!' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { stopReason: 'end_turn' },
    });
  } else if (msg.method === 'session/close') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {},
    });
  }
});
`
    );

    const updates: AcpSessionNotification[] = [];
    const session = await startAgentSession({
      target: {
        cliType: 'custom',
        agentType: 'mock-agent',
        command: process.execPath,
        args: [mockServerScript],
      },
      workdir,
      onUpdateMessage: (notification) => {
        updates.push(notification);
      },
      onRequestPermission: async () => ({
        outcome: { outcome: 'cancelled' },
      }),
    });

    expect(session.acpSessionId).toBe('mock-session-123');
    expect(session.capabilities.sessionTitle).toEqual({ version: 1 });
    expect(session.capabilities.steering).toEqual({
      version: 1,
      transport: 'request',
      upstreamTurn: 'same',
      configPolicy: 'active',
    });

    const response = await session.prompt([{ type: 'text', text: 'Ping' }]);
    expect(response?.stopReason).toBe('end_turn');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.sessionUpdate).toBe('agent_message_chunk');
    if (
      updates[0]?.update.sessionUpdate === 'agent_message_chunk' &&
      updates[0].update.content.type === 'text'
    ) {
      expect(updates[0].update.content.text).toBe('Hello from Universal Agent SDK!');
    }

    await session.shutdown();
  });
});
