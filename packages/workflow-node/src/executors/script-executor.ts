import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startProcess, terminateChildTree } from '@universal-agent/client';
import { AssessmentVerdictSchema } from '@universal-agent/workflow-contract';
import type {
  ScriptExecutionRequest,
  ScriptExecutionResult,
} from '@universal-agent/workflow-runtime';
import { z } from 'zod';
import type { ArtifactToolHost } from '../artifact-tools/host';
import { diffSinceSnapshot, snapshotWorkingTree } from '../workspace/change-capture';

export interface NodeScriptExecutorOptions {
  /** Gives scripts the step tools: `ua-workflow` on PATH and `UA_WORKFLOW_RPC` (data, inputs, artifacts). */
  readonly tools?: ArtifactToolHost;
  readonly defaultWorkdir?: string;
  readonly defaultEnv?: NodeJS.ProcessEnv;
  /** Record a git diff of what writing scripts changed in their workspace (default true). */
  readonly captureChanges?: boolean;
}

/**
 * What a script may write to `$UA_OUTPUTS_FILE`: the same envelope agents return in their
 * `ua-workflow-result` block. Everything is optional; without the file the runtime reports
 * exit code and logs.
 */
const ScriptOutputsFileSchema = z.object({
  outputs: z.record(z.string(), z.unknown()).optional(),
  artifacts: z
    .record(z.string(), z.object({ content: z.string(), mediaType: z.string().optional(), summary: z.string().optional() }))
    .optional(),
  assessment: z
    .object({
      verdict: AssessmentVerdictSchema,
      summary: z.string(),
      findings: z
        .array(
          z.object({
            id: z.string(),
            severity: z.enum(['critical', 'major', 'minor', 'info']),
            message: z.string(),
            filePath: z.string().optional(),
            line: z.number().int().optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

/** `UA_INPUT_<NAME>`: port name upper-cased, anything but letters and digits becomes `_`. */
export function scriptInputEnvName(port: string): string {
  return `UA_INPUT_${port.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/**
 * Writes a script's inputs where it can read them: `inputs.json` with every value, plus one
 * file per input (text as-is, other values as JSON) so large artifacts never go through env.
 */
async function writeScriptInputs(dir: string, inputs: Readonly<Record<string, unknown>>): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  const inputsFile = join(dir, 'inputs.json');
  await writeFile(inputsFile, JSON.stringify(inputs, null, 2));
  env.UA_INPUTS_FILE = inputsFile;
  let index = 0;
  for (const [port, value] of Object.entries(inputs)) {
    const file = join(dir, `input-${index++}`);
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    env[scriptInputEnvName(port)] = file;
  }
  return env;
}

export class NodeScriptExecutor {
  private readonly defaultWorkdir: string;
  private readonly defaultEnv?: NodeJS.ProcessEnv;
  private readonly captureChanges: boolean;
  private readonly tools?: ArtifactToolHost;

  constructor(options: NodeScriptExecutorOptions = {}) {
    this.defaultWorkdir = options.defaultWorkdir ?? process.cwd();
    this.defaultEnv = options.defaultEnv;
    this.captureChanges = options.captureChanges ?? true;
    if (options.tools) this.tools = options.tools;
  }

  /**
   * Runs the script with its inputs on disk (`UA_INPUTS_FILE`, `UA_INPUT_<PORT>`) and reads
   * `UA_OUTPUTS_FILE` afterwards. A malformed outputs file fails the attempt.
   */
  async executeScript(request: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    const root = request.workspace?.path ?? this.defaultWorkdir;
    const io = await mkdtemp(join(tmpdir(), 'ua-script-'));
    const tools = this.tools && request.data ? this.tools.register({ data: request.data }) : null;
    try {
      const toolEnv =
        tools && this.tools
          ? await this.tools.cliEnv(tools.token, request.node.env?.PATH ?? this.defaultEnv?.PATH ?? process.env.PATH ?? '')
          : {};
      const before =
        this.captureChanges && !request.isolated && request.node.writeScopes.length > 0
          ? await snapshotWorkingTree(root)
          : null;
      const outputsFile = join(io, 'outputs.json');
      const result = await this.run(request, root, {
        ...(await writeScriptInputs(io, request.inputs)),
        UA_OUTPUTS_FILE: outputsFile,
        ...toolEnv,
      });
      const written = await readFile(outputsFile, 'utf8').catch(() => null);
      let declared: z.infer<typeof ScriptOutputsFileSchema> = {};
      if (written !== null && written.trim()) {
        let json: unknown;
        try {
          json = JSON.parse(written);
        } catch {
          throw new Error(`Script "${request.node.id}" wrote invalid JSON to UA_OUTPUTS_FILE`);
        }
        const parsed = ScriptOutputsFileSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error(
            `Script "${request.node.id}" wrote an invalid UA_OUTPUTS_FILE: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`
          );
        }
        declared = parsed.data;
      }
      const changes = before ? await diffSinceSnapshot(before) : null;
      return {
        ...result,
        ...(declared.outputs ? { outputs: declared.outputs } : {}),
        ...(declared.artifacts ? { artifacts: declared.artifacts } : {}),
        ...(declared.assessment ? { assessment: declared.assessment } : {}),
        ...(changes ? { changes } : {}),
      };
    } finally {
      tools?.release();
      await rm(io, { recursive: true, force: true });
    }
  }

  private async run(
    request: ScriptExecutionRequest,
    root: string,
    ioEnv: NodeJS.ProcessEnv
  ): Promise<Pick<ScriptExecutionResult, 'exitCode' | 'stdout' | 'stderr' | 'durationMs'>> {
    const startTime = Date.now();
    const cwd = resolve(root, request.node.cwd ?? '.');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.defaultEnv,
      ...request.node.env,
      UA_WORKFLOW_RUN_ID: request.runId,
      UA_WORKFLOW_ATTEMPT_ID: request.attemptId,
      UA_WORKFLOW_NODE_ID: request.node.id,
      UA_WORKSPACE_DIR: root,
      ...(request.workspace ? { UA_WORKSPACE_SLOT: request.workspace.slot } : {}),
      ...ioEnv,
    };

    const handle = startProcess(
      {
        command: request.node.command,
        args: request.node.args,
        options: {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        processGroup: true,
      },
      { signal: request.signal }
    );

    let stdout = '';
    let stderr = '';

    handle.child.stdout?.setEncoding('utf8');
    handle.child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    handle.child.stderr?.setEncoding('utf8');
    handle.child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timeoutMs = request.node.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateChildTree(handle.child, {
        graceMs: process.platform === 'win32' ? 0 : 200,
        killWaitMs: 2_000,
        processGroup: true,
      }).catch(() => {});
    }, timeoutMs);
    timer.unref?.();

    try {
      const exit = await handle.exited;
      const durationMs = Math.max(0, Date.now() - startTime);
      const exitCode = timedOut ? 124 : (exit.code ?? (exit.signal ? 1 : 0));
      if (timedOut) {
        stderr += `\n[workflow-node] Script timed out after ${timeoutMs}ms`;
      }
      return {
        exitCode,
        stdout,
        stderr,
        durationMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
