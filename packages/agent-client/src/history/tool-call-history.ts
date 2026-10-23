import type { MessageContent } from './types';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type ToolCallContent = NonNullable<ToolCallMessage['content']>;
type ToolCallKind = ToolCallMessage['kind'] | null | undefined;
type ToolCallLocations = NonNullable<ToolCallMessage['locations']>;

export const deriveLocationsFromToolCallContent = (
  content: unknown
): ToolCallLocations | undefined => {
  if (!Array.isArray(content)) return undefined;
  const paths = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (!('type' in block)) continue;
    if ((block as { type?: unknown }).type !== 'diff') continue;
    const maybePath = (block as { path?: unknown }).path;
    if (typeof maybePath !== 'string' || maybePath.length === 0) continue;
    paths.add(maybePath);
  }
  if (paths.size === 0) return undefined;
  return Array.from(paths).map((path) => ({ path }));
};

export const deriveLocationsFromRawInput = (rawInput: unknown): ToolCallLocations | undefined => {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const record = rawInput as Record<string, unknown>;

  const candidates: unknown[] = [
    record.path,
    record.file_path,
    record.filePath,
    record.absolute_file_path,
  ];

  const args = record.args;
  if (args && typeof args === 'object') {
    const argsRecord = args as Record<string, unknown>;
    candidates.push(
      argsRecord.path,
      argsRecord.file_path,
      argsRecord.filePath,
      argsRecord.absolute_file_path
    );
  }

  const unique = new Set<string>();
  for (const value of candidates) {
    if (typeof value !== 'string' || value.length === 0) continue;
    unique.add(value);
  }
  if (unique.size === 0) return undefined;
  return Array.from(unique).map((path) => ({ path }));
};

const isToolImagePayload = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const { type, resource } = value as { type?: unknown; resource?: unknown };
  if (type === 'image') return true;
  if (type !== 'resource' || !resource || typeof resource !== 'object') return false;
  if (!('blob' in resource)) return false;
  const { mimeType, uri } = resource as { mimeType?: unknown; uri?: unknown };
  return (
    (typeof mimeType === 'string' && mimeType.trim().toLowerCase().startsWith('image/')) ||
    (typeof uri === 'string' && uri.trim().toLowerCase().startsWith('data:image/'))
  );
};

export const stripToolCallPayloadsForHistory = (content: ToolCallContent): ToolCallContent =>
  content
    .filter((block) => block.type !== 'content' || !isToolImagePayload(block.content))
    .map((block) => {
      if (block.type !== 'content') return block;
      const value = block.content;
      if (value.type === 'resource') {
        const resource = value.resource;
        const clearBlob =
          'blob' in resource && typeof resource.blob === 'string' && resource.blob !== '';
        const clearUri = typeof resource.uri === 'string' && /^\s*data:/i.test(resource.uri);
        if (!clearBlob && !clearUri) return block;
        return {
          ...block,
          content: {
            ...value,
            resource: {
              ...resource,
              ...(clearBlob ? { blob: '' } : {}),
              ...(clearUri ? { uri: '' } : {}),
            },
          },
        };
      }
      if (value.type === 'resource_link' && /^\s*data:/i.test(value.uri))
        return { ...block, content: { ...value, uri: '' } };
      return block;
    });

export const stripToolCallContentForHistory = (
  kind: ToolCallKind,
  content: ToolCallContent
): ToolCallContent => {
  if (kind === 'read') {
    return content.filter((block) => block.type === 'terminal_command');
  }
  if (kind === 'edit') {
    return content.filter((block) => block.type !== 'diff' && block.type !== 'content');
  }
  return stripToolCallPayloadsForHistory(content);
};
