import { randomUUID } from "node:crypto";
import { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type {
  CreateElicitationRequest,
  ClientCapabilities,
  ElicitationAcceptAction,
  ElicitationPropertySchema,
  ElicitationSchema,
  EnumOption,
} from "@agentclientprotocol/sdk";
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { LodyElicitationMeta } from "acp-extension-core";
import {
  AIR_CUSTOM_ANSWER_KEY,
  LEGACY_AIR_CUSTOM_ANSWER_KEY,
  withAirMeta,
} from "./air-extension.js";

/**
 * Bridges between the Claude Agent SDK's elicitation/dialog callbacks and ACP's
 * (unstable) elicitation protocol.
 *
 * Two distinct SDK surfaces flow through here:
 *
 *   1. `onElicitation` — fired when an MCP server requests user input. These map
 *      directly onto ACP `session/create_elicitation` (form or url mode).
 *   2. The built-in AskUserQuestion tool — when a `canUseTool` callback is
 *      registered the SDK routes its permission check through `canUseTool`
 *      (not the interactive `permission_ask_user_question` dialog). We render
 *      its questions as an ACP form elicitation and feed the user's selections
 *      back as the tool's `updatedInput`, which the tool's own `call()` reads.
 */

/** Modes the connected client advertised support for. */
export type ElicitationSupport = {
  form: boolean;
  url: boolean;
};

/**
 * Convert an MCP elicitation request (from the SDK's `onElicitation` callback)
 * into an ACP `CreateElicitationRequest`. Returns `null` when the request can't
 * be represented (e.g. a url-mode request with no url).
 */
export function mcpElicitationToCreateRequest(
  request: ElicitationRequest,
  sessionId: string,
): CreateElicitationRequest | null {
  if (request.mode === "url") {
    if (!request.url) {
      return null;
    }
    return {
      mode: "url",
      sessionId,
      message: request.message,
      url: request.url,
      // URL elicitations need a stable id so the client can correlate the
      // later `session/complete_elicitation` notification. MCP servers usually
      // provide one; fall back to a generated id if not.
      elicitationId: request.elicitationId ?? randomUUID(),
    };
  }

  // Form mode (the default). The MCP `requestedSchema` is already a JSON Schema
  // with primitive-typed properties, which is structurally what ACP expects.
  return {
    mode: "form",
    sessionId,
    message: request.message,
    requestedSchema: normalizeElicitationSchema(request.requestedSchema),
  };
}

/**
 * Content of an accepted elicitation response.
 *
 * Uses the SDK's validating guard rather than an `action === "accept"` check:
 * the guard both narrows past the union's custom/future variant and validates
 * the payload, so a malformed accept (right tag, ill-typed content) yields
 * empty content — the same classification the SDK's wire validators apply.
 */
function acceptedElicitationContent(
  response: CreateElicitationResponse,
): NonNullable<ElicitationAcceptAction["content"]> {
  return CreateElicitationResponse.isAccept(response) ? (response.content ?? {}) : {};
}

/**
 * Map an ACP elicitation response back to the MCP `ElicitResult` the SDK expects
 * to hand back to the requesting server.
 */
export function createElicitationResponseToElicitResult(
  response: CreateElicitationResponse,
): ElicitationResult {
  switch (response.action) {
    case "accept":
      return { action: "accept", content: acceptedElicitationContent(response) };
    case "decline":
      return { action: "decline" };
    case "cancel":
    default:
      return { action: "cancel" };
  }
}

/**
 * A single question as supplied by the AskUserQuestion tool. Derived from the
 * SDK's input type so the shape stays in sync; the SDK validates the model's
 * tool call against this schema before it reaches us.
 */
export type AskUserQuestion = AskUserQuestionInput["questions"][number];

/**
 * Pull the well-formed questions out of an AskUserQuestion tool input. Returns
 * `null` when there are no usable questions — including the case where every
 * entry is malformed and filtering leaves an empty list — so callers can treat
 * "nothing to ask" uniformly.
 */
export function extractAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] | null {
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const valid = questions.filter(
    (q): q is AskUserQuestion =>
      !!q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0,
  );
  return valid.length > 0 ? valid : null;
}

/** Stable form-field key for the question at the given index. */
function questionFieldKey(index: number): string {
  return `question_${index}`;
}

