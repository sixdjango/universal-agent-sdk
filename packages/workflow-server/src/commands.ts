import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { WorkflowEvent } from '@universal-agent/workflow-contract';
import type { WorkflowRunState } from '@universal-agent/workflow-runtime';
import { DEFAULT_SERVER_URL, WorkflowClient, WorkflowClientError } from './client';
import { buildOpenApiDocument } from './openapi';

export const COMMANDS = ['workflows', 'runs', 'run', 'status', 'logs', 'findings', 'cancel', 'fork', 'openapi'] as const;

export const COMMANDS_HELP = `Commands (talk to a running server; --server or $UA_WORKFLOW_SERVER, default ${DEFAULT_SERVER_URL}):
  workflows                       List saved workflows
  runs [--workflow <id>]          List runs, newest first (--limit <n>)
  run <workflowId>                Start a run and print its id
      --input <name>=<value>      A workflow input (repeatable; JSON values are parsed)
      --inputs <file.json>        Inputs from a JSON file (--input wins)
      --workspace <slot>=<dir|id> Where a slot runs: a directory (registered if new) or a workspace id
      --watch                     Follow it to the end; exit 0 succeeded, 1 failed, 2 cancelled, 3 waiting for an answer
  status <runId>                  Status, steps and outputs of a run
  logs <runId>                    Print a run's events and follow them while it runs (--no-follow to stop at the end)
  findings <runId>                Problems still open: what reviews left and issues steps logged
  cancel <runId>                  Stop a run for good
  fork <runId> --from <stepId>    New run from a step: earlier steps are taken over (their file changes merged
                                  onto the current HEAD), the step and what follows run again
      --input, --inputs           Inputs to change (the others are the source run's)
      --workspace <slot>=<dir|id> Where a slot runs (default: the source run's workspace)
      --watch                     As for run
  openapi                         Print the HTTP API's OpenAPI document

  --json                          Machine-readable output (logs: one JSON event per line)
`;

/** Exit code a finished (or paused) run maps to. */
export function exitCodeFor(status: WorkflowRunState['status']): number {
  return status === 'SUCCEEDED' ? 0 : status === 'FAILED' ? 1 : status === 'CANCELLED' ? 2 : status === 'WAITING' ? 3 : 4;
}

