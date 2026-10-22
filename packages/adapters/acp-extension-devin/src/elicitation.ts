import type {
  LodyElicitationOption,
  LodyElicitationQuestion,
} from "acp-extension-core";

import { privateWireContract as contract } from "./manifest.js";

const ALLOW_OTHER_META = contract.elicitationAllowOtherMeta;

type WireRecord = Record<string, unknown>;

function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** clientCapabilities._meta.lody.elicitation === {version: 1, ...} */
export function clientSupportsLodyElicitation(capabilities: unknown): boolean {
  if (!isRecord(capabilities)) return false;
  const meta = capabilities["_meta"];
  if (!isRecord(meta)) return false;
  const lody = meta["lody"];
  if (!isRecord(lody)) return false;
  const elicitation = lody["elicitation"];
  return isRecord(elicitation) && elicitation["version"] === 1;
}

function extractOptions(entries: unknown): LodyElicitationOption[] {
  if (!Array.isArray(entries)) return [];
  const options: LodyElicitationOption[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      options.push({ label: entry });
      continue;
    }
    if (!isRecord(entry)) continue;
    const value = entry["const"];
    const title = entry["title"];
    const description = entry["description"];
    const label =
      typeof value === "string"
        ? value
        : typeof title === "string"
          ? title
          : undefined;
    if (label === undefined) continue;
    const option: LodyElicitationOption = { label };
    // Devin emits the option's display text in `title` and the submitted
    // label in `const`; `description` is the fallback for other agents.
    const detail =
      typeof value === "string"
        ? typeof title === "string"
          ? title
          : typeof description === "string"
            ? description
            : undefined
        : typeof description === "string"
          ? description
          : undefined;
    if (detail !== undefined) option.description = detail;
    options.push(option);
  }
  return options;
}

function questionShape(property: WireRecord): {
  options: LodyElicitationOption[];
  multiSelect: boolean;
} {
  if (property["type"] === "array") {
    const items = isRecord(property["items"]) ? property["items"] : {};
    return {
      multiSelect: true,
      options: extractOptions(
        items["anyOf"] ?? items["oneOf"] ?? items["enum"],
      ),
    };
  }
  return {
    multiSelect: false,
    options: extractOptions(
      property["oneOf"] ?? property["anyOf"] ?? property["enum"],
    ),
  };
}

function hasOptions(property: WireRecord): boolean {
  if (property["type"] === "array") {
    const items = isRecord(property["items"]) ? property["items"] : {};
    return (
      Array.isArray(items["anyOf"]) ||
      Array.isArray(items["oneOf"]) ||
      Array.isArray(items["enum"])
    );
  }
  return (
    Array.isArray(property["oneOf"]) ||
    Array.isArray(property["anyOf"]) ||
    Array.isArray(property["enum"])
  );
}

function freeKey(base: string, properties: WireRecord): string {
  let key = `${base}__other`;
  for (let i = 2; key in properties; i += 1) key = `${base}__other_${i}`;
  return key;
}

export interface CustomAnswerField {
  /** The schema key the custom answer should be folded back into. */
  target: string;
  multiSelect: boolean;
}

export interface ElicitationRewrite {
  params: WireRecord;
  /** Injected free-text property key -> its question field. */
  customFields: Map<string, CustomAnswerField>;
}

/**
 * Devin's `ask_user_question` tool always offers an implicit "Other" free-text
 * choice, but the emitted `elicitation/create` schema only contains the option
 * properties (`q0`, `q1`, ...). The offer is flagged by the private
 * `_meta["cognition.ai/allowOther"]` marker, and the runtime records a custom
 * answer as the value of the question's own property.
 *
 * Clients consuming the Core contract express that affordance differently: an
 * extra free-text property marked `_meta.lody.elicitation.customAnswerFor`
 * turns on the question's "Other" input. The rewrite therefore:
 *
 *   1. adds a `<key>__other` string property after every option-bearing
 *      question, marked `customAnswerFor: <key>`;
 *   2. annotates the request with the Core `_meta.lody.elicitation` contract,
 *      including one `allowCustomAnswer` question per schema property.
 *
 * The companion keys are returned so the response can be folded back into the
 * question property Devin expects (see `foldElicitationResponse`). Returns
 * undefined when there is nothing to translate.
 */
export function rewriteElicitationParams(
  params: WireRecord,
): ElicitationRewrite | undefined {
  const meta = isRecord(params["_meta"]) ? params["_meta"] : undefined;
  if (meta?.[ALLOW_OTHER_META] !== true) return undefined;

  const schema = isRecord(params["requestedSchema"])
    ? params["requestedSchema"]
    : undefined;
  const properties =
    schema && isRecord(schema["properties"]) ? schema["properties"] : undefined;

  const questions: LodyElicitationQuestion[] = [];
  const customFields = new Map<string, CustomAnswerField>();
  const rewrittenProperties: WireRecord = {};
  if (properties) {
    for (const [fieldId, raw] of Object.entries(properties)) {
      rewrittenProperties[fieldId] = raw;
      if (!isRecord(raw)) continue;
      const { options, multiSelect } = questionShape(raw);
      questions.push({
        id: fieldId,
        question:
          typeof raw["description"] === "string" ? raw["description"] : "",
        header: typeof raw["title"] === "string" ? raw["title"] : "",
        options,
        multiSelect,
        allowCustomAnswer: true,
      });
      if (!hasOptions(raw)) continue;
      const customKey = freeKey(fieldId, {
        ...properties,
        ...rewrittenProperties,
      });
      rewrittenProperties[customKey] = {
        type: "string",
        title: "Other",
        description: multiSelect
          ? "Type your own answer instead of choosing options above."
          : "Type your own answer instead of choosing an option above.",
        _meta: {
          lody: {
            elicitation: {
              version: 1,
              customAnswerFor: fieldId,
              secret: false,
            },
          },
        },
      };
      customFields.set(customKey, { target: fieldId, multiSelect });
    }
  }

  const lody = isRecord(meta["lody"]) ? meta["lody"] : {};
  const elicitation = {
    ...(isRecord(lody["elicitation"]) ? lody["elicitation"] : {}),
    version: 1,
    questions,
  };
  return {
    params: {
      ...params,
      ...(schema
        ? { requestedSchema: { ...schema, properties: rewrittenProperties } }
        : {}),
      _meta: { ...meta, lody: { ...lody, elicitation } },
    },
    customFields,
  };
}

/**
 * Fold an `elicitation/create` response back onto the runtime's contract: a
 * non-empty companion answer replaces the referenced question's selection
 * (Core `customAnswerFor` semantics), and the companion keys are removed so
 * the runtime only ever sees its own `q<i>` fields. Returns undefined when the
 * response carries no companion answers to fold.
 */
export function foldElicitationResponse(
  result: unknown,
  customFields: Map<string, CustomAnswerField>,
): unknown | undefined {
  if (customFields.size === 0 || !isRecord(result)) return undefined;
  if (result["action"] !== "accept" || !isRecord(result["content"]))
    return undefined;

  const content = result["content"];
  let changed = false;
  const folded: WireRecord = { ...content };
  for (const [key, field] of customFields) {
    if (!(key in folded)) continue;
    const value = folded[key];
    delete folded[key];
    changed = true;
    if (typeof value === "string" && value.trim()) {
      folded[field.target] = field.multiSelect ? [value] : value;
    } else if (Array.isArray(value) && value.length > 0) {
      folded[field.target] = value;
    }
  }
  if (!changed) return undefined;
  return { ...result, content: folded };
}
