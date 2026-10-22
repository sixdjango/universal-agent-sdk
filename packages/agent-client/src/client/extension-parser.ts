import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import {
  EXTENSION_METHODS,
  MAX_USAGE_SCOPE_ID_LENGTH,
  SUBAGENT_EVENT_METHOD,
  isSubagentEvent,
  normalizeExtensionMethod,
  type ElicitationAnswer,
  type ElicitationMeta,
  type ElicitationOption,
  type ElicitationQuestion,
  type ExtensionCapabilities,
  type RateLimit,
  type RateLimitsSnapshot,
  type SessionActivityUpdate,
  type SessionUsageUpdate,
  type SubagentEvent,
  type TaskMeta,
} from '@universal-agent/acp-extension-core';
import { z } from 'zod';
import {
  type AcpSessionNotification,
  type AgentConfigCliType,
  parseSessionNotification,
} from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read `_meta.ua` first, falling back to `_meta.lody`. */
export function getExtensionMetaContainer(meta: unknown): Record<string, unknown> | null {
  if (!isRecord(meta)) return null;
  if (isRecord(meta.ua)) return meta.ua;
  if (isRecord(meta.lody)) return meta.lody;
  return null;
}

// ============================================================================
// AskUserQuestion Elicitation Bridge (Claude >= 0.44.0 & Codex)
// ============================================================================

export type AskUserQuestionOption = ElicitationOption;
export type AskUserQuestionSource = 'lody' | 'claude' | 'codex';
export type AskUserQuestion = ElicitationQuestion;

export type AskUserQuestionPermissionMeta = {
  source: AskUserQuestionSource;
  version: number;
  allowCustomAnswer: boolean;
  questions: AskUserQuestion[];
  autoResolveAt?: number;
};

export type AskUserQuestionAnswerValue = ElicitationAnswer;
export type AskUserQuestionAnswers = Record<string, AskUserQuestionAnswerValue>;

export type AskUserQuestionElicitation = {
  meta: AskUserQuestionPermissionMeta;
  fieldKeys: string[];
  customFieldKeys?: Array<string | undefined>;
  autoResolutionMs?: number | null;
};

const getBooleanField = (
  value: Record<string, unknown>,
  camelCaseKey: string,
  snakeCaseKey: string
): boolean => value[camelCaseKey] === true || value[snakeCaseKey] === true;

const getClaudeCodeMeta = (meta: unknown): Record<string, unknown> | null => {
  if (!isRecord(meta)) return null;
  return isRecord(meta.claudeCode) ? meta.claudeCode : null;
};

const getCodexMeta = (meta: unknown): Record<string, unknown> | null => {
  if (!isRecord(meta)) return null;
  return isRecord(meta.codex) ? meta.codex : null;
};

export const getElicitationMeta = (meta: unknown): Record<string, unknown> | null => {
  const ext = getExtensionMetaContainer(meta);
  const elicitation = ext?.elicitation;
  return isRecord(elicitation) && elicitation.version === 1 ? elicitation : null;
};

function hasValidNoteKeys(questions: readonly AskUserQuestion[]): boolean {
  if (!questions.some((question) => question.note)) return true;
  const used = new Set(questions.map((question) => question.id));
  if (used.size !== questions.length || questions.some((question) => !question.id?.trim()))
    return false;
  for (const question of questions) {
    if (!question.note) continue;
    if (!question.note.fieldId.trim() || used.has(question.note.fieldId)) return false;
    used.add(question.note.fieldId);
  }
  return true;
}

function parsePermissionQuestions(rawQuestions: unknown[]): AskUserQuestion[] | null {
  if (rawQuestions.length === 0) return null;
  const questions: AskUserQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    if (!isRecord(rawQuestion)) return null;
    if (typeof rawQuestion.question !== 'string' || typeof rawQuestion.header !== 'string') {
      return null;
    }
    if (!Array.isArray(rawQuestion.options)) return null;
    const note = rawQuestion.note;
    if (
      note !== undefined &&
      (!isRecord(note) ||
        typeof note.fieldId !== 'string' ||
        !note.fieldId.trim() ||
        (note.title !== undefined && typeof note.title !== 'string') ||
        (note.description !== undefined && typeof note.description !== 'string') ||
        (note.isSecret !== undefined && typeof note.isSecret !== 'boolean'))
    )
      return null;
    const options: AskUserQuestionOption[] = [];
    for (const rawOption of rawQuestion.options) {
      if (!isRecord(rawOption) || typeof rawOption.label !== 'string') return null;
      options.push({
        label: rawOption.label,
        ...(typeof rawOption.description === 'string'
          ? { description: rawOption.description }
          : {}),
        ...(typeof rawOption.preview === 'string' ? { preview: rawOption.preview } : {}),
      });
    }
    questions.push({
      ...(typeof rawQuestion.id === 'string' ? { id: rawQuestion.id } : {}),
      question: rawQuestion.question,
      header: rawQuestion.header,
      options,
      multiSelect: rawQuestion.multiSelect === true,
      ...(typeof rawQuestion.allowCustomAnswer === 'boolean'
        ? { allowCustomAnswer: rawQuestion.allowCustomAnswer }
        : {}),
      ...(rawQuestion.isSecret === true ? { isSecret: true } : {}),
      ...(isRecord(note)
        ? {
            note: {
              fieldId: note.fieldId as string,
              ...(typeof note.title === 'string' ? { title: note.title } : {}),
              ...(typeof note.description === 'string' ? { description: note.description } : {}),
              ...(note.isSecret === true ? { isSecret: true } : {}),
            },
          }
        : {}),
    });
  }
  return hasValidNoteKeys(questions) ? questions : null;
}

