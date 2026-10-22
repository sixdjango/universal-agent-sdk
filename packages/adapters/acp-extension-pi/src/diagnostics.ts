const MAX_LINES = 8;
const MAX_LINE_CHARACTERS = 500;
const MAX_PENDING_CHARACTERS = 4096;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

// Pi stderr may contain provider/auth output; only extension failures cross ACP.
const RELEVANT_PATTERNS = [
  /Failed to load extension/,
  /conflicts with/,
  /^Hint: .*extension/i,
];

export class PiStderrDiagnostics {
  private readonly lines: string[] = [];
  private pendingLine = "";
  private hasFailure = false;
  private active = true;

  constructor(private readonly shouldReport: () => boolean = () => true) {}

  append(chunk: string): void {
    if (!this.active) return;
    const lines = (this.pendingLine + chunk).split(/\r?\n/);
    this.pendingLine = lines.pop() ?? "";
    if (
      this.pendingLine &&
      RELEVANT_PATTERNS.some((pattern) => pattern.test(this.pendingLine))
    )
      this.hasFailure = true;
    if (this.pendingLine.length > MAX_PENDING_CHARACTERS)
      this.pendingLine = this.pendingLine.slice(-MAX_PENDING_CHARACTERS);
    for (const rawLine of lines) this.push(rawLine);
  }

  stop(): void {
    this.active = false;
    this.lines.length = 0;
    this.pendingLine = "";
    this.hasFailure = false;
  }

  decorateError(error: unknown): Error {
    const failure =
      error instanceof Error ? error : new Error("Pi RPC connection closed");
    if (!this.active || !this.hasFailure || !this.shouldReport())
      return failure;
    const buffered = this.pendingLine
      ? [...this.lines, this.pendingLine]
      : this.lines;
    const relevant = buffered.filter((line) =>
      RELEVANT_PATTERNS.some((pattern) => pattern.test(line)),
    );
    if (!relevant.length) return failure;
    return Object.assign(
      new Error(`${failure.message}\n${relevant.join("\n")}`),
      {
        cause: failure,
      },
    );
  }

  private push(line: string): void {
    const cleanLine = line.replace(ANSI_PATTERN, "").trim();
    if (!cleanLine) return;
    if (RELEVANT_PATTERNS.some((pattern) => pattern.test(cleanLine)))
      this.hasFailure = true;
    this.lines.push(cleanLine.slice(0, MAX_LINE_CHARACTERS));
    if (this.lines.length > MAX_LINES)
      this.lines.splice(0, this.lines.length - MAX_LINES);
  }
}
