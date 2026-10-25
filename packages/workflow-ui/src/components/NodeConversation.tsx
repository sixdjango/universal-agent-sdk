import { projectConversationMessages, type ConversationMessage, type ConversationPermission } from '@universal-agent/client/conversation';
import { useMemo, useState } from 'react';
import { useConversationTranscript, useNodeConversationCalls } from '../hooks/useConversations';
import { VirtualList } from './VirtualList';
import {
  callLabel, callStatus, conversationLink, conversationStatusLabel,
  type ConversationReader, type ConversationTranscript, type NodeConversationTarget,
} from '../model/conversation';

type ContentBlock = Extract<ConversationMessage, { kind: 'content' }>['content'][number];
const pretty = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function JsonDetails({ label, value, defaultOpen = false }: { label: string; value: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className="conversation-json" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && <pre>{pretty(value)}</pre>}
  </details>;
}

function ResourceLink({ uri, name }: { uri: string; name?: string }) {
  const href = conversationLink(uri);
  return <div className="conversation-resource">
    {href ? <a href={href} target="_blank" rel="noopener noreferrer">{name ?? uri}</a> : <span>{name ?? uri}</span>}
    {name && <code>{uri}</code>}
  </div>;
}

function Content({ block }: { block: ContentBlock }) {
  let body;
  switch (block.type) {
    case 'text': body = <pre className="conversation-text">{block.text}</pre>; break;
    case 'image': body = <>
      {/^(image\/(png|jpeg|webp|gif|avif|bmp))$/i.test(block.mimeType)
        ? <img className="conversation-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Agent message attachment" loading="lazy" />
        : <p>Image attachment · {block.mimeType}</p>}
      <JsonDetails label="Image data" value={block} />
    </>; break;
    case 'audio': body = <>
      {/^(audio\/[a-z0-9.+-]+)$/i.test(block.mimeType) &&
        <audio controls preload="none" aria-label="Audio message" src={`data:${block.mimeType};base64,${block.data}`} />}
      <JsonDetails label="Audio data" value={block} />
    </>; break;
    case 'resource_link': body = <><ResourceLink uri={block.uri} name={block.name} /><JsonDetails label="Resource details" value={block} /></>; break;
    case 'resource': body = <>
      <ResourceLink uri={block.resource.uri} />
      {'text' in block.resource && <pre className="conversation-text">{block.resource.text}</pre>}
      <JsonDetails label="Resource data" value={block} />
    </>; break;
    default: body = <JsonDetails label="Message content" value={block} defaultOpen />;
  }
  return <div className="conversation-content">{body}
    {('_meta' in block && block._meta || 'annotations' in block && block.annotations) &&
      <JsonDetails label="Content metadata" value={block} />}
  </div>;
}

/** ACP text chunks are fragments, so do not insert visual newlines between them. */
function ContentSequence({ blocks }: { blocks: ContentBlock[] }) {
  const groups: (ContentBlock | Extract<ContentBlock, { type: 'text' }>[])[] = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.type !== 'text') groups.push(block);
    else if (Array.isArray(previous)) previous.push(block);
    else groups.push([block]);
  }
  return <>{groups.map((group, index) => Array.isArray(group)
    ? <div className="conversation-content" key={index}>
      <pre className="conversation-text">{group.map(block => block.text).join('')}</pre>
      {group.some(block => block._meta || block.annotations) && <JsonDetails label="Content metadata" value={group} />}
    </div> : <Content key={index} block={group} />)}</>;
}