function parseExtensionElicitationPermissionMeta(
  ext: Record<string, unknown>
): AskUserQuestionPermissionMeta | null {
  const raw = ext.elicitation;
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.questions)) return null;
  const questions = parsePermissionQuestions(raw.questions);
  if (!questions) return null;
  return {
    source: 'lody',
    version: 1,
    allowCustomAnswer: questions.some((question) => question.allowCustomAnswer === true),
    questions,
    ...(typeof raw.autoResolveAtEpochSeconds === 'number' &&
    Number.isFinite(raw.autoResolveAtEpochSeconds)
      ? { autoResolveAt: raw.autoResolveAtEpochSeconds * 1000 }
      : typeof raw.autoResolveAt === 'number' && Number.isFinite(raw.autoResolveAt)
        ? { autoResolveAt: raw.autoResolveAt }
        : {}),
  };
}

function parseClaudeAskUserQuestionPermissionMeta(
  claudeCode: Record<string, unknown>
): AskUserQuestionPermissionMeta | null {
  const raw = claudeCode.askUserQuestion;
  if (!isRecord(raw)) return null;

  const rawQuestions = raw.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

  const questions: AskUserQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    if (!isRecord(rawQuestion)) return null;
    if (typeof rawQuestion.question !== 'string') return null;
    if (typeof rawQuestion.header !== 'string') return null;
    if (!Array.isArray(rawQuestion.options)) return null;

    const options: AskUserQuestionOption[] = [];
    for (const rawOption of rawQuestion.options) {
      if (!isRecord(rawOption)) return null;
      if (typeof rawOption.label !== 'string') return null;
      options.push({
        label: rawOption.label,
        ...(typeof rawOption.description === 'string'
          ? { description: rawOption.description }
          : {}),
        ...(typeof rawOption.preview === 'string' ? { preview: rawOption.preview } : {}),
      });
    }

    questions.push({
      question: rawQuestion.question,
      header: rawQuestion.header,
      options,
      multiSelect: rawQuestion.multiSelect === true,
    });
  }

  return {
    source: 'claude',
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1,
    allowCustomAnswer: raw.allowCustomAnswer === true,
    questions,
  };
}

function parseCodexRequestUserInputPermissionMeta(
  codex: Record<string, unknown>
): AskUserQuestionPermissionMeta | null {
  const raw = codex.requestUserInput;
  if (!isRecord(raw)) return null;

  const rawQuestions = raw.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

  const questions: AskUserQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    if (!isRecord(rawQuestion)) return null;
    if (typeof rawQuestion.id !== 'string') return null;
    if (typeof rawQuestion.question !== 'string') return null;
    if (typeof rawQuestion.header !== 'string') return null;

    const rawOptions = rawQuestion.options;
    const options: AskUserQuestionOption[] = [];
    if (rawOptions !== undefined) {
      if (!Array.isArray(rawOptions)) return null;
      for (const rawOption of rawOptions) {
        if (!isRecord(rawOption)) return null;
        if (typeof rawOption.label !== 'string') return null;
        options.push({
          label: rawOption.label,
          ...(typeof rawOption.description === 'string'
            ? { description: rawOption.description }
            : {}),
        });
      }
    }

    questions.push({
      id: rawQuestion.id,
      question: rawQuestion.question,
      header: rawQuestion.header,
      options,
      multiSelect: false,
      allowCustomAnswer:
        getBooleanField(rawQuestion, 'isOther', 'is_other') ||
        rawQuestion.allowCustomAnswer === true,
      isSecret: getBooleanField(rawQuestion, 'isSecret', 'is_secret'),
    });
  }

  return {
    source: 'codex',
    version: 1,
    allowCustomAnswer: questions.some((question) => question.allowCustomAnswer === true),
    questions,
    ...(typeof raw.autoResolveAt === 'number' && Number.isFinite(raw.autoResolveAt)
      ? { autoResolveAt: raw.autoResolveAt }
      : {}),
  };
}

export function parseAskUserQuestionPermissionMeta(
  meta: unknown
): AskUserQuestionPermissionMeta | null {
  const ext = getExtensionMetaContainer(meta);
  if (ext) {
    const parsed = parseExtensionElicitationPermissionMeta(ext);
    if (parsed) return parsed;
    if (isRecord(ext.elicitation) && ext.elicitation.version === 1) return null;
  }

  const claudeCode = getClaudeCodeMeta(meta);
  if (claudeCode) {
    return parseClaudeAskUserQuestionPermissionMeta(claudeCode);
  }

  const codex = getCodexMeta(meta);
  if (codex) {
    return parseCodexRequestUserInputPermissionMeta(codex);
  }

  return null;
}

export function isAskUserQuestionPermissionRequest(request: RequestPermissionRequest): boolean {
  return parseAskUserQuestionPermissionMeta((request as { _meta?: unknown })._meta) !== null;
}

