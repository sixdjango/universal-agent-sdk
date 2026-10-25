#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { COMMANDS, COMMANDS_HELP, runCommand } from './commands';
import { createDefaultWorkflowServer, LOOPBACK_HOSTS } from './index';

const HELP = `Usage: universal-agent-workflow [serve] [options]
       universal-agent-workflow <command> [args] [options]

Starts the Universal Agent workflow server and web canvas, or talks to a running one.

Serve options:
  --port <n>         Port to listen on (default 4317)
  --host <addr>      Interface to bind (default 127.0.0.1)
  --workdir <dir>    Default workspace; workflows without workspace slots run here
                     (default: where you ran the command)
  --home <dir>       Data directory (default: $UNIVERSAL_AGENT_HOME or ~/.universal-agent)
  --allow-host <h>   Extra Host header name to accept (repeatable), e.g. when using --host 0.0.0.0
  -h, --help         Show this help

${COMMANDS_HELP}`;

// `pnpm run <script> -- --flag` forwards the `--` itself; drop it.
const raw = process.argv.slice(2);
const argv = raw[0] === '--' ? raw.slice(1) : raw;
const command = argv[0];

if (command && (COMMANDS as readonly string[]).includes(command)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const code = await runCommand(command, argv.slice(1), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.env.INIT_CWD ?? process.cwd(),
  });
  process.exit(code);
}

const { values } = parseArgs({
  args: command === 'serve' ? argv.slice(1) : argv,
  options: {
    port: { type: 'string', default: '4317' },
    host: { type: 'string', default: '127.0.0.1' },
    workdir: { type: 'string' },
    home: { type: 'string' },
    'allow-host': { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const port = Number(values.port);
// pnpm/npm scripts run inside the package; INIT_CWD is where the user actually invoked them.
const workdir = values.workdir ?? process.env.INIT_CWD ?? process.cwd();
const host = values.host!;
const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
if (!loopback) {
  process.stderr.write(
    `Warning: binding to ${host} lets other machines start agents that can modify ${workdir}.\n`
  );
}

const server = await createDefaultWorkflowServer({
  workdir,
  ...(values.home ? { homeDir: values.home } : {}),
  allowedHosts: [...LOOPBACK_HOSTS, ...(values['allow-host'] ?? [])],
  logger: { level: 'warn' },
});

const shutdown = async () => {
  await server.app.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await server.app.listen({ port, host });
const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
process.stdout.write(`Universal Agent workflows: http://${shownHost}:${port}\nAgents work in: ${workdir}\n`);
