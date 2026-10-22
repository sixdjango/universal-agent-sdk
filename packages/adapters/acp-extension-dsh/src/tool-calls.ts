import type {
  ContentBlock,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
} from '@agentclientprotocol/sdk';
import { resolve } from 'node:path';
import { z } from 'zod';

const blockSchema = z.object({ type: z.string() }).passthrough();
const resultSchema = z
  .object({
    role: z.literal('tool'),
    toolCallId: z.string().min(1),
    content: z.array(blockSchema),
    isError: z.boolean().optional(),
  })
  .passthrough();
const callSchema = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});
const ptcSchema = z.object({
  subCallId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
  parentCallId: z.string(),
  rootCallId: z.string(),
});
const locationSchema = z.object({ path: z.string(), line: z.number().int().positive().optional() });
const viewSchema = z
  .object({
    card: z.enum(['generic', 'terminal', 'diff', 'read', 'search', 'web']),
    title: z.string().optional(),
    kind: z
      .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])
      .optional(),
    locations: z.array(locationSchema).optional(),
    diffs: z
      .array(z.object({ path: z.string(), oldText: z.string().nullable(), newText: z.string() }))
      .optional(),
    output: z.string().optional(),
    content: z.array(blockSchema).optional(),
  })
  .passthrough();

type Block = z.infer<typeof blockSchema>;
type View = z.infer<typeof viewSchema>;
type ToolResult = { content: Block[]; isError: boolean; meta?: unknown };
export type ToolPresenter = {
  presentCall?(args: unknown): unknown;
  presentResult?(args: unknown, result: ToolResult): unknown;
};
type ActiveCall = { call: ToolCall; presenter?: ToolPresenter };

/** One projection per ACP-owned session. Native events remain the execution authority. */
export class ToolCallBridge {
  private readonly active = new Map<string, ActiveCall>();

  constructor(
    private readonly options: {
      cwd: string;
      lookup(name: string): ToolPresenter | undefined;
      content(block: Block): Promise<ContentBlock | undefined>;
      emit(update: SessionUpdate): Promise<void>;
      warn(message: string): void;
    }
  ) {}

  private view(present: (() => unknown) | undefined): View | undefined {
    try {
      const value = present?.();
      if (value === undefined) return undefined;
      const parsed = viewSchema.safeParse(value);
      if (parsed.success) return parsed.data;
      this.options.warn('Invalid tool presentation; using native arguments/result');
    } catch {
      this.options.warn('Tool presenter failed; using native arguments/result');
    }
    return undefined;
  }

  private async content(blocks: Block[]): Promise<ToolCallContent[]> {
    const content: ToolCallContent[] = [];
    for (const block of blocks) {
      try {
        const converted = await this.options.content(block);
        // Keep future/native blocks inspectable even before ACP has a renderer.
        content.push({
          type: 'content',
          content: converted ?? { type: 'text', text: JSON.stringify(block) },
        });
      } catch {
        content.push({
          type: 'content',
          content: { type: 'text', text: 'Tool attachment unavailable.' },
        });
      }
    }
    return content;
  }

  private async start(id: string, name: string, args: unknown): Promise<void> {
    if (this.active.has(id)) return;
    let presenter: ToolPresenter | undefined;
    try {
      presenter = this.options.lookup(name);
    } catch {
      /* Generic rendering remains available. */
    }
    const view = this.view(
      presenter?.presentCall ? () => presenter.presentCall?.(args) : undefined
    );
    const call: ToolCall = {
      toolCallId: id,
      name,
      title: view?.title ?? name,
      kind:
        view?.card === 'terminal'
          ? 'execute'
          : view?.card === 'diff'
            ? 'edit'
            : (view?.kind ?? 'other'),
      status: 'in_progress',
      rawInput: args,
      ...(view?.locations
        ? {
            locations: view.locations.map((location) => ({
              ...location,
              path: resolve(this.options.cwd, location.path),
            })),
          }
        : {}),
      ...(view?.content ? { content: await this.content(view.content) } : {}),
    };
    // Never publish argument-derived diffs as evidence of a completed mutation.
    this.active.set(id, { call, presenter });
    await this.options.emit({ sessionUpdate: 'tool_call', ...call });
  }

  private async finish(id: string, result: ToolResult, rawOutput: unknown): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    const view = this.view(
      !result.isError && active.presenter?.presentResult
        ? () => active.presenter?.presentResult?.(active.call.rawInput, result)
        : undefined
    );
    const content = await this.content(view?.content ?? result.content);
    if (view?.card === 'terminal' && view.output !== undefined) {
      content.splice(0, content.length, {
        type: 'content',
        content: { type: 'text', text: view.output },
      });
    }
    if (!result.isError && view?.card === 'diff' && view.diffs) {
      content.push(
        ...view.diffs.map((diff) => ({
          type: 'diff' as const,
          ...diff,
          path: resolve(this.options.cwd, diff.path),
        }))
      );
    }
    this.active.delete(id);
    await this.options.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: result.isError ? 'failed' : 'completed',
      ...(view?.title ? { title: view.title } : {}),
      content,
      rawOutput,
    });
  }

  permission(callId: string): ToolCall | undefined {
    const call = this.active.get(callId)?.call;
    return call ? { ...call, status: 'pending' } : undefined;
  }

  async interrupt(): Promise<void> {
    for (const id of this.active.keys()) {
      this.active.delete(id);
      await this.options.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Tool execution ended without a recorded result; the outcome is unknown.',
            },
          },
        ],
      });
    }
  }

  async event(type: string, data: unknown): Promise<void> {
    if (type === 'tool/call') {
      const call = callSchema.parse(data);
      let args: unknown = call.arguments;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        /* Preserve invalid model JSON verbatim. */
      }
      await this.start(call.callId, call.name, args);
    } else if (type === 'tool/result') {
      const event = z
        .object({
          message: resultSchema,
          meta: z.unknown().optional(),
        })
        .passthrough()
        .parse(data);
      const message = event.message;
      await this.finish(
        message.toolCallId,
        { content: message.content, isError: message.isError === true, meta: event.meta },
        event
      );
    } else if (type === 'tool/ptc-dispatch-start' || type === 'tool/ptc-dispatch') {
      const call = ptcSchema.parse(data);
      await this.start(call.subCallId, call.name, call.arguments);
      if (type === 'tool/ptc-dispatch') {
        const result = z
          .object({ content: z.array(blockSchema), isError: z.boolean() })
          .passthrough()
          .parse(data);
        await this.finish(call.subCallId, result, result);
      }
    } else if (type === 'turn/end') {
      await this.interrupt();
    }
  }
}