const isUniqueNonEmptyQuestionField = (
  questions: readonly AskUserQuestion[],
  value: string,
  getValue: (question: AskUserQuestion) => string
): boolean =>
  value.trim().length > 0 &&
  questions.filter((question) => getValue(question) === value).length === 1;

export function getAskUserQuestionAnswerKey(
  questions: readonly AskUserQuestion[],
  index: number
): string {
  const question = questions[index];
  if (!question) return String(index);

  if (
    question.id &&
    isUniqueNonEmptyQuestionField(questions, question.id, (item) => item.id ?? '')
  ) {
    return question.id;
  }

  if (isUniqueNonEmptyQuestionField(questions, question.question, (item) => item.question)) {
    return question.question;
  }

  if (isUniqueNonEmptyQuestionField(questions, question.header, (item) => item.header)) {
    return question.header;
  }

  return String(index);
}

const getCodexOutcomeAnswers = (outcomeMeta: unknown): Record<string, unknown> | null => {
  const codex = getCodexMeta(outcomeMeta);
  const requestUserInput =
    codex && isRecord(codex.requestUserInput) ? codex.requestUserInput : null;
  return requestUserInput && isRecord(requestUserInput.answers) ? requestUserInput.answers : null;
};

const getClaudeOutcomeAnswers = (outcomeMeta: unknown): Record<string, unknown> | null => {
  const claudeCode = getClaudeCodeMeta(outcomeMeta);
  const askUserQuestion =
    claudeCode && isRecord(claudeCode.askUserQuestion) ? claudeCode.askUserQuestion : null;
  return askUserQuestion && isRecord(askUserQuestion.answers) ? askUserQuestion.answers : null;
};

const getExtensionOutcomeAnswers = (outcomeMeta: unknown): Record<string, unknown> | null => {
  const ext = getExtensionMetaContainer(outcomeMeta);
  const elicitation = ext && isRecord(ext.elicitation) ? ext.elicitation : null;
  return elicitation && isRecord(elicitation.answers) ? elicitation.answers : null;
};

