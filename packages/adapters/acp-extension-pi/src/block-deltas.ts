export type BlockDelta = { kind: "text" | "thinking"; text: string };

/**
 * Keeps a native text block's deltas contiguous. Pi's openai-completions
 * provider keeps streaming reasoning into its single thinking block after text
 * has started, and may open that block only after text. ACP clients merge only
 * adjacent same-kind chunks, so interleaved reasoning would split one native
 * text block. Text is the visible content: it is emitted immediately, and
 * reasoning arriving during a text run waits until that run closes.
 */
export class BlockDeltaSequencer {
  private textRun = false;
  private deferred = "";

  /** Returns the deltas to emit now, in order. */
  push(delta: BlockDelta): BlockDelta[] {
    if (delta.kind === "text") this.textRun = true;
    else if (this.textRun) {
      this.deferred += delta.text;
      return [];
    }
    return [delta];
  }

  /** Closes the text run, releasing deferred reasoning as one delta. */
  close(): BlockDelta[] {
    const text = this.deferred;
    this.textRun = false;
    this.deferred = "";
    return text ? [{ kind: "thinking", text }] : [];
  }
}