/**
 * Form-field key for the per-question free-text "custom answer" field that sits
 * alongside `question_<n>`. Mirrors the first-party clients, where every
 * question carries its own "Other" box rather than one form-level field.
 */
function questionCustomFieldKey(index: number): string {
  return `question_${index}_custom`;
}

const lodyElicitationMeta = (meta: Omit<LodyElicitationMeta, "version">) => ({
  lody: { elicitation: { version: 1 as const, ...meta } },
});

export function clientSupportsAnswerNotes(capabilities?: ClientCapabilities | null): boolean {
  const lody = capabilities?._meta?.lody as
    { elicitation?: { version?: unknown; answerNotes?: unknown } } | undefined;
  return (
    !!capabilities?.elicitation?.form &&
    lody?.elicitation?.version === 1 &&
    lody.elicitation.answerNotes === true
  );
}

/**
 * Render the AskUserQuestion tool's questions as an ACP form elicitation.
 *
 * Fields are keyed by a short stable id (`question_<n>`) rather than the full
 * question text, so the question text appears in exactly one place per field.
 * Single-select questions use a titled `oneOf` enum; multi-select questions use
 * an array with a titled `anyOf` item enum. The enum `const` is always the
 * option label, since that is what the tool records as the answer; an option's
 * secondary text travels in the enum option's own `description` field.
 *
 * Each question is followed by its own optional free-text "custom answer" field
 * (`question_<n>_custom`), mirroring the CLI's per-question "Other" box: the
 * user can type their own answer instead of picking an option. Clients that
 * negotiate Core answerNotes also get a separate additive note field. Nothing is
 * marked required, so the user can also just skip — matching the built-in tool,
 * which always offers Skip + a free-text box.
 */
export function askUserQuestionsToCreateRequest(
  questions: AskUserQuestion[],
  sessionId: string,
  toolCallId: string | undefined,
  answerNotes = false,
  airClient = false,
): CreateElicitationRequest {
  const single = questions.length === 1;
  const properties: Record<string, ElicitationPropertySchema> = {};

  questions.forEach((question, index) => {
    const options: EnumOption[] = question.options.map((option) => {
      const enumOption: EnumOption = {
        const: option.label,
        title: option.label,
      };
      if (option.description) {
        enumOption.description = option.description;
      }
      // The SDK option's `preview` (mockups, code snippets, comparisons shown
      // on focus) still has no structural slot in `EnumOption`, so forward it
      // under ACP's reserved `_meta` extension point for clients that render it.
      if (option.preview) {
        enumOption._meta = lodyElicitationMeta({ preview: option.preview });
      }
      return enumOption;
    });

    // For a single question the prompt is carried by `message`, so we don't
    // repeat it in the field description. With multiple questions each field
    // needs its own question text.
    const description = single ? undefined : question.question;
    const title = question.header || undefined;

    properties[questionFieldKey(index)] = question.multiSelect
      ? { type: "array", title, description, items: { anyOf: options } }
      : { type: "string", title, description, oneOf: options };

    const customAnswer = { questionId: questionFieldKey(index), isCustomAnswer: true };
    properties[questionCustomFieldKey(index)] = {
      type: "string",
      title: "Other",
      description: question.multiSelect
        ? "Type your own answer to add to your selection above (optional)."
        : "Type your own answer, or add a note to the option you chose above (optional).",
      // Marks the field as the custom answer companion of a select question,
      // under `_meta.jetbrains.air.customAnswer` and under the root key that
      // released AIR versions read. Only AIR gets the marker.
      _meta: lodyElicitationMeta({ customAnswerFor: questionFieldKey(index) }),
      ...(airClient
        ? {
            _meta: withAirMeta(
              {
                ...lodyElicitationMeta({ customAnswerFor: questionFieldKey(index) }),
                [LEGACY_AIR_CUSTOM_ANSWER_KEY]: customAnswer,
              },
              AIR_CUSTOM_ANSWER_KEY,
              customAnswer,
            ),
          }
        : {}),
    };
    if (answerNotes) {
      properties[`question_${index}_note`] = {
        type: "string",
        title: "Note",
        description: "Add a note without replacing your answer (optional).",
        _meta: lodyElicitationMeta({ noteFor: questionFieldKey(index) }),
      };
    }
  });

  const requestedSchema: ElicitationSchema = {
    type: "object",
    properties,
  };

  const message = single ? questions[0].question : "Please answer the following questions.";

  return {
    mode: "form",
    sessionId,
    ...(toolCallId ? { toolCallId } : {}),
    message,
    requestedSchema,
  };
}