export function extractAskUserQuestionAnswersFromOutcome(
  meta: AskUserQuestionPermissionMeta,
  outcome: { _meta?: Record<string, unknown> | null } | null | undefined
): AskUserQuestionAnswers | null {
  if (!outcome || !isRecord(outcome._meta) || !hasValidNoteKeys(meta.questions)) return null;

  const answerSources = [
    { source: 'lody' as const, answers: getExtensionOutcomeAnswers(outcome._meta) },
    { source: 'codex' as const, answers: getCodexOutcomeAnswers(outcome._meta) },
    { source: 'claude' as const, answers: getClaudeOutcomeAnswers(outcome._meta) },
  ];
  const answerSource = answerSources.find(({ answers }) => answers !== null);
  if (!answerSource?.answers) return null;

  const result: AskUserQuestionAnswers = Object.create(null);
  for (const [index, question] of meta.questions.entries()) {
    if (question.note && answerSource.source === 'lody') {
      const note = answerSource.answers[question.note.fieldId];
      if (typeof note === 'string' && note.trim()) result[question.note.fieldId] = note;
    }
    const key = getAskUserQuestionAnswerKey(meta.questions, index);
    const sourceKey =
      answerSource.source === 'claude'
        ? getAskUserQuestionAnswerKey(
            meta.questions.map(({ id: _id, ...item }) => item),
            index
          )
        : key;
    const raw = answerSource.answers[sourceKey];
    if (raw === undefined) continue;

    if (answerSource.source === 'codex') {
      if (!isRecord(raw)) continue;
      const inner = raw.answers;
      if (!Array.isArray(inner)) continue;
      const values = inner.filter((value): value is string => typeof value === 'string');
      if (values.length === 0) continue;
      result[key] = question.multiSelect ? values : (values[0] ?? '');
    } else if (typeof raw === 'string') {
      result[key] = raw;
    } else if (Array.isArray(raw)) {
      const values = raw.filter((value): value is string => typeof value === 'string');
      if (values.length === 0) continue;
      result[key] = question.multiSelect ? values : (values[0] ?? '');
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function createAskUserQuestionPermissionOutcome(
  optionId: string,
  answers: AskUserQuestionAnswers,
  metaOrSource: AskUserQuestionPermissionMeta | AskUserQuestionSource = 'claude'
): RequestPermissionResponse['outcome'] {
  const source = typeof metaOrSource === 'string' ? metaOrSource : metaOrSource.source;
  if (source === 'lody') {
    const elicitation = { version: 1, answers } satisfies ElicitationMeta;
    return {
      outcome: 'selected',
      optionId,
      _meta: { ua: { elicitation }, lody: { elicitation } },
    };
  }
  if (source === 'codex') {
    const codexAnswers: Record<string, { answers: string[] }> = {};
    for (const [key, value] of Object.entries(answers)) {
      codexAnswers[key] = {
        answers: Array.isArray(value) ? value : [value],
      };
    }
    return {
      outcome: 'selected',
      optionId,
      _meta: {
        codex: {
          requestUserInput: {
            answers: codexAnswers,
          },
        },
      },
    };
  }

  return {
    outcome: 'selected',
    optionId,
    _meta: {
      claudeCode: {
        askUserQuestion: {
          answers,
        },
      },
    },
  };
}

type EnumOptionLike = {
  const: string;
  title?: string;
  description?: string;
  _meta?: unknown;
};

const isEnumOption = (value: unknown): value is EnumOptionLike =>
  isRecord(value) && typeof value.const === 'string';

const getEnumOptionSource = (prop: Record<string, unknown>): unknown[] | null => {
  if (Array.isArray(prop.oneOf)) return prop.oneOf;
  if (Array.isArray(prop.enum)) return prop.enum;
  const items = prop.items;
  if (isRecord(items)) {
    if (Array.isArray(items.anyOf)) return items.anyOf;
    if (Array.isArray(items.enum)) return items.enum;
  }
  return null;
};

const isQuestionProperty = (prop: unknown): prop is Record<string, unknown> =>
  isRecord(prop) && getEnumOptionSource(prop) !== null;

const isFreeTextProperty = (prop: unknown): boolean =>
  isRecord(prop) &&
  prop.type === 'string' &&
  !Array.isArray(prop.oneOf) &&
  !Array.isArray(prop.enum);

const isMultiSelectProperty = (prop: Record<string, unknown>): boolean =>
  prop.type === 'array' || isRecord(prop.items);

const parseElicitationOptions = (source: unknown[]): AskUserQuestionOption[] => {
  const options: AskUserQuestionOption[] = [];
  for (const entry of source) {
    if (typeof entry === 'string') {
      options.push({ label: entry });
      continue;
    }
    if (!isEnumOption(entry)) continue;
    const label = entry.const;
    const title = typeof entry.title === 'string' ? entry.title : '';
    const separator = `${label} — `;
    const description =
      typeof entry.description === 'string' && entry.description.trim()
        ? entry.description
        : title && title !== label
          ? title.startsWith(separator)
            ? title.slice(separator.length)
            : title
          : undefined;
    const preview = getElicitationMeta(entry._meta)?.preview;
    options.push({
      label,
      ...(description ? { description } : {}),
      ...(typeof preview === 'string' ? { preview } : {}),
    });
  }
  return options;
};

export function parseAskUserQuestionElicitationRequest(
  request: CreateElicitationRequest
): AskUserQuestionElicitation | null {
  if (!isRecord(request) || request.mode !== 'form') return null;

  const schema = request.requestedSchema;
  if (!isRecord(schema) || !isRecord(schema.properties)) return null;

  const entries = Object.entries(schema.properties);
  const requestMeta = getElicitationMeta(request._meta);
  const customFieldKeyByQuestionId = new Map<string, string>();
  const noteFieldKeyByQuestionId = new Map<string, string>();
  const associatedFields = new Set<string>();
  for (const [key, prop] of entries) {
    if (!isRecord(prop)) continue;
    const rawMeta = getExtensionMetaContainer(prop._meta)?.elicitation;
    if (isRecord(rawMeta) && rawMeta.noteFor !== undefined && rawMeta.version !== 1) return null;
    const meta = getElicitationMeta(prop._meta);
    if (!meta || (meta.noteFor === undefined && meta.customAnswerFor === undefined)) continue;
    if (meta.noteFor !== undefined && meta.customAnswerFor !== undefined) return null;
    const target = meta.noteFor ?? meta.customAnswerFor;
    const fields =
      meta.noteFor !== undefined ? noteFieldKeyByQuestionId : customFieldKeyByQuestionId;
    if (
      typeof target !== 'string' ||
      !target.trim() ||
      !key.trim() ||
      key === target ||
      !isFreeTextProperty(prop) ||
      fields.has(target)
    )
      return null;
    if (
      meta.noteFor !== undefined &&
      Array.isArray(schema.required) &&
      schema.required.includes(key)
    )
      return null;
    fields.set(target, key);
    associatedFields.add(key);
  }
  const isCoreForm = requestMeta !== null || associatedFields.size > 0;
  const questionEntries = entries.filter(([key, prop]) => {
    if (!isRecord(prop)) return false;
    if (associatedFields.has(key)) return false;
    return isQuestionProperty(prop) || (isCoreForm && isFreeTextProperty(prop));
  });
  if (questionEntries.length === 0) return null;
  const questionIds = new Set(questionEntries.map(([key]) => key));
  for (const target of [...customFieldKeyByQuestionId.keys(), ...noteFieldKeyByQuestionId.keys()]) {
    if (!questionIds.has(target)) return null;
  }
  if (associatedFields.size > 0 && questionEntries.some(([key]) => !key.trim())) return null;

  const singleQuestion = questionEntries.length === 1;
  const allowCustomAnswer = isCoreForm
    ? questionEntries.some(
        ([key, prop]) =>
          isRecord(prop) &&
          (getEnumOptionSource(prop) === null || customFieldKeyByQuestionId.has(key))
      )
    : entries.some(([, prop]) => isFreeTextProperty(prop));
  const message = typeof request.message === 'string' ? request.message : '';

  const questions: AskUserQuestion[] = [];
  const fieldKeys: string[] = [];
  const customFieldKeys: Array<string | undefined> = [];
  for (const [key, prop] of questionEntries) {
    if (!isRecord(prop)) continue;
    const source = getEnumOptionSource(prop);
    const header = typeof prop.title === 'string' ? prop.title : '';
    const description = typeof prop.description === 'string' ? prop.description : '';
    const noteFieldId = noteFieldKeyByQuestionId.get(key);
    const noteProp = noteFieldId === undefined ? undefined : schema.properties[noteFieldId];
    const question =
      singleQuestion && !isCoreForm
        ? message || description || header
        : description || message || header;

    questions.push({
      ...(isCoreForm ? { id: key } : {}),
      question,
      header,
      options: source ? parseElicitationOptions(source) : [],
      multiSelect: isMultiSelectProperty(prop),
      ...(isCoreForm
        ? { allowCustomAnswer: source === null || customFieldKeyByQuestionId.has(key) }
        : {}),
      ...(isCoreForm && getElicitationMeta(prop._meta)?.secret === true ? { isSecret: true } : {}),
      ...(noteFieldId !== undefined && isRecord(noteProp)
        ? {
            note: {
              fieldId: noteFieldId,
              ...(typeof noteProp.title === 'string' ? { title: noteProp.title } : {}),
              ...(typeof noteProp.description === 'string'
                ? { description: noteProp.description }
                : {}),
              ...(getElicitationMeta(noteProp._meta)?.secret === true ? { isSecret: true } : {}),
            },
          }
        : {}),
    });
    fieldKeys.push(key);
    customFieldKeys.push(customFieldKeyByQuestionId.get(key));
  }

  if (questions.length === 0) return null;

  return {
    meta: {
      source: isCoreForm ? 'lody' : 'claude',
      version: 1,
      allowCustomAnswer,
      questions,
    },
    fieldKeys,
    ...(isCoreForm ? { customFieldKeys } : {}),
    ...(isCoreForm &&
    (typeof requestMeta?.autoResolveAfterSeconds === 'number' ||
      requestMeta?.autoResolveAfterSeconds === null)
      ? {
          autoResolutionMs:
            requestMeta.autoResolveAfterSeconds === null
              ? null
              : requestMeta.autoResolveAfterSeconds * 1000,
        }
      : {}),
  };
}

export function buildAskUserQuestionElicitationResponse(
  elicitation: AskUserQuestionElicitation,
  response: RequestPermissionResponse | null | undefined
): CreateElicitationResponse {
  const outcome = response?.outcome;
  if (!outcome || outcome.outcome !== 'selected' || outcome.optionId === 'cancel') {
    return { action: 'cancel' };
  }

  const answers = extractAskUserQuestionAnswersFromOutcome(elicitation.meta, {
    _meta: isRecord(outcome._meta) ? outcome._meta : null,
  });
  if (!answers) {
    return { action: 'accept', content: {} };
  }

  const content: Record<string, AskUserQuestionAnswerValue> = Object.create(null);
  elicitation.meta.questions.forEach((question, index) => {
    if (question.note) {
      const note = answers[question.note.fieldId];
      if (typeof note === 'string') content[question.note.fieldId] = note;
    }
    const fieldKey = elicitation.fieldKeys[index];
    if (!fieldKey) return;
    const value = answers[getAskUserQuestionAnswerKey(elicitation.meta.questions, index)];
    if (value === undefined) return;
    const customFieldKey = elicitation.customFieldKeys?.[index];
    const isCustomValue =
      typeof value === 'string' &&
      question.options.length > 0 &&
      !question.options.some((option) => option.label === value);
    content[isCustomValue && customFieldKey ? customFieldKey : fieldKey] = value;
  });

  return { action: 'accept', content };
}

// ============================================================================
// Grok Builtin Tool Permission Outcome
// ============================================================================

export function getBuiltinToolPermissionOutcome(args: {
  agentConfig?: { cliType: AgentConfigCliType; agentType: string };
  configOptions: readonly SessionConfigOption[];
  request: RequestPermissionRequest;
  pending: boolean;
}): RequestPermissionResponse['outcome'] | undefined {
  if (
    args.agentConfig?.cliType !== 'builtin' ||
    args.agentConfig.agentType !== 'grok' ||
    isAskUserQuestionPermissionRequest(args.request)
  ) {
    return undefined;
  }
  const permission = args.configOptions.find((option) => option.id === 'permission_mode');
  if (permission?.type !== 'select' || permission.currentValue !== 'always-approve') {
    return undefined;
  }
  const allowOnce = args.request.options.find((option) => option.kind === 'allow_once');
  if (allowOnce) return { outcome: 'selected', optionId: allowOnce.optionId };
  return args.pending ? { outcome: 'cancelled' } : undefined;
}

// ============================================================================
// Extension Capabilities & Messages (Dual Prefix: _meta.ua / _meta.lody)
// ============================================================================

const VersionOneSchema = z.object({ version: z.literal(1) });
const GoalActionSchema = z.enum(['set', 'pause', 'resume', 'clear']);
const ExtensionCapabilitiesSchema = z
  .object({
    sessionTitle: VersionOneSchema.optional().catch(undefined),
    subagentEvents: VersionOneSchema.optional().catch(undefined),
    usage: VersionOneSchema.optional(),
    rateLimits: VersionOneSchema.extend({ query: z.literal(true).optional() }).optional(),
    forkAtTurn: VersionOneSchema.optional(),
    steering: VersionOneSchema.extend({
      transport: z.enum(['request', 'prompt']),
      upstreamTurn: z.enum(['same', 'handoff']),
      configPolicy: z.enum(['active', 'apply']),
    }).optional(),
    tasks: VersionOneSchema.extend({
      background: z.literal(true).optional(),
      scheduled: z.literal(true).optional(),
    }).optional(),
    subagents: VersionOneSchema.extend({
      lifecycle: z.literal(true),
      list: z.literal(true).optional(),
      cancel: z.literal(true).optional(),
      output: z.literal(true).optional(),
    }).optional(),
    goal: VersionOneSchema.extend({
      actions: z.array(GoalActionSchema),
      controlActions: z.array(GoalActionSchema).optional(),
      promptActions: z.array(GoalActionSchema).optional(),
    }).optional(),
    compaction: VersionOneSchema.optional(),
    sessionHistory: VersionOneSchema.optional(),
    worktreeProject: VersionOneSchema.optional(),
    sessionActivity: VersionOneSchema.optional().catch(undefined),
  })
  .partial();

const SessionActivityUpdateSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  state: z.enum(['idle', 'running', 'requires_action']),
  backgroundTaskCount: z.number().int().nonnegative(),
});

const ModelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadInputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
  reasoningOutputTokens: z.number().nonnegative().optional(),
  webSearchRequests: z.number().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
  contextWindow: z.number().positive().optional(),
});

