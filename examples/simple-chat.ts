import { listDetectableAgents, startAgentSession } from '@universal-agent/client';

async function main() {
  console.log('Checking locally installed Coding Agents...');
  const detected = await listDetectableAgents();
  for (const agent of detected) {
    console.log(
      `  - ${agent.agentType}: ${agent.found ? `FOUND (${agent.resolvedPath}, via ${agent.source})` : 'not found'}`
    );
  }

  console.log('\nStarting Claude Code session...');

  const session = await startAgentSession({
    target: {
      cliType: 'builtin',
      agentType: 'claude',
      // Optional explicit override path; if omitted, resolves from PATH / login shell / default dirs:
      // executablePath: '/usr/local/bin/claude',
    },
    workdir: process.cwd(),
    initialConfig: {
      modelId: 'default',
    },
    onUpdateMessage: (notification) => {
      const update = notification.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        process.stdout.write(update.content.text);
      } else if (update.sessionUpdate === 'tool_call') {
        console.log(`\n[Tool Call] ${update.title} (${update.kind})`);
      }
    },
    onRequestPermission: async (_requestId, request) => {
      console.log(`\n[Permission Request] ${request.toolCall.title}`);
      // Demo only: production hosts should prompt the user and avoid defaulting to allow_always.
      const allowOnce = request.options.find((opt) => opt.kind === 'allow_once');
      return {
        outcome: allowOnce
          ? { outcome: 'selected', optionId: allowOnce.optionId }
          : { outcome: 'cancelled' },
      };
    },
  });

  console.log(`Session connected! ACP SessionId: ${session.acpSessionId}`);

  await session.prompt([
    { type: 'text', text: 'Please inspect the current workspace files and summarize in one sentence.' },
  ]);

  await session.shutdown();
  console.log('\nSession terminated cleanly.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
