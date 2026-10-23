import { z } from 'zod';

/**
 * Claude Code ACP uses a different format than Codex for `rawInput/rawOutput` and
 * uses `_meta.claudeCode` for tool responses. This module handles parsing those
 * Claude Code-specific structures defensively.
 */

export const ClaudeCodeBashRawInputSchema = z
  .object({
    command: z.string().optional(),
    description: z.string().optional(),
    timeout: z.number().optional(),
  })
  .passthrough();

export type ClaudeCodeBashRawInput = z.infer<typeof ClaudeCodeBashRawInputSchema>;

export const ClaudeCodeBashToolResponseSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    interrupted: z.boolean().optional(),
    isImage: z.boolean().optional(),
    noOutputExpected: z.boolean().optional(),
  })
  .passthrough()
  .refine((data) => data.stdout !== undefined || data.stderr !== undefined, {
    message: 'At least one of stdout or stderr must be present',
  });

export type ClaudeCodeBashToolResponse = z.infer<typeof ClaudeCodeBashToolResponseSchema>;

const LegacyToolResponseSchema = z.array(
  z.object({
    type: z.string(),
    text: z.string().optional(),
  })
);

export const ClaudeCodeMetaSchema = z
  .object({
    claudeCode: z
      .object({
        toolName: z.string().optional(),
        toolResponse: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();

export type ClaudeCodeMeta = z.infer<typeof ClaudeCodeMetaSchema>;

export const parseClaudeCodeTerminalCommand = (
  rawInput: unknown
): { command: string; args: string[]; cwd?: string } | null => {
  const parsed = ClaudeCodeBashRawInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return null;
  }

  const value = parsed.data;
  if (typeof value.command !== 'string' || value.command.length === 0) {
    return null;
  }

  return {
    command: value.command,
    args: [],
    cwd: undefined,
  };
};

export const parseClaudeCodeTerminalOutput = (
  meta: unknown
): {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
} | null => {
  const parsed = ClaudeCodeMetaSchema.safeParse(meta);
  if (!parsed.success) {
    return null;
  }

  const claudeCode = parsed.data.claudeCode;
  if (!claudeCode?.toolResponse) {
    return null;
  }

  const toolResponse = claudeCode.toolResponse;

  const bashParsed = ClaudeCodeBashToolResponseSchema.safeParse(toolResponse);
  if (bashParsed.success) {
    const data = bashParsed.data;
    return {
      stdout: data.stdout,
      stderr: data.stderr,
      exitCode: undefined,
      truncated: undefined,
    };
  }

  const legacyParsed = LegacyToolResponseSchema.safeParse(toolResponse);
  if (legacyParsed.success) {
    const textResponse = legacyParsed.data.find(
      (r) => r.type === 'text' && typeof r.text === 'string'
    );
    if (textResponse?.text) {
      return parseLegacyTerminalOutputText(textResponse.text);
    }
  }

  return null;
};

const parseLegacyTerminalOutputText = (
  text: string
): { output?: string; exitCode?: number; truncated?: boolean } => {
  const exitMatch = text.match(/^Exited with code (\d+)\.(?:Final output:)?\s*\n\n?([\s\S]*)$/);
  if (exitMatch) {
    return {
      output: exitMatch[2] ?? '',
      exitCode: parseInt(exitMatch[1] ?? '0', 10),
      truncated: false,
    };
  }

  const truncatedMatch = text.match(
    /^Exited with code (\d+)\.(?:Final output \(truncated\):)?\s*\n\n?([\s\S]*)$/
  );
  if (truncatedMatch) {
    return {
      output: truncatedMatch[2] ?? '',
      exitCode: parseInt(truncatedMatch[1] ?? '0', 10),
      truncated: true,
    };
  }

  return { output: text, exitCode: undefined, truncated: false };
};

export const isClaudeCodeTool = (meta: unknown): boolean => {
  if (!meta || typeof meta !== 'object') return false;
  const record = meta as Record<string, unknown>;
  return record.claudeCode !== undefined;
};

export const getClaudeCodeToolName = (meta: unknown): string | undefined => {
  const parsed = ClaudeCodeMetaSchema.safeParse(meta);
  if (!parsed.success) return undefined;
  return parsed.data.claudeCode?.toolName;
};