const SessionUsageUpdateSchema = z.object({
  sessionId: z.string().min(1),
  usage: ModelUsageSchema,
  modelUsage: z.record(z.string(), ModelUsageSchema).optional(),
  delta: z
    .object({
      usage: ModelUsageSchema,
      modelUsage: z.record(z.string(), ModelUsageSchema),
    })
    .optional(),
});

const RateLimitWindowSchema = z.object({
  label: z.string().optional(),
  usedPercent: z.number().min(0).max(100),
  windowDurationSeconds: z.number().nonnegative().nullable(),
  resetsAtEpochSeconds: z.number().int().positive().nullable(),
});

const RateLimitWalletSchema = z.object({
  balanceCents: z.number(),
  totalCents: z.number(),
  monthlyChargeLimitEnabled: z.boolean(),
  monthlyChargeLimitCents: z.number(),
  monthlyUsedCents: z.number(),
  currency: z.string().min(1),
});

const RateLimitSchema = z.object({
  limitId: z.string().min(1),
  scope: z.object({
    providerId: z.string().min(1),
    accountId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  }),
  limitName: z.string().nullable().optional(),
  planName: z.string().nullable().optional(),
  windows: z.array(RateLimitWindowSchema),
  wallet: RateLimitWalletSchema.nullable().optional(),
});