function Permission({ permission, resolved }: { permission: ConversationPermission; resolved: boolean }) {
  const outcome = permission.response?.outcome;
  const choice = outcome?.outcome === 'selected' ? permission.request.options.find(option => option.optionId === outcome.optionId) : undefined;
  const label = !resolved ? 'Requested' : permission.status === 'answered'
    ? choice?.kind.startsWith('reject') ? 'Denied' : choice?.kind.startsWith('allow') ? 'Allowed' : 'Answered'
    : permission.status === 'cancelled' ? 'Cancelled' : permission.status === 'expired' ? 'Expired' : 'Awaiting permission';
  return <article className="conversation-message" data-kind="permission">
    <header><strong>Permission · {label}</strong><span>{permission.request.toolCall.title ?? permission.request.toolCall.toolCallId}</span></header>
    {!resolved && <p>{permission.request.options.map(option => option.name).join(' / ') || 'No options supplied'}</p>}
    {choice && <p>{choice.name}</p>}
    <JsonDetails label={resolved ? 'Permission result' : 'Permission request'} value={permission} />
  </article>;
}

function Message({ message }: { message: ConversationMessage }) {
  if (message.kind === 'content') return <article className="conversation-message" data-kind={message.channel === 'thought' ? 'thought' : message.role}>
    <header><strong>{message.channel === 'thought' ? 'Thought' : message.role === 'user' ? 'Input' : message.role === 'assistant' ? 'Assistant' : 'System'}</strong></header>
    <ContentSequence blocks={message.content} />
  </article>;
  if (message.kind === 'tool_call') {
    const tool = message.toolCall;
    return <article className="conversation-message" data-kind="tool">
      <header><strong>{tool.title ?? 'Tool call'}</strong><span className="conversation-badge" data-status={tool.status}>{tool.status ?? 'Unknown'}</span></header>
      <div className="conversation-meta">{tool.kind ?? 'tool'} · {tool.toolCallId}</div>
      {tool.rawInput !== undefined && <JsonDetails label="Input" value={tool.rawInput} defaultOpen />}
      {tool.rawOutput !== undefined && <JsonDetails label="Output" value={tool.rawOutput} defaultOpen />}
      {tool.content?.map((part, index) => part.type === 'content' ? <Content key={index} block={part.content} />
        : part.type === 'diff' ? <div key={index} className="conversation-diff">
          <strong>{part.path}</strong>
          <JsonDetails label="Before" value={part.oldText ?? ''} />
          <JsonDetails label="After" value={part.newText} defaultOpen />
        </div> : part.type === 'terminal' ? <p key={index}>Terminal reference: <code>{part.terminalId}</code></p>
          : <JsonDetails key={index} label="Tool content" value={part} />)}
      <JsonDetails label="Tool details" value={tool} />
    </article>;
  }
  if (message.kind === 'plan') return <article className="conversation-message" data-kind="plan">
    <header><strong>Plan</strong></header>
    <ol>{message.plan.entries.map((entry, index) => <li key={index}><span>{entry.content}</span> <small>{entry.status} · {entry.priority}</small></li>)}</ol>
    <JsonDetails label="Plan details" value={message.plan} />
  </article>;
  if (message.kind === 'event') {
    const event = message.event;
    if (event.type === 'permission.requested' || event.type === 'permission.resolved') return <Permission permission={event.permission} resolved={event.type === 'permission.resolved'} />;
    return <JsonDetails label={event.type === 'session.event' ? event.name : event.type === 'custom' ? `${event.namespace} · ${event.name}` : event.type} value={event} />;
  }
  return null;
}

/**
 * Read-only rendering of the SDK projection; the original ordered events remain inspectable.
 * `follow` keeps the newest message in view while the call is still being recorded.
 */
