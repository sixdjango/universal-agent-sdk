import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const QUESTION_PREFIX = "lody-question:";
export const questionsSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      question: z.string().min(1),
      header: z.string().default("Question"),
      options: z
        .array(
          z.object({ label: z.string(), description: z.string().optional() }),
        )
        .default([]),
      allowCustomAnswer: z.boolean().default(true),
    }),
  )
  .min(1)
  .max(8)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Question ids must be unique",
  );
const todosSchema = z.array(
  z.object({ id: z.number().int(), text: z.string(), done: z.boolean() }),
);
type Todo = z.infer<typeof todosSchema>[number];
const result = (details: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(details) }],
  details,
});

/** Packaged tools only: each execute returns all of its work to Pi's tool await. */
export function registerBuiltinTools(
  pi: ExtensionAPI,
  emit: (ctx: ExtensionContext, event: unknown) => void,
) {
  let todos: Todo[] = [];
  const publish = (ctx: ExtensionContext) =>
    emit(ctx, { type: "lody_todos", todos });
  pi.on("session_start", (_event, ctx) => {
    todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "message" ||
        entry.message.role !== "toolResult" ||
        !["todo", "codemode"].includes(entry.message.toolName)
      )
        continue;
      const snapshot = z
        .object({ todos: todosSchema })
        .safeParse(entry.message.details);
      if (snapshot.success) todos = snapshot.data.todos;
    }
    publish(ctx);
  });
  // Nested calls are metadata in Pi's native history, not separate tool results.
  // Keep the todo snapshot on the persisted outer result as well.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "codemode") return;
    const details = z.record(z.string(), z.unknown()).safeParse(event.details);
    return { details: { ...(details.success ? details.data : {}), todos } };
  });
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage the task checklist displayed in Lody. List, add, toggle completed, or clear items.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "toggle", "clear"] },
        text: { type: "string" },
        id: { type: "integer" },
      },
      required: ["action"],
    } as ToolDefinition["parameters"],
    async execute(_id, input, _signal, _update, ctx) {
      const args = z
        .object({
          action: z.enum(["list", "add", "toggle", "clear"]),
          text: z.string().min(1).optional(),
          id: z.number().int().optional(),
        })
        .parse(input);
      if (args.action === "add") {
        if (!args.text) throw new Error("Todo text is required");
        todos = [
          ...todos,
          {
            id: Math.max(0, ...todos.map((item) => item.id)) + 1,
            text: args.text,
            done: false,
          },
        ];
      } else if (args.action === "toggle") {
        if (!todos.some((item) => item.id === args.id))
          throw new Error("Todo id does not exist");
        todos = todos.map((item) =>
          item.id === args.id ? { ...item, done: !item.done } : item,
        );
      } else if (args.action === "clear") todos = [];
      // The returned snapshot is persisted by Pi; the UI is only its projection.
      publish(ctx);
      return result({ todos });
    },
  });
  pi.registerTool({
    name: "questionnaire",
    label: "Question",
    description:
      "Ask the user one or more questions in Lody and wait for answers. Only the main agent can ask questions.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              question: { type: "string" },
              header: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["label"],
                },
              },
              allowCustomAnswer: { type: "boolean" },
            },
            required: ["id", "question"],
          },
        },
      },
      required: ["questions"],
    } as ToolDefinition["parameters"],
    async execute(toolCallId, input, signal, _update, ctx) {
      const { questions } = z
        .object({ questions: questionsSchema })
        .parse(input);
      const answer = await ctx.ui.input(
        QUESTION_PREFIX + JSON.stringify({ toolCallId, questions }),
        undefined,
        { signal },
      );
      return result(
        answer === undefined
          ? { cancelled: true }
          : { cancelled: false, answers: JSON.parse(answer) },
      );
    },
  });
}