const RateLimitsSnapshotSchema = z.object({
  rateLimits: z.array(RateLimitSchema),
  fetchedAtEpochSeconds: z.number().nonnegative().optional(),
});

const LegacyProposedPlanSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  turnId: z.string(),
  markdown: z.string(),
  status: z.enum(['delta', 'completed', 'cleared']),
  isLatest: z.boolean(),
});

const MessagePhaseSchema = z.enum(['commentary', 'final_answer']);

const LEGACY_METHODS = {
  usageUpdate: '_acp_ext:session_usage_update',
  rateLimitsUpdate: '_acp_ext:session_rate_limits',
  proposedPlan: '_acp_ext:codex_proposed_plan',
  claudeTaskLifecycle: '_claude/taskLifecycle',
  kimiTaskLifecycle: '_kimi/taskLifecycle',
} as const;

export type ExtensionEvent =
  | { readonly type: 'subagent'; readonly event: SubagentEvent }
  | { readonly type: 'usage'; readonly update: SessionUsageUpdate; readonly accountingId?: string }
  | { readonly type: 'rateLimits'; readonly snapshot: RateLimitsSnapshot }
  | { readonly type: 'sessionActivity'; readonly update: SessionActivityUpdate }
  | {
      readonly type: 'legacyProposedPlan';
      readonly plan: z.infer<typeof LegacyProposedPlanSchema>;
    }
  | {
      readonly type: 'legacyTaskLifecycle';
      readonly provider: 'claude' | 'kimi';
      readonly params: Record<string, unknown>;
    };

/** @deprecated Use `ExtensionEvent`. */
export type LodyExtensionEvent = ExtensionEvent;

export function parseExtensionCapabilities(
  meta: Record<string, unknown> | null | undefined
): ExtensionCapabilities {
  const container = getExtensionMetaContainer(meta);
  const parsed = ExtensionCapabilitiesSchema.safeParse(container);
  const capabilities = parsed.success ? parsed.data : {};
  const legacyKimi = meta?.['lody.ai/kimi'];
  const legacyKimiParsed = z
    .object({
      protocolVersion: z.literal(1),
      features: z.object({
        subagentLifecycle: z.literal(true).optional(),
        subagentManagement: z.literal(true).optional(),
      }),
    })
    .safeParse(legacyKimi);
  if (!legacyKimiParsed.success || capabilities.subagents) return capabilities;
  const features = legacyKimiParsed.data.features;
  if (!features.subagentLifecycle && !features.subagentManagement) return capabilities;
  return {
    ...capabilities,
    subagents: {
      version: 1,
      lifecycle: true,
      ...(features.subagentManagement ? { list: true, cancel: true, output: true } : {}),
    },
  };
}

/** @deprecated Use `parseExtensionCapabilities`. */
export const parseLodyExtensionCapabilities = parseExtensionCapabilities;

