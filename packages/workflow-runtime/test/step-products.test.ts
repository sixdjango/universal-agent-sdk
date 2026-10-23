import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { describe, expect, it } from 'vitest';
import {
  type AgentExecutionRequest,
  createWorkflowRuntime,
  DeterministicClock,
  SequentialIdGenerator,
} from '../src/index';

const DIFF = 'diff --git a/a.txt b/a.txt\n-old\n+new\n';

describe('what steps hand downstream', () => {
  it('stores the workspace diff and passes it to a reviewer through a `changes` port', async () => {
    const seen: AgentExecutionRequest[] = [];
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent(req) {
          seen.push(req);
          if (req.node.id === 'build') {
            return { status: 'COMPLETED', outputs: { note: 'done' }, changes: { diff: DIFF, files: [{ path: 'a.txt', status: 'M' }] } };
          }
          if (req.node.id === 'tidy') return { status: 'COMPLETED', changes: { diff: '', files: [] } };
          return { status: 'COMPLETED', assessment: { verdict: 'PASS', summary: 'ok' } };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const definition = createWorkflowBuilder('diff-review')
      .addAgent({
        id: 'build',
        name: 'Build',
        role: 'author',
        goal: 'Change it',
        writeScopes: ['.'],
        outputs: [{ name: 'changes', type: 'artifact', required: true }],
      })
      .addAgent({ id: 'tidy', name: 'Tidy', role: 'author', goal: 'Nothing to do', writeScopes: ['.'] })
      .addAgent({
        id: 'review',
        name: 'Review',
        role: 'reviewer',
        goal: 'Review the diff',
        producesAssessment: true,
        inputs: [{ name: 'changes', type: 'artifact', required: true }],
      })
      .connectData({ fromNodeId: 'build', fromPort: 'changes', toNodeId: 'review', toPort: 'changes', withControl: true })
      .buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('SUCCEEDED');

    const build = done.attempts[done.scopes.$root!.nodes.build!.latestAttemptId!]!;
    expect(build.changes?.files).toEqual([{ path: 'a.txt', status: 'M' }]);
    const diffId = build.changes!.artifactId!;
    expect(await runtime.artifacts.readText(diffId)).toBe(DIFF);
    expect((await runtime.artifacts.getMeta(diffId))?.mediaType).toBe('text/x-diff');
    expect(done.scopes.$root!.nodes.build!.outputs.changes!.artifactId).toBe(diffId);

    // Nothing changed: no artifact, but the attempt still says so.
    expect(done.attempts[done.scopes.$root!.nodes.tidy!.latestAttemptId!]!.changes).toEqual({ files: [] });

    const review = seen.find((r) => r.node.id === 'review')!;
    expect(review.manifest.authorizedArtifactIds).toContain(diffId);
    expect(review.renderedPrompt).toContain('+new');
    expect(done.assessments[done.scopes.$root!.nodes.review!.latestAssessmentId!]!.targetArtifactIds).toContain(diffId);
  });

  it('stores script artifacts, and keeps long logs out of the run state', async () => {
    const longLog = 'line\n'.repeat(10_000);
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent() {
          throw new Error('unused');
        },
        async executeScript(req) {
          if (req.node.id === 'lint') {
            return {
              exitCode: 0,
              stdout: 'ok',
              stderr: '',
              durationMs: 1,
              outputs: { count: 3 },
              artifacts: { report: { content: '# 3 warnings', summary: 'lint report' } },
            };
          }
          return { exitCode: 0, stdout: longLog, stderr: '', durationMs: 1 };
        },
      },
    });
    const definition = createWorkflowBuilder('scripts')
      .addScript({
        id: 'lint',
        name: 'Lint',
        command: 'lint',
        outputs: [
          { name: 'report', type: 'artifact', required: true },
          { name: 'count', type: 'number', required: true },
        ],
      })
      .addScript({ id: 'noisy', name: 'Noisy', command: 'noisy' })
      .buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.status).toBe('SUCCEEDED');

    const lint = done.scopes.$root!.nodes.lint!;
    expect(lint.outputs.count!.value).toBe(3);
    expect(await runtime.artifacts.readText(lint.outputs.report!.artifactId!)).toBe('# 3 warnings');
    expect(done.attempts[lint.latestAttemptId!]!.producedArtifactIds).toEqual([lint.outputs.report!.artifactId]);

    const report = done.scopes.$root!.nodes.noisy!.outputs.testReport!.value as { stdout: string; stdoutArtifactId: string };
    expect(report.stdout.length).toBeLessThan(longLog.length);
    expect(report.stdout.startsWith('…')).toBe(true);
    expect(await runtime.artifacts.readText(report.stdoutArtifactId)).toBe(longLog);
  });

  it('flags out-of-scope writes of steps working in place, and fails them when scopes are enforced', async () => {
    const changes = { diff: 'x', files: [{ path: 'src/a.ts', status: 'M' }, { path: 'package.json', status: 'M' }] };
    const runtime = createWorkflowRuntime({
      clock: new DeterministicClock(),
      idGenerator: new SequentialIdGenerator(),
      executor: {
        async executeAgent() {
          return { status: 'COMPLETED', changes };
        },
        async executeScript() {
          throw new Error('unused');
        },
      },
    });
    const definition = createWorkflowBuilder('scopes')
      .addAgent({ id: 'lax', name: 'Lax', role: 'author', goal: 'x', writeScopes: ['src'] })
      .addAgent({ id: 'strict', name: 'Strict', role: 'author', goal: 'x', writeScopes: ['src/'], enforceWriteScopes: true, maxTechnicalRetries: 2 })
      .connectControl('lax', 'strict')
      .buildDefinition();
    const done = await runtime.runUntilSettled((await runtime.start({ definition })).runId);
    expect(done.attempts[done.scopes.$root!.nodes.lax!.latestAttemptId!]!.changes?.outOfScope).toEqual(['package.json']);
    const strict = done.scopes.$root!.nodes.strict!;
    expect(strict.status).toBe('FAILED');
    expect(strict.error).toBe('Step "strict" changed files outside its write scopes: package.json');
    // Retrying cannot undo a write that already happened in place.
    expect(strict.retryCount).toBe(0);
  });
});