/** Outcome of an AskUserQuestion elicitation, decoupled from any transport. */
export type AskUserQuestionOutcome =
  { action: "answered"; updatedInput: Record<string, unknown> } | { action: "cancel" };

/**
 * Serialize a multi-select answer the way the CLI's own AskUserQuestion UI
 * does: comma-joined, with any item that itself contains the separator (or a
 * double quote) JSON-quoted. The tool's `call()` splits the string back on the
 * same rule, so a free-text answer like `Redis, not Memcached` stays one item
 * instead of reading as two more picks.
 */
function joinMultiSelectAnswer(items: string[]): string {
  return items
    .map((item) => (item.includes(", ") || item.includes('"') ? JSON.stringify(item) : item))
    .join(", ");
}

/**
 * Fold an ACP elicitation response into the AskUserQuestion tool's input.
 *
 * Selected labels are read back from the indexed form fields and written into
 * `answers` as a `{ [questionText]: label }` map — the key shape the tool's own
 * `call()` reads — with multi-selects comma-joined in the CLI's own quoted form
 * (see `joinMultiSelectAnswer`). A non-empty custom-answer field replaces the
 * selection for either question kind, preserving Core customAnswerFor semantics.
 * Negotiated `question_<n>_note` fields independently populate the SDK's
 * `annotations[question].notes`; they never replace the answer.
 * Decline yields empty answers (the model
 * is told the user skipped rather than the turn aborting); cancel — and any
 * custom/future action we don't understand — aborts the tool call.
 */
