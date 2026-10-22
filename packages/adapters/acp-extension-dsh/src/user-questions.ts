import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';
import type { LodyElicitationMeta } from 'acp-extension-core';
import { z } from 'zod';

// Native Harness 0.1.5-rc.2 boundary; shared ACP semantics come from Core.
const questionSchema = z.object({
  id: z.string().refine((value) => value.trim().length > 0),
  question: z.string().min(1),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().optional(),
      })
    )
    .optional(),
  multiSelect: z.boolean().optional(),
  intent: z.object({ kind: z.literal('plan-review'), approve: z.string() }).optional(),
});
export type HarnessQuestion = z.infer<typeof questionSchema>;
export type HarnessQuestionAnswer = {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
};
export type HarnessQuestionRequest = {
  questions: HarnessQuestion[];
  signal?: AbortSignal;
};

function failure(code: string, message: string): Error {
  // Harness restores this serialized error into its own UserQuestionError class.
  return Object.assign(new Error(message), { name: 'UserQuestionError', code });
}

const meta = (fields: Omit<LodyElicitationMeta, 'version'> = {}) => ({
  lody: { elicitation: { version: 1 as const, ...fields } },
});

/** One queue per ACP-owned Agent. No state or answers are shared across sessions. */
export class UserQuestionBridge {
  private tail: Promise<void> = Promise.resolve();
  private pending = new Set<AbortController>();

  constructor(
    private readonly sessionId: string,
    private readonly send: (
      request: CreateElicitationRequest
    ) => Promise<CreateElicitationResponse>,
    private readonly capabilities: () => {
      form: boolean;
      answerNotes: boolean;
    }
  ) {}

  cancel(): void {
    for (const controller of this.pending) controller.abort();
  }

  ask(request: HarnessQuestionRequest): Promise<HarnessQuestionAnswer> {
    const controller = new AbortController();
    this.pending.add(controller);
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    const aborted = () =>
      failure('ASK_ABORTED', 'ask_user_question was cancelled before the user answered');
    let removeListener = () => {};
    const cancellation = new Promise<never>((_, reject) => {
      const abort = () => reject(aborted());
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        removeListener = () => signal.removeEventListener('abort', abort);
      }
    });
    const previous = this.tail;
    const work = previous.then(async () => {
      if (signal.aborted) throw aborted();
      return this.elicit(request);
    });
    const result = Promise.race([work, cancellation]).finally(() => {
      removeListener();
      this.pending.delete(controller);
    });
    // Cancelling a queued waiter must not let its successor overtake the
    // request that still owns the UI slot.
    this.tail = Promise.all([previous, result.catch(() => {})]).then(() => {});
    return result;
  }

  private async elicit(request: HarnessQuestionRequest): Promise<HarnessQuestionAnswer> {
    const capabilities = this.capabilities();
    if (!capabilities.form)
      throw failure('NO_PROVIDER', 'ACP client does not support form elicitation');
    const parsed = z.array(questionSchema).min(1).safeParse(request.questions);
    if (!parsed.success) throw failure('BAD_QUESTIONS', 'Invalid user question request');
    const questions = parsed.data;
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      throw failure('BAD_QUESTIONS', 'Question ids must be unique');
    type Form = Extract<CreateElicitationRequest, { mode: 'form' }>;
    const properties: NonNullable<Form['requestedSchema']['properties']> = Object.create(null);
    const fields = questions.map((question, index) => {
      const key = `question_${index}`;
      const customKey = `custom_${index}`;
      const options = question.options ?? [];
      if (new Set(options.map((o) => o.label)).size !== options.length)
        throw failure('BAD_QUESTIONS', 'Option labels must be unique');
      if (
        question.intent &&
        (question.detail === undefined ||
          !options.some((o) => o.label === question.intent?.approve))
      )
        throw failure('BAD_INTENT', 'Plan review requires detail and an existing approval option');
      const description = [question.question, question.detail].filter(Boolean).join('\n\n');
      // Multi-select custom text is additive in Harness. Core notes preserve it.
      const additive =
        options.length > 0 && question.multiSelect === true && capabilities.answerNotes;
      let other = 'Other';
      while (options.some((o) => o.label === other)) other += ' (custom)';
      const choices = options.map((o) => ({
        const: o.label,
        title: o.label,
        ...(o.description ? { description: o.description } : {}),
      }));
      if (additive) choices.push({ const: other, title: other });
      const base = { title: question.header || question.id, description };
      properties[key] =
        options.length === 0
          ? { ...base, type: 'string' }
          : question.multiSelect
            ? { ...base, type: 'array', items: { anyOf: choices } }
            : { ...base, type: 'string', oneOf: choices };
      if (options.length > 0)
        properties[customKey] = {
          type: 'string',
          title: 'Other',
          description: additive
            ? 'Add a custom answer alongside your selections, or select Other and enter it here.'
            : 'Type your own answer instead of selecting an option.',
          _meta: meta(additive ? { noteFor: key } : { customAnswerFor: key }),
        };
      return {
        question,
        key,
        customKey,
        options,
        additive,
        other,
        description,
      };
    });
    let response: CreateElicitationResponse;
    try {
      response = await this.send({
        sessionId: this.sessionId,
        mode: 'form',
        message:
          fields.length === 1 ? (fields[0]?.description ?? 'Input requested') : 'Input requested',
        requestedSchema: { type: 'object', properties },
        _meta: meta({ autoResolveAfterSeconds: null }),
      });
    } catch (cause) {
      throw failure(
        'ANSWER_FAILED',
        `ACP user question request failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (response.action === 'cancel')
      throw failure('ASK_ABORTED', 'The user cancelled the question');
    if (response.action === 'decline')
      throw failure('ASK_DECLINED', 'The user declined the question');
    const accepted = z
      .object({
        action: z.literal('accept'),
        content: z.record(z.string(), z.unknown()),
      })
      .safeParse(response);
    if (!accepted.success)
      throw failure('INVALID_ANSWER', 'ACP client returned an invalid question response');
    const content = accepted.data.content;
    return {
      answers: fields.map(({ question, key, customKey, options, additive, other }) => {
        const raw = content[key];
        const custom = content[customKey];
        const invalid = () =>
          failure('INVALID_ANSWER', `Invalid answer for question ${question.id}`);
        if (custom !== undefined && typeof custom !== 'string') throw invalid();
        if (options.length === 0) {
          if (typeof raw !== 'string' || !raw.trim()) throw invalid();
          return { id: question.id, selected: [], custom: raw };
        }
        const selected = raw === undefined ? [] : question.multiSelect ? raw : [raw];
        if (
          !Array.isArray(selected) ||
          selected.some((v) => typeof v !== 'string') ||
          new Set(selected).size !== selected.length
        )
          throw invalid();
        if (selected.some((v) => !options.some((o) => o.label === v) && !(additive && v === other)))
          throw invalid();
        const hasCustom = typeof custom === 'string' && custom.trim().length > 0;
        if (
          (!selected.length && !hasCustom) ||
          (additive && selected.includes(other) && !hasCustom) ||
          (!question.multiSelect && selected.length > 0 && hasCustom)
        )
          throw invalid();
        return {
          id: question.id,
          selected: selected.filter((v) => !(additive && v === other)) as string[],
          ...(hasCustom ? { custom } : {}),
        };
      }),
    };
  }
}
