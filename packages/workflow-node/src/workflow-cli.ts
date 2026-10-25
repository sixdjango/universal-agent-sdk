#!/usr/bin/env node
/**
 * `ua-workflow`: the step tools from a shell. Workflow steps (scripts, and agents with a
 * shell) get it on their PATH with `UA_WORKFLOW_RPC` pointing at their own tools, so every
 * call is scoped to the step that runs it. Same tools as the `ua-workflow` MCP server.
 */
import { parseArgs } from 'node:util';
import { WORKFLOW_RPC_URL_ENV } from './artifact-tools/host';
import type { ArtifactToolResult } from './artifact-tools/tools';

const HELP = `Usage: ua-workflow <command> [options]

Step data (intermediate results, progress, notes):
  data put <collection> <key> [value]   Save a value (JSON, or text); "-" or no value reads stdin
  data append <collection> [value]      Add a record with a generated key
  data get <collection> <key>           Print a saved value (exit 1 when there is none)
  data list                             Print saved records as JSON, oldest first

Handing problems over to a person:
  issue <message>                       Log a problem you leave for later (--severity, --file, --line)
  findings                              List everything still open in the run, most severe first

Inputs and artifacts handed to this step:
  inputs                                List this step's inputs
  artifact read <artifactId>            Print one page of an artifact

Options:
  --shared            Use the run's shared data instead of this step's
  --node <id>         get/list: read another step's data
  --collection <c>    list: only this collection
  --after <id>        list: only records written after this id
  --limit <n>         list: at most n records
  --record            get: print the whole record, not just the value
  --offset <n>, --max <n>, --section <heading>   artifact read: which part to read
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`ua-workflow: ${message}\n`);
  process.exit(code);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON when it parses, otherwise the text itself (trailing newline dropped). */
async function parseValue(arg: string | undefined): Promise<unknown> {
  const raw = arg === undefined || arg === '-' ? (await readStdin()).replace(/\n$/, '') : arg;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const url = process.env[WORKFLOW_RPC_URL_ENV];
  if (!url) fail(`${WORKFLOW_RPC_URL_ENV} is not set; run this from a workflow step`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  }).catch((err: unknown) => fail(`cannot reach the workflow host: ${err instanceof Error ? err.message : String(err)}`));
  if (!response.ok) fail(`the workflow host refused the call (${response.status}): ${await response.text()}`);
  const result = (await response.json()) as ArtifactToolResult;
  const text = result.content.map((c) => c.text).join('\n');
  if (result.isError) fail(text, 1);
  return text;
}

const argv = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    shared: { type: 'boolean' },
    node: { type: 'string' },
    collection: { type: 'string' },
    after: { type: 'string' },
    limit: { type: 'string' },
    record: { type: 'boolean' },
    offset: { type: 'string' },
    max: { type: 'string' },
    section: { type: 'string' },
    severity: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const [command, sub, ...rest] = positionals;
const shared = values.shared ? { shared: true } : {};
const out = (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);

if (!command || command === 'help' || values.help) {
  process.stdout.write(HELP);
} else if (command === 'data' && sub === 'put') {
  const [collection, key, value] = rest;
  if (!collection || !key) fail('usage: ua-workflow data put <collection> <key> [value]');
  out(await call('data_put', { collection, key, value: await parseValue(value), ...shared }));
} else if (command === 'data' && sub === 'append') {
  const [collection, value] = rest;
  if (!collection) fail('usage: ua-workflow data append <collection> [value]');
  out(await call('data_append', { collection, value: await parseValue(value), ...shared }));
} else if (command === 'data' && sub === 'get') {
  const [collection, key] = rest;
  if (!collection || !key) fail('usage: ua-workflow data get <collection> <key>');
  const record = JSON.parse(await call('data_get', { collection, key, ...(values.node ? { nodeId: values.node } : {}), ...shared })) as {
    value: unknown;
  } | null;
  if (!record) process.exit(1);
  out(values.record ? JSON.stringify(record, null, 2) : typeof record.value === 'string' ? record.value : JSON.stringify(record.value, null, 2));
} else if (command === 'data' && sub === 'list') {
  out(
    await call('data_list', {
      ...(values.collection ? { collection: values.collection } : {}),
      ...(values.node ? { nodeId: values.node } : {}),
      ...(values.after ? { afterId: Number(values.after) } : {}),
      ...(values.limit ? { limit: Number(values.limit) } : {}),
      ...shared,
    })
  );
} else if (command === 'issue') {
  const message = [sub, ...rest].filter(Boolean).join(' ');
  if (!message) fail('usage: ua-workflow issue <message> [--severity critical|major|minor|info] [--file <path>] [--line <n>]');
  out(
    await call('log_issue', {
      message,
      ...(values.severity ? { severity: values.severity } : {}),
      ...(values.file ? { file: values.file } : {}),
      ...(values.line ? { line: Number(values.line) } : {}),
    })
  );
} else if (command === 'findings') {
  out(await call('list_findings', {}));
} else if (command === 'inputs') {
  out(await call('list_context_inputs', {}));
} else if (command === 'artifact' && sub === 'read') {
  const [artifactId] = rest;
  if (!artifactId) fail('usage: ua-workflow artifact read <artifactId>');
  out(
    await call('read_artifact', {
      artifactId,
      ...(values.offset ? { offsetBytes: Number(values.offset) } : {}),
      ...(values.max ? { maxBytes: Number(values.max) } : {}),
      ...(values.section ? { section: values.section } : {}),
    })
  );
} else {
  fail(`unknown command "${[command, sub].filter(Boolean).join(' ')}" (see ua-workflow help)`);
}