export interface CommandIo {
  out(text: string): void;
  err(text: string): void;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
/** `$root/fix__loop:round_1` → `fix round 2 ›`, so steps read where they ran. */
function where(scopeKey: string | undefined): string {
  if (!scopeKey || scopeKey === '$root') return '';
  return (
    scopeKey
      .split('/')
      .slice(1)
      .map((part) => {
        const round = /^(.+?)__loop:round_(\d+)$/.exec(part);
        if (round) return `${round[1]} round ${Number(round[2]) + 1}`;
        const item = /^(.+?)\[(\d+)\]$/.exec(part);
        return item ? `${item[1]} #${Number(item[2]) + 1}` : part;
      })
      .join(' › ') + ' › '
  );
}

/** One readable line per event worth telling (null for bookkeeping). */
export function describeEvent(event: WorkflowEvent): string | null {
  const at = time(event.timestampMs);
  switch (event.type) {
    case 'run.started':
      return `${at}  run started (${event.definitionId})`;
    case 'run.forked':
      return `${at}  forked from ${event.sourceRunId} at ${event.fromNodeId}${event.inherited.length ? `, taking over ${event.inherited.map((id) => id.replace(/__loop$/, '')).join(', ')}` : ''}`;
    case 'node.completed': {
      const mark = event.status === 'SUCCEEDED' ? '✓' : event.status === 'FAILED' ? '✗' : '–';
      const loop = /^(.+)__loop$/.exec(event.nodeId);
      const what = loop ? `${loop[1]} loop ${event.status === 'SUCCEEDED' ? 'done' : event.status.toLowerCase()}` : `${event.nodeId} ${event.status.toLowerCase()}`;
      return `${at}  ${mark} ${where(event.scopeKey)}${what}${event.verdict ? ` · ${event.verdict}` : ''}`;
    }
    case 'node.waiting':
      return `${at}  ? ${where(event.scopeKey)}${event.nodeId} asks: ${event.prompt} (answer request ${event.requestId})`;
    case 'node.invalidated':
      return `${at}  ↺ ${where(event.scopeKey)}${event.nodeId} invalidated: ${event.reason}`;
    case 'loop.round.advanced':
      return `${at}  ↻ ${event.loopNodeId.replace(/__loop$/, '')} round ${event.roundIndex + 1}`;
    case 'chief.user_message':
      return `${at}  you → chief: ${event.text}`;
    case 'chief.intervened': {
      const applied = event.applied.map((c) => c.kind).join(', ') || 'nothing';
      return `${at}  chief (${event.trigger}): ${event.reply ?? event.rationale} [${applied}${event.rejected.length ? `; rejected ${event.rejected.length}` : ''}]`;
    }
    case 'chief.escalation_resolved':
      return `${at}  answered ${event.requestId}`;
    case 'run.finished':
      return `${at}  run ${event.status.toLowerCase()}`;
    default:
      return null;
  }
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function pairs(values: readonly string[] | undefined, flag: string): [string, string][] {
  return (values ?? []).map((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`${flag} expects <name>=<value>, got "${pair}"`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
}

class UsageError extends Error {}

/** Prints a run's events, following them until the run finishes (or pauses for an answer). */
async function followRun(
  client: WorkflowClient,
  runId: string,
  io: CommandIo,
  options: { json: boolean; follow: boolean }
): Promise<WorkflowRunState> {
  const controller = new AbortController();
  const started = new Set<string>();
  let lastStatus: string | undefined;
  try {
    for await (const item of client.followRun(runId, { signal: controller.signal })) {
      if (item.type === 'activity') {
        for (const live of item.liveProgress) {
          if (started.has(live.attemptId)) continue;
          started.add(live.attemptId);
          if (options.json) io.out(`${JSON.stringify({ type: 'node.started', scopeKey: live.scopeKey, nodeId: live.nodeId, attemptId: live.attemptId, timestampMs: live.startedAtMs })}\n`);
          else io.out(`${time(live.startedAtMs)}  ▶ ${where(live.scopeKey)}${live.nodeId} started\n`);
        }
        // Caught up with the log: stop at the end of a run that is not going anywhere.
        if (!item.active) {
          const { run } = await client.getRun(runId);
          if (!options.follow || TERMINAL.has(run.status) || run.status === 'WAITING') return run;
        }
        continue;
      }
      const { mutation } = item.entry;
      if (mutation.kind !== 'event.emitted') continue;
      const event = mutation.event;
      if (options.json) io.out(`${JSON.stringify(event)}\n`);
      else {
        const line = describeEvent(event);
        if (line) io.out(`${line}\n`);
      }
      if (event.type === 'run.finished') lastStatus = event.status;
      if (lastStatus && options.follow) return (await client.getRun(runId)).run;
    }
  } finally {
    controller.abort();
  }
  return (await client.getRun(runId)).run;
}

function printStatus(run: WorkflowRunState, active: boolean, io: CommandIo): void {
  io.out(`${run.runId}  ${run.status}${active ? ' (executing)' : ''}  ${run.definition.name}\n`);
  for (const [scopeKey, scope] of Object.entries(run.scopes)) {
    for (const [nodeId, node] of Object.entries(scope.nodes)) {
      if (node.status === 'PENDING' || nodeId.endsWith('__loop')) continue;
      const attempts = Object.values(run.attempts).filter((a) => a.scopeKey === scopeKey && a.nodeId === nodeId).length;
      io.out(
        `  ${node.status.padEnd(9)} ${where(scopeKey)}${nodeId}${node.latestVerdict ? ` · ${node.latestVerdict}` : ''}${attempts > 1 ? ` (${attempts} attempts)` : ''}${node.error ? `  ${node.error}` : ''}\n`
      );
    }
  }
  const waits = Object.values(run.waitRequests).filter((w) => w.status === 'PENDING');
  for (const wait of waits) io.out(`  waiting: ${wait.prompt} (request ${wait.requestId})\n`);
  if (Object.keys(run.outputs).length > 0) io.out(`outputs: ${JSON.stringify(run.outputs)}\n`);
}

/** Runs one CLI command against the server; returns the process exit code. */
export async function runCommand(command: string, args: string[], io: CommandIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      server: { type: 'string' },
      json: { type: 'boolean', default: false },
      workflow: { type: 'string' },
      limit: { type: 'string' },
      input: { type: 'string', multiple: true },
      inputs: { type: 'string' },
      workspace: { type: 'string', multiple: true },
      watch: { type: 'boolean', default: false },
      follow: { type: 'boolean', default: true },
      from: { type: 'string' },
    },
  });
  const client = new WorkflowClient(values.server ?? io.env?.UA_WORKFLOW_SERVER ?? DEFAULT_SERVER_URL);
  const json = values.json;
  const print = (value: unknown) => io.out(`${JSON.stringify(value, null, 2)}\n`);
  const needs = (what: string) => {
    if (!positionals[0]) throw new UsageError(`${command} needs a ${what}`);
    return positionals[0];
  };

  const readInputs = (): Record<string, unknown> => {
    const inputs: Record<string, unknown> = values.inputs
      ? (JSON.parse(readFileSync(resolve(io.cwd ?? process.cwd(), values.inputs), 'utf8')) as Record<string, unknown>)
      : {};
    for (const [name, raw] of pairs(values.input, '--input')) inputs[name] = parseValue(raw);
    return inputs;
  };
  const readWorkspaces = async (): Promise<Record<string, string>> => {
    const workspaces: Record<string, string> = {};
    for (const [slot, target] of pairs(values.workspace, '--workspace')) {
      workspaces[slot] = /^ws_/.test(target) ? target : (await client.workspaceFor(resolve(io.cwd ?? process.cwd(), target))).id;
    }
    return workspaces;
  };
  /** Prints a run that just started, or follows it to the end with --watch. */
  const started = async (runId: string): Promise<number> => {
    if (!values.watch) {
      if (json) print({ runId });
      else io.out(`${runId}\n`);
      return 0;
    }
    if (!json) io.out(`run ${runId}\n`);
    const run = await followRun(client, runId, io, { json, follow: true });
    if (!json) {
      io.out(`\n`);
      printStatus(run, false, io);
    }
    return exitCodeFor(run.status);
  };

  try {
    switch (command) {
      case 'workflows': {
        const workflows = await client.listWorkflows();
        if (json) print(workflows);
        else for (const w of workflows) io.out(`${w.id.padEnd(32)} ${w.name}\n`);
        return 0;
      }
      case 'runs': {
        const runs = await client.listRuns({ ...(values.workflow ? { workflowId: values.workflow } : {}), limit: Number(values.limit ?? 20) || 20 });
        if (json) print(runs);
        else for (const r of runs) io.out(`${r.runId}  ${r.status.padEnd(9)} ${new Date(r.createdAtMs).toLocaleString()}  ${r.workflowId}\n`);
        return 0;
      }
      case 'run': {
        const workflowId = needs('workflow id');
        const { runId } = await client.startRun({ workflowId, inputs: readInputs(), workspaces: await readWorkspaces() });
        return await started(runId);
      }
      case 'fork': {
        const sourceRunId = needs('run id');
        if (!values.from) throw new UsageError('fork needs --from <stepId>');
        const inputs = readInputs();
        const workspaces = await readWorkspaces();
        const fork = await client.forkRun(sourceRunId, {
          nodeId: values.from,
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
          ...(Object.keys(workspaces).length > 0 ? { workspaces } : {}),
        });
        if (!json && fork.inherited.length > 0) io.err(`taking over ${fork.inherited.map((id) => id.replace(/__loop$/, '')).join(', ')}; running again from ${fork.fromNodeId}\n`);
        return await started(fork.runId);
      }
      case 'status': {
        const view = await client.getRun(needs('run id'));
        if (json) print({ runId: view.run.runId, status: view.run.status, active: view.active, outputs: view.run.outputs, scopes: view.run.scopes });
        else printStatus(view.run, view.active, io);
        return 0;
      }
      case 'logs': {
        await followRun(client, needs('run id'), io, { json, follow: values.follow });
        return 0;
      }
      case 'findings': {
        const findings = await client.listFindings(needs('run id'));
        if (json) print(findings);
        else if (findings.length === 0) io.out('No open findings.\n');
        else
          for (const f of findings) {
            const at = f.filePath ? `  ${f.filePath}${f.line ? `:${f.line}` : ''}` : '';
            io.out(`${f.severity.padEnd(8)} ${where(f.scopeKey)}${f.nodeId} (${f.source === 'issue' ? 'logged' : f.verdict})  ${f.message}${at}\n`);
          }
        return 0;
      }
      case 'cancel': {
        const run = await client.cancelRun(needs('run id'));
        if (json) print({ runId: run.runId, status: run.status });
        else io.out(`${run.runId}  ${run.status}\n`);
        return 0;
      }
      case 'openapi': {
        print(buildOpenApiDocument(values.server ? { serverUrl: values.server } : {}));
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${COMMANDS_HELP}`);
      return 64;
    }
    if (err instanceof WorkflowClientError) {
      io.err(`${err.message}\n`);
      return err.status === 0 ? 69 : 1;
    }
    throw err;
  }
}
