import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { AcpSessionNotification, ModelInfo, SessionTurnInputConfig } from '../types';
import {
  type ApplyNotificationOnHistoryOptions,
  applyNotificationOnHistoryWithChange,
} from './history-apply';
import type { MessageContent, SessionHistoryEntry } from './types';

export type SessionHistoryAccumulatorOptions = {
  initialHistory?: SessionHistoryEntry[];
  model?: ModelInfo;
  createId?: () => string;
  now?: () => string;
  onChange?: (history: SessionHistoryEntry[]) => void;
};

const contentBlocksToMessageItems = (
  input: string | acp.ContentBlock[] | MessageContent[]
): MessageContent[] => {
  if (typeof input === 'string') {
    return input ? [{ type: 'text', text: input }] : [];
  }
  const items: MessageContent[] = [];
  for (const block of input) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      items.push({ type: 'text', text: block.text });
      continue;
    }
    if ('imageId' in block || 'toolCallId' in block || 'taskId' in block || 'entries' in block) {
      items.push(block as MessageContent);
    }
  }
  return items;
};

/**
 * Stateful session turn/message accumulator that converts streaming `AcpSessionNotification`
 * deltas and user prompts into a unified `SessionHistoryEntry[]` turn list.
 */
export class SessionHistoryAccumulator {
  private history: SessionHistoryEntry[];
  private model?: ModelInfo;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly onChange?: (history: SessionHistoryEntry[]) => void;

  constructor(options: SessionHistoryAccumulatorOptions = {}) {
    this.history = options.initialHistory ? [...options.initialHistory] : [];
    this.model = options.model;
    this.createId = options.createId ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.onChange = options.onChange;
  }

  /** Record a user prompt turn and close any previous unfinished assistant turn. */
  appendUserTurn(
    input: string | acp.ContentBlock[] | MessageContent[],
    options: {
      id?: string;
      timestamp?: string;
      inputConfig?: SessionTurnInputConfig;
      userId?: string;
    } = {}
  ): SessionHistoryEntry {
    this.completeActiveAssistantTurn();
    const entry: SessionHistoryEntry = {
      id: options.id ?? this.createId(),
      role: 'user',
      items: contentBlocksToMessageItems(input),
      timestamp: options.timestamp ?? this.now(),
      finished: true,
      ...(options.inputConfig ? { inputConfig: options.inputConfig } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
    };
    this.history.push(entry);
    this.onChange?.(this.history);
    return entry;
  }

  /** Apply a single ACP `session/update` notification onto the accumulated history. */
  applyNotification(
    notification: AcpSessionNotification,
    options?: ApplyNotificationOnHistoryOptions
  ): { history: SessionHistoryEntry[]; changed: boolean } {
    return this.applyNotifications([notification], options);
  }

  /** Apply a batch of ACP `session/update` notifications onto the accumulated history. */
  applyNotifications(
    notifications: AcpSessionNotification[],
    options?: ApplyNotificationOnHistoryOptions
  ): { history: SessionHistoryEntry[]; changed: boolean } {
    const result = applyNotificationOnHistoryWithChange(this.history, notifications, this.model, {
      createId: this.createId,
      now: this.now,
      ...options,
    });
    if (result.changed) {
      this.onChange?.(this.history);
    }
    return result;
  }

  /** Mark the active assistant turn (if any) as finished. */
  completeActiveAssistantTurn(options: { endedAt?: number } = {}): SessionHistoryEntry | undefined {
    const last = this.history[this.history.length - 1];
    if (!last || last.role !== 'assistant' || last.finished === true) {
      return undefined;
    }
    last.finished = true;
    last.endedAt = options.endedAt ?? Date.now();
    this.onChange?.(this.history);
    return last;
  }

  /** Update the model metadata attached to newly created assistant turns. */
  setModelInfo(model: ModelInfo | undefined): void {
    this.model = model;
  }

  /** Return the current accumulated turn history. */
  getHistory(): SessionHistoryEntry[] {
    return this.history;
  }

  /** Return the latest assistant turn entry, if any. */
  getLatestAssistantTurn(): SessionHistoryEntry | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (entry?.role === 'assistant') {
        return entry;
      }
    }
    return undefined;
  }

  /** Return the unified `MessageContent[]` items of the latest assistant turn. */
  getLatestAssistantItems(): MessageContent[] {
    return this.getLatestAssistantTurn()?.items ?? [];
  }

  /** Clear all accumulated history entries. */
  clear(): void {
    this.history = [];
    this.onChange?.(this.history);
  }
}

export const createSessionHistoryAccumulator = (
  options?: SessionHistoryAccumulatorOptions
): SessionHistoryAccumulator => new SessionHistoryAccumulator(options);