export function applyAskElicitationResponse(
  response: CreateElicitationResponse,
  toolInput: Record<string, unknown>,
  questions: AskUserQuestion[],
  answerNotes = false,
): AskUserQuestionOutcome {
  if (response.action === "decline") {
    return { action: "answered", updatedInput: { ...toolInput, answers: {} } };
  }

  if (response.action !== "accept") {
    return { action: "cancel" };
  }

  const content = acceptedElicitationContent(response);
  // Typed against the tool's own output schema so the answer/response shapes
  // stay in sync with what the built-in tool's call() expects to read back.
  const answers: AskUserQuestionOutput["answers"] = {};
  const annotations: NonNullable<AskUserQuestionInput["annotations"]> = {};
  questions.forEach((question, index) => {
    const custom = content[questionCustomFieldKey(index)];
    const customText = typeof custom === "string" ? custom.trim() : "";
    const note = answerNotes ? content[`question_${index}_note`] : undefined;
    if (typeof note === "string" && note.trim()) {
      annotations[question.question] = { notes: note.trim() };
    }
    // Core customAnswerFor replaces the selection. Additive notes use their
    // own negotiated field rather than changing the legacy "Other" contract.
    if (customText) {
      answers[question.question] = customText;
      return;
    }

    const value = content[questionFieldKey(index)];
    const picks: string[] =
      value === undefined || value === null
        ? []
        : Array.isArray(value)
          ? value.filter((item) => item !== undefined && item !== null && item !== "").map(String)
          : [String(value)];

    // Preserve the CLI's quoting when serializing multiple selected labels.
    if (question.multiSelect) {
      const text = joinMultiSelectAnswer(picks);
      if (text !== "") {
        answers[question.question] = text;
      }
      return;
    }

    // Single-select normally has one label; retain compatibility with arrays.
    const picked = picks.join(", ");
    if (picked !== "") answers[question.question] = picked;
  });

  return {
    action: "answered",
    updatedInput: {
      ...toolInput,
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
  };
}

/**
 * Coerce an arbitrary MCP `requestedSchema` into an ACP `ElicitationSchema`.
 * The two are structurally compatible JSON Schemas; we just guarantee the
 * `type: "object"` discriminator is present.
 */
function normalizeElicitationSchema(
  schema: Record<string, unknown> | undefined,
): ElicitationSchema {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return { ...(schema as ElicitationSchema), type: "object" };
}

/**
 * The `request_user_dialog` kind the CLI emits when a model refusal has a
 * fallback available but needs user consent before retrying (e.g. Claude Fable
 * declining a request with Opus available as the fallback). Declaring this
 * kind in `supportedDialogKinds` is the opt-in: the CLI fails closed and never
 * emits an undeclared kind — the flow degrades to the classic refusal error
 * ending the turn.
 */
export const REFUSAL_FALLBACK_DIALOG_KIND = "refusal_fallback_prompt";

/**
 * Payload of the `refusal_fallback_prompt` dialog. The dialog protocol
 * transports payloads opaquely, so this shape is recovered from the CLI's own
 * schema (v2.1.177): `originalModel`/`fallbackModel` are required strings;
 * `apiRefusalCategory` (nullable), `guidanceText`, and
 * `retractedMessageUuids` are optional. We ignore `retractedMessageUuids` —
 * ACP has no way to retract already-streamed chunks.
 */
export type RefusalFallbackPrompt = {
  originalModel: string;
  fallbackModel: string;
  apiRefusalCategory: string | null;
  guidanceText?: string;
};

/**
 * Validate the opaque dialog payload into a {@link RefusalFallbackPrompt}.
 * Returns `null` when the required fields are missing or mistyped (a newer CLI
 * may reshape the payload), so the caller can cancel the dialog and let the
 * CLI apply its default behavior instead of rendering something misleading.
 */
export function extractRefusalFallbackPrompt(
  payload: Record<string, unknown>,
): RefusalFallbackPrompt | null {
  const { originalModel, fallbackModel, apiRefusalCategory, guidanceText } = payload;
  if (typeof originalModel !== "string" || typeof fallbackModel !== "string") {
    return null;
  }
  return {
    originalModel,
    fallbackModel,
    apiRefusalCategory: typeof apiRefusalCategory === "string" ? apiRefusalCategory : null,
    ...(typeof guidanceText === "string" && guidanceText ? { guidanceText } : {}),
  };
}

/** Form-field key carrying the user's choice in the refusal-fallback form. */
const REFUSAL_FALLBACK_CHOICE_KEY = "choice";

/** Wire values of the dialog's result enum (CLI schema). `edit_prompt` is
 *  deliberately not offered: in the CLI it prefills the composer with the
 *  refused prompt for edit-and-retry, and ACP has no composer-prefill surface
 *  — the user can simply edit and resend on their own. */
const RETRY_FALLBACK_RESULT = "retry_fallback";
const KEEP_REFUSAL_RESULT = "cancelled";

/**
 * Render the refusal-fallback consent prompt as an ACP form elicitation: a
 * single-select between retrying on the fallback model and keeping the
 * refusal. The enum `const`s are the dialog's wire result values, so the
 * response maps back without a translation table.
 */
export function refusalFallbackToCreateRequest(
  prompt: RefusalFallbackPrompt,
  sessionId: string,
): CreateElicitationRequest {
  const category = prompt.apiRefusalCategory ? ` (${prompt.apiRefusalCategory})` : "";
  const guidance = prompt.guidanceText ? `\n\n${prompt.guidanceText}` : "";
  return {
    mode: "form",
    sessionId,
    message:
      `${prompt.originalModel} declined this request${category}. ` +
      `Retry with ${prompt.fallbackModel}?` +
      guidance,
    requestedSchema: {
      type: "object",
      properties: {
        [REFUSAL_FALLBACK_CHOICE_KEY]: {
          type: "string",
          oneOf: [
            {
              const: RETRY_FALLBACK_RESULT,
              title: `Retry with ${prompt.fallbackModel}`,
              description: `The session continues on ${prompt.fallbackModel}.`,
            },
            {
              const: KEEP_REFUSAL_RESULT,
              title: "Keep the refusal",
              description: "You can send a new message.",
            },
          ],
        },
      },
    },
  };
}

/**
 * Map the elicitation response back to the dialog's result enum. Only an
 * explicit accept-with-retry resolves to `retry_fallback`; decline, cancel, a
 * skipped field, or an unrecognized value all keep the refusal — the dialog's
 * own default — so a dismissed or half-filled form can never trigger a model
 * switch the user didn't ask for.
 */
export function refusalFallbackResultFromResponse(response: CreateElicitationResponse): string {
  const choice = acceptedElicitationContent(response)[REFUSAL_FALLBACK_CHOICE_KEY];
  return choice === RETRY_FALLBACK_RESULT ? RETRY_FALLBACK_RESULT : KEEP_REFUSAL_RESULT;
}