export function parseRateLimitsSnapshot(value: unknown): RateLimitsSnapshot {
  return RateLimitsSnapshotSchema.parse(value);
}

export function parseMessagePhase(
  meta: Record<string, unknown> | null | undefined
): z.infer<typeof MessagePhaseSchema> | undefined {
  const container = getExtensionMetaContainer(meta);
  const canonical = z.object({ messagePhase: MessagePhaseSchema }).safeParse(container);
  if (canonical.success) return canonical.data.messagePhase;

  const legacy = z.object({ phase: MessagePhaseSchema }).safeParse(meta?.codex);
  return legacy.success ? legacy.data.phase : undefined;
}

/** @deprecated Use `parseMessagePhase`. */
export const parseLodyMessagePhase = parseMessagePhase;

const UsageScopeIdSchema = z.string().min(1).max(MAX_USAGE_SCOPE_ID_LENGTH);

function parseUsageScopeId(params: Record<string, unknown>, provider: string): string | null {
  const ext = getExtensionMetaContainer(params._meta);
  const scoped = z.object({ usageScopeId: UsageScopeIdSchema }).safeParse(ext);
  if (scoped.success) return scoped.data.usageScopeId;
  if (provider !== 'codex') return null;
  const legacy = z
    .object({ _meta: z.object({ codex: z.object({ usageTurnId: UsageScopeIdSchema }) }) })
    .safeParse(params);
  return legacy.success ? legacy.data._meta.codex.usageTurnId : null;
}

export function normalizePersistedRateLimit(
  provider: string,
  accountId: string | null,
  raw: unknown
): RateLimit | null {
  const direct = RateLimitSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (!isRecord(raw)) return null;
  const limitId = typeof raw.limitId === 'string' && raw.limitId ? raw.limitId : `${provider}:default`;
  const windows = z.array(RateLimitWindowSchema).safeParse(raw.windows);
  if (!windows.success) return null;
  return {
    limitId,
    scope: {
      providerId: provider,
      ...(accountId ? { accountId } : {}),
    },
    windows: windows.data,
  };
}

export function parseExtensionMessage(args: {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
  provider: string;
}): ExtensionEvent | null {
  const method = normalizeExtensionMethod(args.method);
  if (method === SUBAGENT_EVENT_METHOD) {
    return isSubagentEvent(args.params) && args.params.sessionId === args.sessionId
      ? { type: 'subagent', event: args.params }
      : null;
  }
  if (method === EXTENSION_METHODS.sessionUsageUpdate) {
    const update = SessionUsageUpdateSchema.parse(args.params);
    const scopeId = parseUsageScopeId(args.params, args.provider);
    return {
      type: 'usage',
      update,
      ...(scopeId
        ? { accountingId: `${args.sessionId}:scope:${encodeURIComponent(scopeId)}` }
        : {}),
    };
  }
  if (method === EXTENSION_METHODS.rateLimitsUpdate) {
    return { type: 'rateLimits', snapshot: parseRateLimitsSnapshot(args.params) };
  }
  if (method === EXTENSION_METHODS.sessionActivityUpdate) {
    return { type: 'sessionActivity', update: SessionActivityUpdateSchema.parse(args.params) };
  }

  if (method === LEGACY_METHODS.usageUpdate) {
    return {
      type: 'usage',
      update: SessionUsageUpdateSchema.parse({ ...args.params, sessionId: args.sessionId }),
    };
  }
  if (method === LEGACY_METHODS.rateLimitsUpdate) {
    const rateLimit = normalizePersistedRateLimit(args.provider, null, args.params);
    return rateLimit ? { type: 'rateLimits', snapshot: { rateLimits: [rateLimit] } } : null;
  }
  if (method === LEGACY_METHODS.proposedPlan) {
    return { type: 'legacyProposedPlan', plan: LegacyProposedPlanSchema.parse(args.params) };
  }
  if (method === LEGACY_METHODS.claudeTaskLifecycle) {
    return { type: 'legacyTaskLifecycle', provider: 'claude', params: args.params };
  }
  if (method === LEGACY_METHODS.kimiTaskLifecycle) {
    return { type: 'legacyTaskLifecycle', provider: 'kimi', params: args.params };
  }
  return null;
}

/** @deprecated Use `parseExtensionMessage`. */
export const parseLodyExtensionMessage = parseExtensionMessage;

// ============================================================================
// Devin Subagent Lifecycle Meta Helpers
// ============================================================================

export const DEVIN_SUBAGENT_STARTED_META_KEY = 'cognition.ai/subagent_started';
export const DEVIN_SUBAGENT_COMPLETED_META_KEY = 'cognition.ai/subagent_completed';
export const DEVIN_SUBAGENT_CONTEXT_META_KEY = 'cognition.ai/subagent_context';

const DevinSubagentStartedSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().optional(),
  task: z.string().optional(),
  profile: z.string().optional(),
  isBackground: z.boolean().optional(),
  model: z.string().optional(),
});

const DevinSubagentCompletedSchema = z.object({
  agentId: z.string().min(1),
  success: z.boolean().optional(),
  summary: z.string().optional(),
});

const DevinSubagentContextSchema = z.object({
  parentAgentId: z.string().min(1),
});