export function ConversationTranscriptView({ value, follow = false }: { value: ConversationTranscript; follow?: boolean }) {
  const status = callStatus(value);
  const turn = value.turns.at(-1);
  const { messages, sessionEvents, replay } = useMemo(() => {
    const replay = value.events.filter(event => event.data.type === 'acp.update' && event.data.origin === 'replay');
    const projected = projectConversationMessages(value.events.filter(event => !(event.data.type === 'acp.update' && event.data.origin === 'replay')));
    return {
      replay,
      messages: projected.filter(message => !(message.kind === 'event' && message.event.type === 'session.event')),
      sessionEvents: projected.filter(message => message.kind === 'event' && message.event.type === 'session.event'),
    };
  }, [value.events]);
  return <div className="conversation-transcript">
    <div className="conversation-outcome" data-status={status} role="status">
      <strong>{status === 'unavailable' ? 'Status unavailable' : conversationStatusLabel[status]}</strong>
      {turn?.stopReason && <span> · {turn.stopReason}</span>}
      {turn?.error && <pre>{turn.error}</pre>}
      {status === 'waiting_permission' && <p>Waiting for the workflow’s permission policy.</p>}
    </div>
    <div className="conversation-meta">
      <time dateTime={new Date(value.record.createdAtMs).toISOString()}>{new Date(value.record.createdAtMs).toLocaleString()}</time>
      {turn?.endedAtMs !== undefined && <span> · {((turn.endedAtMs - (turn.startedAtMs ?? turn.createdAtMs)) / 1000).toFixed(1)}s</span>}
    </div>
    <JsonDetails label="Execution identity" value={{ conversationId: value.record.id, nativeSessionId: value.record.nativeSessionId, ...value.record.source?.identifiers }} />
    {messages.length > 0 && <VirtualList className="conversation-messages" aria-label="Messages" items={messages}
      itemKey={message => message.id} estimateSize={96} gap={10} follow={follow} renderItem={message => <Message message={message} />} />}
    {value.complete && messages.length === 0 && <p className="conversation-muted">No messages were recorded for this call.</p>}
    {sessionEvents.length > 0 && <details className="conversation-extra"><summary>Session events ({sessionEvents.length})</summary>
      {sessionEvents.map(message => <Message key={message.id} message={message} />)}
    </details>}
    {replay.length > 0 && <JsonDetails label={`Replayed session history (${replay.length} events)`} value={replay} />}
    <JsonDetails label={`Full event log (${value.events.length})`} value={value.events} />
  </div>;
}

interface NodeConversationProps {
  reader: ConversationReader;
  target: NodeConversationTarget;
  live: boolean;
}

function NodeConversationContent({ reader, target, live }: NodeConversationProps) {
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useNodeConversationCalls(reader, target, live, refresh);
  const selected = list.calls.find(call => call.record.id === selectedId) ?? list.calls.at(-1);
  const history = useConversationTranscript(reader, selected?.record.id ?? null, refresh);
  return <section className="node-conversation" aria-label="Node conversation">
    <div className="conversation-toolbar">
      <label>Execution
        <select aria-label="Conversation execution" value={selected?.record.id ?? ''} disabled={!list.calls.length}
          onChange={event => setSelectedId(event.target.value)}>
          {!list.calls.length && <option value="">No recorded calls</option>}
          {list.calls.map((call, index) => <option value={call.record.id} key={call.record.id}>{callLabel(call, index)}</option>)}
        </select>
      </label>
      <button type="button" className="btn" onClick={() => setRefresh(value => value + 1)}>Refresh</button>
    </div>
    {(list.error || history.error) && <div className="conversation-error" role="alert">{list.error ?? history.error}<p>Refresh to retry. Loaded history is kept.</p></div>}
    {!list.calls.length && <p className="conversation-muted" role="status">
      {list.loading ? 'Loading conversations…' : list.error ? 'Could not load conversations.' : live ? 'Waiting for conversation to be recorded…' : 'No conversation was recorded for this execution.'}
    </p>}
    {selected && <div key={selected.record.id} className="conversation-history">
      {history.value && <ConversationTranscriptView value={history.value} follow={live} />}
      {history.loading && <p className="conversation-muted" role="status">{history.value ? `Loading history… ${history.value.events.length} events` : 'Loading history…'}</p>}
    </div>}
  </section>;
}

export function NodeConversation(props: NodeConversationProps) {
  return <NodeConversationContent key={JSON.stringify(props.target)} {...props} />;
}