export const parseDevinSubagentTaskMeta = (
  meta: unknown
): { taskId: string; status: 'in_progress' | 'completed' | 'failed' } | null => {
  if (!isRecord(meta)) return null;

  const completed = DevinSubagentCompletedSchema.safeParse(meta[DEVIN_SUBAGENT_COMPLETED_META_KEY]);
  if (completed.success) {
    const c = completed.data;
    return {
      taskId: c.agentId,
      status: c.success === false ? 'failed' : 'completed',
    };
  }

  const started = DevinSubagentStartedSchema.safeParse(meta[DEVIN_SUBAGENT_STARTED_META_KEY]);
  if (started.success) {
    return {
      taskId: started.data.agentId,
      status: 'in_progress',
    };
  }

  return null;
};

export const getDevinSubagentContextId = (meta: unknown): string | null => {
  if (!isRecord(meta)) return null;
  const parsed = DevinSubagentContextSchema.safeParse(meta[DEVIN_SUBAGENT_CONTEXT_META_KEY]);
  if (!parsed.success || parsed.data.parentAgentId === 'root') return null;
  return parsed.data.parentAgentId;
};

export const hasOtherDevinSubagentMeta = (meta: unknown): boolean =>
  isRecord(meta) &&
  Object.keys(meta).some(
    (key) => key.startsWith('cognition.ai/subagent') && key !== DEVIN_SUBAGENT_CONTEXT_META_KEY
  );

// ============================================================================
// Legacy Claude / Kimi Task Lifecycle Notification Converter
// ============================================================================

const TaskUsageSchema = z
  .object({
    total_tokens: z.number().optional(),
    tool_uses: z.number().optional(),
    duration_ms: z.number().optional(),
  })
  .passthrough();

const BaseTaskMessageSchema = z
  .object({
    type: z.literal('system').optional(),
    task_id: z.string().min(1),
    tool_use_id: z.string().optional(),
    description: z.string().optional(),
    subagent_type: z.string().optional(),
    task_type: z.string().optional(),
    uuid: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

const TaskStartedMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_started'),
  prompt: z.string().optional(),
  skip_transcript: z.boolean().optional(),
  workflow_name: z.string().optional(),
});

const TaskProgressMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_progress'),
  usage: TaskUsageSchema.optional(),
  last_tool_name: z.string().optional(),
});

const TaskUpdatedMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_updated'),
  patch: z
    .object({
      status: z.string().optional(),
      error: z.string().optional(),
      is_backgrounded: z.boolean().optional(),
    })
    .passthrough(),
});

const TaskNotificationMessageSchema = BaseTaskMessageSchema.extend({
  subtype: z.literal('task_notification'),
  status: z.string().optional(),
  output_file: z.string().optional(),
  summary: z.string().optional(),
  usage: TaskUsageSchema.optional(),
});

const TaskLifecycleParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    acpSessionId: z.string().optional(),
    message: z.discriminatedUnion('subtype', [
      TaskStartedMessageSchema,
      TaskProgressMessageSchema,
      TaskUpdatedMessageSchema,
      TaskNotificationMessageSchema,
    ]),
  })
  .passthrough();

export type TaskLifecycleConversionResult =
  | { ok: true; notification: AcpSessionNotification }
  | { ok: false; reason: string };

export const convertTaskLifecycleNotification = (
  params: unknown,
  options: { defaultActor: string }
): TaskLifecycleConversionResult => {
  const parsed = TaskLifecycleParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }
  const message = parsed.data.message;
  const taskId = message.task_id;
  const event = message.subtype;
  const rawStatus =
    event === 'task_updated'
      ? message.patch.status
      : event === 'task_notification'
        ? message.status
        : undefined;
  const normStatus = rawStatus?.trim().toLowerCase();
  const status: 'pending' | 'in_progress' | 'completed' | 'failed' =
    event === 'task_started' || event === 'task_progress'
      ? 'in_progress'
      : normStatus === 'completed' || normStatus === 'complete' || normStatus === 'succeeded' || normStatus === 'success'
        ? 'completed'
        : normStatus === 'failed' || normStatus === 'killed' || normStatus === 'cancelled' || normStatus === 'canceled' || normStatus === 'stopped' || normStatus === 'error'
          ? 'failed'
          : normStatus === 'pending'
            ? 'pending'
            : 'in_progress';
  const actor = message.subagent_type?.trim() || options.defaultActor;
  const detail = message.description?.trim() || (event === 'task_notification' ? message.summary?.trim() : undefined) || rawStatus?.trim();
  const title = detail ? `${actor}: ${detail}` : actor;
  const task: TaskMeta = {
    version: 1,
    taskId,
    kind: event === 'task_updated' && message.patch.is_backgrounded ? 'background' : 'subagent',
    status,
    actor,
    ...(message.description ? { description: message.description } : {}),
    ...(message.tool_use_id ? { parentToolCallId: message.tool_use_id } : {}),
  };
  const updateBase = {
    toolCallId: `task:${taskId}`,
    title,
    kind: 'think' as const,
    status,
    _meta: { ua: { task }, lody: { task } },
  };
  const update =
    event === 'task_started'
      ? { sessionUpdate: 'tool_call' as const, ...updateBase }
      : { sessionUpdate: 'tool_call_update' as const, ...updateBase };
  try {
    return {
      ok: true,
      notification: parseSessionNotification({ sessionId: parsed.data.sessionId, update }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
