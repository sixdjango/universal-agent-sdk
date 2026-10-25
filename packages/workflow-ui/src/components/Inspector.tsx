import {
  type AssessmentVerdict,
  type ChiefLevel,
  ChiefPolicySchema,
  edgeConditionSource,
  supportsParallel,
  type EdgeCondition,
  type LoopNode,
  type ParallelNode,
  type PortDefinition,
  type PortValueType,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowValidationIssue,
} from '@universal-agent/workflow-contract';
import { type ReactNode, useEffect, useState } from 'react';
import type { AgentListing, AgentRuntimeInfo } from '../types';
import { RuntimeFields } from './RuntimeFields';
import { expandLoopIntoCycle } from '../model/cycle-editing';
import { describeCondition } from '../model/canvas';
import { conditionText } from '../model/conditions';
import {
  addWorkspaceSlot,
  inheritedWorkspaceSlot,
  defaultWorkspaceSlot,
  removeWorkspaceSlot,
  renameWorkspaceSlot,
  setDefaultWorkspaceSlot,
  updateWorkspaceSlot,
} from '../model/workspaces';
import { compilerScopePath, containerAt, graphAt, INPUTS_NODE_ID, OUTPUTS_NODE_ID, type ScopePath } from '../model/scope';
import {
  addPort,
  findControlEdge,
  findExecutionPath,
  implicitPorts,
  type PortSide,
  portsOf,
  removeEdge,
  removeNode,
  removePort,
  setEdgeCondition,
  updateLoopBack,
  updateNode,
  updatePort,
  updateWorkflowMeta,
} from '../model/editing';

export type InspectTarget = { type: 'node'; nodeId: string } | { type: 'edge'; edgeId: string } | { type: 'workflow' };

interface InspectorProps {
  readonly definition: WorkflowDefinition;
  /** Graph being edited (root, a loop body, or a parallel item graph). */
  readonly path: ScopePath;
  readonly target: InspectTarget;
  readonly agents: readonly AgentListing[];
  readonly runtimes: readonly AgentRuntimeInfo[];
  readonly issues: readonly WorkflowValidationIssue[];
  /** `coalesceKey` merges rapid edits of one field into a single undo step. */
  onChange(next: WorkflowDefinition, coalesceKey?: string): void;
  onClose(): void;
  onError(message: string): void;
  onOpenScope(nodeId: string): void;
  onRefreshRuntime(agentType: string): Promise<void>;
  /** Saved workflows a sub-flow step can run. */
  readonly workflows?: readonly { readonly id: string; readonly name: string }[];
  /** Points a sub-flow step at a saved workflow (the app loads it and copies its fields). */
  onChooseSubflow?(nodeId: string, workflowId: string): void;
  onOpenWorkflow?(workflowId: string): void;
}

const PORT_TYPES: PortValueType[] = ['string', 'json', 'artifact', 'assessment', 'number', 'boolean', 'array'];
const VERDICTS: AssessmentVerdict[] = ['PASS', 'NEEDS_FIX', 'FAIL', 'BLOCKED'];
const CHIEF_LEVELS: { value: ChiefLevel; label: string }[] = [
  { value: 'observe', label: 'Observe only' },
  { value: 'advise', label: 'Advise (add guidance)' },
  { value: 'escalate', label: 'Advise and ask me' },
  { value: 'operate', label: 'Operate (retry, swap agents)' },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        {hint && <em className="field-hint"> · {hint}</em>}
      </span>
      {children}
    </label>
  );
}

/** Text input committed on every keystroke (coalesced into one undo step per field). */
function TextField(props: { label: string; value: string; hint?: string; multiline?: boolean; onChange(value: string): void }) {
  return (
    <Field label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
      {props.multiline ? (
        <textarea rows={3} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <input type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      )}
    </Field>
  );
}

/** One entry per line; keeps the raw text locally so blank lines can be typed. */
function LinesField(props: { label: string; hint?: string; lines: readonly string[]; resetKey: string; onChange(lines: string[]): void }) {
  const [text, setText] = useState(props.lines.join('\n'));
  useEffect(() => setText(props.lines.join('\n')), [props.resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
      <textarea
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean));
        }}
      />
    </Field>
  );
}

function Toggle(props: { label: string; desc: string; checked: boolean; onChange(checked: boolean): void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>
        <span className="option-title">{props.label}</span>
        <span className="option-desc">{props.desc}</span>
      </span>
    </label>
  );
}

function PortName(props: { name: string; onRename(name: string): boolean }) {
  const [value, setValue] = useState(props.name);
  useEffect(() => setValue(props.name), [props.name]);
  const commit = () => {
    if (value.trim() && value !== props.name && !props.onRename(value.trim())) setValue(props.name);
  };
  return (
    <input
      type="text"
      value={value}
      aria-label="Field name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function PortsEditor(props: {
  title: string;
  definition: WorkflowDefinition;
  path: ScopePath;
  nodeId: string;
  side: PortSide;
  onChange: InspectorProps['onChange'];
  onError: InspectorProps['onError'];
}) {
  const ports: readonly PortDefinition[] = portsOf(props.definition, props.nodeId, props.side, props.path);
  const builtIn = new Set(implicitPorts(props.definition, props.nodeId, props.side, props.path).map((p) => p.name));
  return (
    <section className="inspector-section">
      <div className="section-title">{props.title}</div>
      {ports.length === 0 && <div className="popover-note">None yet. Connect a wire to the “+” row or add one here.</div>}
      {ports.map((port) =>
        builtIn.has(port.name) ? (
          <div key={port.name} className="port-row builtin">
            <input type="text" value={port.name} disabled aria-label="Built-in field" />
            <span className="field-hint">{port.type} · built in</span>
          </div>
        ) : (
        <div key={port.name} className="port-row">
          <PortName
            name={port.name}
            onRename={(name) => {
              const result = updatePort(props.definition, props.nodeId, props.side, port.name, { name }, props.path);
              if (!result.ok) {
                props.onError(result.error);
                return false;
              }
              props.onChange(result.definition);
              return true;
            }}
          />
          <select
            value={port.type}
            aria-label="Field type"
            onChange={(e) => {
              const result = updatePort(props.definition, props.nodeId, props.side, port.name, { type: e.target.value as PortValueType }, props.path);
              if (result.ok) props.onChange(result.definition);
            }}
          >
            {PORT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="port-required" title="Required">
            <input
              type="checkbox"
              checked={port.required}
              onChange={(e) => {
                const result = updatePort(props.definition, props.nodeId, props.side, port.name, { required: e.target.checked }, props.path);
                if (result.ok) props.onChange(result.definition);
              }}
            />
            req
          </label>
          <button
            type="button"
            className="icon-btn visible"
            aria-label={`Remove ${port.name}`}
            onClick={() => props.onChange(removePort(props.definition, props.nodeId, props.side, port.name, props.path))}
          >
            ×
          </button>
        </div>
        )
      )}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          const result = addPort(props.definition, props.nodeId, props.side, { name: props.side === 'in' ? 'input' : 'output' }, props.path);
          if (result.ok) props.onChange(result.definition);
          else props.onError(result.error);
        }}
      >
        + Add field
      </button>
    </section>
  );
}

/** Which slot a step (or a container's inner steps) works in; only shown once there is a choice. */
function WorkspaceField({ node, props, label, hint }: { node: WorkflowNode; props: InspectorProps; label: string; hint?: string }) {
  const slots = props.definition.workspaces;
  if (slots.length < 2 && !node.workspace) return null;
  const inherited = inheritedWorkspaceSlot(props.definition, props.path);
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <select
        aria-label={label}
        value={node.workspace ?? ''}
        onChange={(e) => props.onChange(updateNode(props.definition, node.id, { workspace: e.target.value || undefined }, props.path))}
      >
        <option value="">Same as {props.path.length > 0 ? 'its container' : 'the workflow'} ({inherited})</option>
        {slots.map((slot) => (
          <option key={slot.name} value={slot.name}>
            {slot.name}
            {slot.description ? ` · ${slot.description}` : ''}
          </option>
        ))}
      </select>
    </Field>
  );
}

const ISOLATION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Automatic (own copy only when others write at the same time)' },
  { value: 'worktree', label: 'Always in its own copy, merged back after' },
  { value: 'shared', label: 'Always directly in the workspace' },
];

/** How a writing step shares its workspace with other writers, and how strict its write scopes are. */
function WritePolicyFields({ node, props, container }: { node: WorkflowNode; props: InspectorProps; container?: boolean }) {
  const set = (patch: Record<string, unknown>) => props.onChange(updateNode(props.definition, node.id, patch, props.path));
  return (
    <>
      <Field label="Writes" hint={container ? 'for inner steps without their own' : 'needs a git workspace for copies'}>
        <select aria-label="Isolation" value={node.isolation ?? ''} onChange={(e) => set({ isolation: e.target.value || undefined })}>
          {ISOLATION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Toggle
        label="Enforce write scopes"
        desc="Fail the step when it changes files outside its write scopes (otherwise they are only reported)"
        checked={node.enforceWriteScopes ?? false}
        onChange={(v) => set({ enforceWriteScopes: v || undefined })}
      />
    </>
  );
}

/** Other slots an agent may read for reference. */
function ReadWorkspacesField({ node, props }: { node: WorkflowNode & { kind: 'agent' }; props: InspectorProps }) {
  const own = node.workspace ?? inheritedWorkspaceSlot(props.definition, props.path);
  const others = props.definition.workspaces.filter((s) => s.name !== own);
  if (others.length === 0) return null;
  return (
    <Field label="Can also read" hint="never writes there">
      <div className="check-list">
        {others.map((slot) => (
          <label key={slot.name} className="port-required">
            <input
              type="checkbox"
              checked={node.readWorkspaces.includes(slot.name)}
              onChange={(e) =>
                props.onChange(
                  updateNode(
                    props.definition,
                    node.id,
                    {
                      readWorkspaces: e.target.checked
                        ? [...node.readWorkspaces, slot.name]
                        : node.readWorkspaces.filter((s) => s !== slot.name),
                    },
                    props.path
                  )
                )
              }
            />
            {slot.name}
          </label>
        ))}
      </div>
    </Field>
  );
}

function WorkspaceSlotsEditor({ props }: { props: InspectorProps }) {
  const { definition } = props;
  const defaultSlot = defaultWorkspaceSlot(definition);
  return (
    <section className="inspector-section">
      <div className="section-title">Workspaces</div>
      <div className="popover-note">
        {definition.workspaces.length === 0
          ? 'Every step runs in one directory, chosen when you start a run. Add slots to let steps work in different projects.'
          : 'Placeholders for directories. Steps pick a slot; each run binds every slot to a workspace.'}
      </div>
      {definition.workspaces.map((slot) => (
        <div key={slot.name} className="slot-row">
          <div className="port-row">
            <PortName
              name={slot.name}
              onRename={(name) => {
                const result = renameWorkspaceSlot(definition, slot.name, name);
                if (!result.ok) {
                  props.onError(result.error);
                  return false;
                }
                props.onChange(result.definition);
                return true;
              }}
            />
            <label className="port-required" title="Steps without their own slot use this one">
              <input
                type="radio"
                name="default-workspace"
                checked={slot.name === defaultSlot}
                onChange={() => props.onChange(setDefaultWorkspaceSlot(definition, slot.name))}
              />
              default
            </label>
            <label className="port-required" title="A run cannot start without it">
              <input
                type="checkbox"
                checked={slot.required}
                onChange={(e) => props.onChange(updateWorkspaceSlot(definition, slot.name, { required: e.target.checked }))}
              />
              req
            </label>
            <button
              type="button"
              className="icon-btn visible"
              aria-label={`Remove ${slot.name}`}
              onClick={() => props.onChange(removeWorkspaceSlot(definition, slot.name))}
            >
              ×
            </button>
          </div>
          <div className="slot-desc">
            <input
              type="text"
              placeholder="What goes here, e.g. Frontend repo"
              aria-label={`${slot.name} description`}
              value={slot.description ?? ''}
              onChange={(e) => props.onChange(updateWorkspaceSlot(definition, slot.name, { description: e.target.value }), `slot:${slot.name}:desc`)}
            />
          </div>
        </div>
      ))}
      <button type="button" className="btn btn-ghost" onClick={() => props.onChange(addWorkspaceSlot(definition).definition)}>
        + Add workspace slot
      </button>
    </section>
  );
}

function NodeFields({ node, props }: { node: WorkflowNode; props: InspectorProps }) {
  const set = (field: string, value: unknown, coalesce = true) =>
    props.onChange(updateNode(props.definition, node.id, { [field]: value }, props.path), coalesce ? `${node.id}:${field}` : undefined);

  return (
    <>
      <TextField label="Name" value={node.name} onChange={(v) => set('name', v)} />
      {supportsParallel(node) && <section className="inspector-section">
        <Toggle label="Run items in parallel" desc="The chosen input receives a list. Each execution gets one item; every output is collected in input order."
          checked={Boolean(node.parallel)} onChange={(enabled) => {
            if (enabled && !node.inputs.length) { props.onError('Add an input field before enabling per-item execution.'); return; }
            set('parallel', enabled ? { itemsPort: node.inputs[0]!.name, maxConcurrency: 4, failurePolicy: 'settle_all' } : undefined, false);
          }} />
        {node.parallel && <>
          <Field label="List input" hint="each item keeps this field name">
            <select aria-label="Parallel list input" value={node.parallel.itemsPort} onChange={e => set('parallel', { ...node.parallel, itemsPort: e.target.value }, false)}>
              {node.inputs.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </Field>
          <TextField label="Maximum concurrent items" value={String(node.parallel.maxConcurrency)} onChange={v => /^\d+$/.test(v) && Number(v) > 0 && set('parallel', { ...node.parallel, maxConcurrency: Number(v) })} />
          <Field label="When an item fails">
            <select aria-label="Parallel failure policy" value={node.parallel.failurePolicy} onChange={e => set('parallel', { ...node.parallel, failurePolicy: e.target.value }, false)}>
              <option value="settle_all">Finish other items, then fail the batch</option>
              <option value="fail_fast">Cancel remaining items</option>
            </select>
          </Field>
          <div className="inspector-summary">Field types below describe one execution. On the graph, the selected input and all outputs are arrays. Each item keeps its own retries and conversation.</div>
        </>}
      </section>}
      {node.kind === 'agent' && (
        <>
          <Field label="Agent" hint="who performs it">
            <select value={node.agentRef?.split('@')[0] ?? ''} onChange={(e) => set('agentRef', e.target.value || undefined, false)}>
              <option value="">No agent (use role “{node.role}”)</option>
              {props.agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.name}
                  {a.profile?.runtime.agentType ? ` · ${a.profile.runtime.agentType}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <RuntimeFields
            value={{
              ...(node.agentType ? { agentType: node.agentType } : {}),
              ...(node.modelId ? { modelId: node.modelId } : {}),
              ...(node.effort ? { effort: node.effort } : {}),
            }}
            {...(() => {
              const agentRuntime = props.agents.find((a) => a.agentId === node.agentRef?.split('@')[0])?.profile?.runtime;
              return agentRuntime ? { agentRuntime } : {};
            })()}
            runtimes={props.runtimes}
            onChange={(next) =>
              props.onChange(
                updateNode(props.definition, node.id, { agentType: next.agentType, modelId: next.modelId, effort: next.effort }, props.path)
              )
            }
            onRefresh={props.onRefreshRuntime}
          />
          <TextField label="Goal" multiline value={node.goal} onChange={(v) => set('goal', v)} />
          <LinesField label="Acceptance criteria" hint="one per line, never truncated" lines={node.acceptanceCriteria} resetKey={node.id} onChange={(v) => set('acceptanceCriteria', v)} />
          <LinesField label="Constraints" hint="one per line" lines={node.constraints} resetKey={node.id} onChange={(v) => set('constraints', v)} />
          <Toggle
            label="Independent review"
            desc="Must return a verdict (PASS / NEEDS_FIX / FAIL / BLOCKED); no verdict counts as failed"
            checked={node.producesAssessment}
            onChange={(v) => set('producesAssessment', v, false)}
          />
          <TextField label="Role" hint="fallback binding when no agent is set" value={node.role} onChange={(v) => set('role', v)} />
          <WorkspaceField node={node} props={props} label="Workspace" hint="where it works" />
          <TextField
            label="Write scopes"
            hint="comma separated paths in its workspace; empty = read-only"
            value={node.writeScopes.join(', ')}
            onChange={(v) => set('writeScopes', v.split(',').map((x) => x.trim()).filter(Boolean))}
          />
          <ReadWorkspacesField node={node} props={props} />
          {node.writeScopes.length > 0 && <WritePolicyFields node={node} props={props} />}
        </>
      )}
      {node.kind === 'script' && (
        <>
          <TextField label="Command" value={node.command} onChange={(v) => set('command', v)} />
          <LinesField label="Arguments" hint="one per line" lines={node.args} resetKey={node.id} onChange={(v) => set('args', v)} />
          <WorkspaceField node={node} props={props} label="Workspace" hint="where it runs" />
          <TextField
            label="Working directory"
            hint="relative to the workspace"
            value={node.cwd ?? ''}
            onChange={(v) => set('cwd', v.trim() || undefined)}
          />
          <TextField
            label="Write scopes"
            hint="comma separated paths in its workspace; empty = read-only"
            value={node.writeScopes.join(', ')}
            onChange={(v) => set('writeScopes', v.split(',').map((x) => x.trim()).filter(Boolean))}
          />
          {node.writeScopes.length > 0 && <WritePolicyFields node={node} props={props} />}
          <TextField
            label="Timeout (seconds)"
            value={String(Math.round(node.timeoutMs / 1000))}
            onChange={(v) => Number(v) > 0 && set('timeoutMs', Math.round(Number(v) * 1000))}
          />
          <Toggle
            label="Pass / fix by exit code"
            desc="Exit 0 is PASS, anything else NEEDS_FIX"
            checked={node.producesAssessment}
            onChange={(v) => set('producesAssessment', v, false)}
          />
        </>
      )}
      {node.kind === 'subflow' && (
        <>
          <Field label="Workflow" hint="the saved workflow it runs">
            <select
              aria-label="Sub-flow workflow"
              value={node.workflowId ?? ''}
              onChange={(e) => e.target.value && props.onChooseSubflow?.(node.id, e.target.value)}
            >
              <option value="" disabled>
                Choose a workflow…
              </option>
              {(props.workflows ?? [])
                .filter((w) => w.id !== props.definition.id)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </Field>
          {node.workflowId && (
            <div className="inspector-row">
              <button type="button" className="btn" onClick={() => props.onChooseSubflow?.(node.id, node.workflowId!)} title="Copy its current inputs and outputs again">
                Refresh fields
              </button>
              <button type="button" className="btn" onClick={() => props.onOpenWorkflow?.(node.workflowId!)}>
                Open workflow
              </button>
            </div>
          )}
          <div className="inspector-summary">
            Its inputs and outputs are the workflow’s. Each run embeds the workflow as it is when the run starts.
          </div>
        </>
      )}
      {node.kind === 'gate' && (
        <>
          <TextField label="Question" multiline value={node.prompt} onChange={(v) => set('prompt', v)} />
          <LinesField
            label="Options"
            hint="value | label | description"
            lines={node.options.map((o) => [o.value, o.label, o.description].filter(Boolean).join(' | '))}
            resetKey={node.id}
            onChange={(lines) =>
              set(
                'options',
                lines.map((line) => {
                  const [value = '', label, description] = line.split('|').map((p) => p.trim());
                  return { value, label: label || value, ...(description ? { description } : {}) };
                })
              )
            }
          />
        </>
      )}
      {(node.kind === 'agent' || node.kind === 'script' || node.kind === 'gate') && (
        <TextField
          label="Technical retries"
          value={String(node.maxTechnicalRetries)}
          onChange={(v) => /^\d+$/.test(v) && set('maxTechnicalRetries', Number(v))}
        />
      )}
    </>
  );
}

const EXHAUSTED: { value: LoopNode['onExhausted']; label: string }[] = [
  { value: 'fail', label: 'Fail the step' },
  { value: 'gate', label: 'Ask me whether to accept it' },
  { value: 'pass_with_findings', label: 'Continue with the open findings' },
];

/** Settings of a loop or parallel step; its inner steps are edited by opening it. */
function ContainerFields({ node, props }: { node: LoopNode | ParallelNode; props: InspectorProps }) {
  const set = (patch: Record<string, unknown>, key?: string) =>
    props.onChange(updateNode(props.definition, node.id, patch, props.path), key ? `${node.id}:${key}` : undefined);
  const inner = node.kind === 'loop' ? node.bodyGraph : node.itemGraph;

  return (
    <>
      <TextField label="Name" value={node.name} onChange={(v) => set({ name: v }, 'name')} />
      <button type="button" className="btn open-scope" onClick={() => props.onOpenScope(node.id)}>
        Open its {inner.nodes.length} step{inner.nodes.length === 1 ? '' : 's'} ›
      </button>
      {node.kind === 'loop' && (
        <button
          type="button"
          className="btn open-scope"
          title="Put its steps on this canvas, with a way back from the deciding step"
          onClick={() => {
            const result = expandLoopIntoCycle(props.definition, node.id, props.path);
            if (result.ok) props.onChange(result.definition);
            else props.onError(result.error);
          }}
        >
          Expand onto the canvas ↻
        </button>
      )}
      {node.kind === 'loop' ? (
        <>
          <TextField
            label="Max rounds"
            value={String(node.maxRounds)}
            onChange={(v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 50 && set({ maxRounds: Number(v) }, 'maxRounds')}
          />
          <section className="inspector-section">
            <div className="section-title">Start another round while</div>
            <Field label="Step">
              <select
                value={edgeConditionSource(node.continueWhen) ?? ''}
                onChange={(e) =>
                  set({
                    continueWhen: e.target.value
                      ? {
                          kind: 'verdict_is',
                          verdict: node.continueWhen.kind === 'verdict_is' ? node.continueWhen.verdict : 'NEEDS_FIX',
                          sourceNodeId: e.target.value,
                        }
                      : { kind: 'always' },
                  })
                }
              >
                <option value="">Always (run every round)</option>
                {inner.nodes
                  .filter((n) => (n.kind === 'agent' && n.producesAssessment) || n.kind === 'script')
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
              </select>
            </Field>
            {node.continueWhen.kind === 'verdict_is' && (
              <Field label="…returns the verdict">
                <select
                  value={node.continueWhen.verdict}
                  onChange={(e) =>
                    node.continueWhen.kind === 'verdict_is' &&
                    set({ continueWhen: { ...node.continueWhen, verdict: e.target.value as AssessmentVerdict } })
                  }
                >
                  {VERDICTS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </section>
          <Field label="After the last round">
            <select value={node.onExhausted} onChange={(e) => set({ onExhausted: e.target.value })}>
              {EXHAUSTED.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field label="List to go through" hint="one of the step's inputs">
            <select value={node.itemsPort} onChange={(e) => set({ itemsPort: e.target.value })}>
              {[...new Set([node.itemsPort, ...node.inputs.map((p) => p.name)])].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <TextField
            label="At most at the same time"
            value={String(node.maxConcurrency)}
            onChange={(v) => /^\d+$/.test(v) && Number(v) >= 1 && set({ maxConcurrency: Number(v) }, 'maxConcurrency')}
          />
          <Field label="When an item fails">
            <select value={node.failurePolicy} onChange={(e) => set({ failurePolicy: e.target.value })}>
              <option value="settle_all">Finish the other items, then report</option>
              <option value="fail_fast">Stop everything right away</option>
            </select>
          </Field>
        </>
      )}
      <WorkspaceField node={node} props={props} label="Workspace" hint="for inner steps without their own" />
      <WritePolicyFields node={node} props={props} container />
      <Field label="Default agent" hint="for inner agent steps without their own">
        <select value={node.defaultAgentRef?.split('@')[0] ?? ''} onChange={(e) => set({ defaultAgentRef: e.target.value || undefined })}>
          <option value="">None</option>
          {props.agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

const COMPARE_OPS = [
  { value: '>=', label: '≥' },
  { value: '>', label: '>' },
  { value: '<=', label: '≤' },
  { value: '<', label: '<' },
  { value: '==', label: '=' },
  { value: '!=', label: '≠' },
] as const;

/** A typed value from a text field: numbers, true/false and null as such, anything else as text. */
function conditionValue(text: string): string | number | boolean | null {
  const trimmed = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (trimmed === 'null') return null;
  return text;
}

/**
 * Fields for an edge condition. At the top an edge can also run always or otherwise, or combine
 * conditions with all/any; each combined condition reads the edge's step (deeper nesting, which
 * the contract allows, shows as text).
 */
function ConditionFields({
  when,
  onChange,
  ports,
  sourceName,
  loop,
  nested = false,
}: {
  when: EdgeCondition | undefined;
  onChange(next: EdgeCondition | undefined): void;
  ports: readonly string[];
  sourceName: string;
  loop: boolean;
  nested?: boolean;
}) {
  const kind = when?.kind ?? 'always';
  const port = ports[0] ?? 'decision';
  const leaf = (k: string): EdgeCondition | undefined => {
    if (k === 'verdict_is') return { kind: 'verdict_is', verdict: loop ? 'NEEDS_FIX' : 'PASS' };
    if (k === 'port_equals') return { kind: 'port_equals', port, value: '' };
    if (k === 'port_truthy') return { kind: 'port_truthy', port };
    if (k === 'port_compare') return { kind: 'port_compare', port, op: '>=', value: 0 };
    return undefined;
  };
  const choose = (k: string) => {
    if (k === 'always') onChange(undefined);
    else if (k === 'otherwise') onChange({ kind: 'otherwise' });
    else if (k === 'all' || k === 'any') {
      const first = when && when.kind !== 'always' && when.kind !== 'otherwise' && when.kind !== 'all' && when.kind !== 'any' ? when : leaf('verdict_is')!;
      onChange({ kind: k, conditions: when?.kind === 'all' || when?.kind === 'any' ? when.conditions : [first] });
    } else onChange(leaf(k));
  };
  const portSelect = (current: string, set: (p: string) => void) => (
    <Field label={`Output of “${sourceName}”`}>
      <select value={current} onChange={(e) => set(e.target.value)}>
        {[...new Set([current, ...ports])].map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <>
      <Field label={nested ? 'This condition' : 'Condition'}>
        <select value={kind} onChange={(e) => choose(e.target.value)}>
          {!loop && !nested && <option value="always">Always</option>}
          <option value="verdict_is">The verdict is…</option>
          <option value="port_equals">An output equals…</option>
          <option value="port_compare">An output compares to…</option>
          <option value="port_truthy">An output is set</option>
          {!nested && <option value="all">All of these hold…</option>}
          {!nested && <option value="any">Any of these holds…</option>}
          {!loop && !nested && <option value="otherwise">Otherwise (no other branch matches)</option>}
        </select>
      </Field>
      {when?.kind === 'verdict_is' && (
        <Field label="Verdict">
          <select value={when.verdict} onChange={(e) => onChange({ ...when, verdict: e.target.value as AssessmentVerdict })}>
            {VERDICTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      )}
      {(when?.kind === 'port_equals' || when?.kind === 'port_truthy' || when?.kind === 'port_compare') &&
        portSelect(when.port, (p) => onChange({ ...when, port: p }))}
      {when?.kind === 'port_equals' && (
        <TextField label="Value" value={String(when.value ?? '')} onChange={(v) => onChange({ ...when, value: v })} />
      )}
      {when?.kind === 'port_compare' && (
        <>
          <Field label="Compare">
            <select value={when.measure ?? 'value'} onChange={(e) => onChange({ ...when, measure: e.target.value as 'value' | 'length' })}>
              <option value="value">its value</option>
              <option value="length">how many items (or characters) it has</option>
            </select>
          </Field>
          <Field label="Is">
            <select value={when.op} onChange={(e) => onChange({ ...when, op: e.target.value as (typeof COMPARE_OPS)[number]['value'] })}>
              {COMPARE_OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <TextField label="Value" hint="numbers compare by size" value={String(when.value ?? '')} onChange={(v) => onChange({ ...when, value: conditionValue(v) })} />
        </>
      )}
      {(when?.kind === 'all' || when?.kind === 'any') && (
        <div className="condition-group">
          {when.conditions.map((sub, index) => {
            const replace = (next: EdgeCondition | undefined) =>
              next && onChange({ ...when, conditions: when.conditions.map((c, i) => (i === index ? next : c)) });
            const remove = () => onChange({ ...when, conditions: when.conditions.filter((_, i) => i !== index) });
            return (
              <div key={index} className="condition-item">
                <div className="condition-item-head">
                  <span>{index === 0 ? 'When' : when.kind === 'all' ? 'and' : 'or'}</span>
                  <button type="button" className="icon-btn" aria-label="Remove this condition" disabled={when.conditions.length === 1} onClick={remove}>
                    ×
                  </button>
                </div>
                {sub.kind === 'all' || sub.kind === 'any' || sub.kind === 'verdict_in' || sub.kind === 'otherwise' || sub.kind === 'always' ? (
                  <div className="popover-note">{conditionText(sub)}</div>
                ) : (
                  <ConditionFields when={sub} onChange={replace} ports={ports} sourceName={sourceName} loop={loop} nested />
                )}
              </div>
            );
          })}
          <button type="button" className="btn" onClick={() => onChange({ ...when, conditions: [...when.conditions, leaf('port_compare')!] })}>
            + Add condition
          </button>
        </div>
      )}
    </>
  );
}

function ConditionEditor({ props, edgeId }: { props: InspectorProps; edgeId: string }) {
  const control = findControlEdge(props.definition, edgeId, props.path);
  const graph = graphAt(props.definition, props.path);
  if (!control) {
    return <div className="popover-note">This connection only carries data; the order comes from another path.</div>;
  }
  const source = graph.nodes.find((n) => n.id === control.fromNodeId);
  const when = control.when;
  const sourcePorts = source?.outputs.map((p) => p.name) ?? [];
  const apply = (next: EdgeCondition | undefined) => props.onChange(setEdgeCondition(props.definition, control.id, next, props.path));
  const loop = control.loop;
  const targetName = graph.nodes.find((n) => n.id === control.toNodeId)?.name;

  return (
    <section className="inspector-section">
      <div className="section-title">{loop ? `Go back to “${targetName}” while` : `Run “${targetName}” only when`}</div>
      <ConditionFields
        when={when}
        onChange={apply}
        ports={sourcePorts}
        sourceName={source?.name ?? control.fromNodeId}
        loop={!!loop}
      />
      {loop && (
        <>
          <TextField
            label="Max rounds"
            hint="the first round included"
            value={String(loop.maxRounds)}
            onChange={(v) =>
              /^\d+$/.test(v) &&
              Number(v) >= 1 &&
              Number(v) <= 50 &&
              props.onChange(updateLoopBack(props.definition, control.id, { maxRounds: Number(v) }, props.path), `${control.id}:max`)
            }
          />
          <Field label="After the last round">
            <select
              value={loop.onExhausted}
              onChange={(e) =>
                props.onChange(
                  updateLoopBack(props.definition, control.id, { onExhausted: e.target.value as NonNullable<typeof loop>['onExhausted'] }, props.path)
                )
              }
            >
              {EXHAUSTED.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </section>
  );
}

function ParameterDependency({ props, edgeId }: { props: InspectorProps; edgeId: string }) {
  const graph = graphAt(props.definition, props.path);
  const edge = graph.dataEdges.find(edge => edge.id === edgeId);
  if (!edge) return null;
  const name = (id: string) => graph.nodes.find(node => node.id === id)?.name ?? id;
  const path = findExecutionPath(graph, edge.fromNodeId, edge.toNodeId);
  let explanation: string;
  if (edge.fromNodeId === INPUTS_NODE_ID) explanation = 'This value comes from the workflow or enclosing scope input. No step execution dependency is added.';
  else if (edge.toNodeId === OUTPUTS_NODE_ID) explanation = 'This publishes a workflow or scope output. There is no downstream step to schedule.';
  else if (!edge.required && findExecutionPath(graph, edge.toNodeId, edge.fromNodeId)) explanation = 'Previous-round value: absent in the first round. This parameter does not add a forward execution dependency.';
  else if (path?.length) explanation = 'The execution path below orders these steps. Its branch conditions still apply; connecting a parameter does not bypass them.';
  else explanation = edge.required
    ? `This required parameter waits for “${name(edge.fromNodeId)}” to succeed. There is no explicit execution path between these steps.`
    : 'This parameter is optional. There is no execution path between these steps.';
  return <section className="inspector-section connection-explanation">
    <div className="section-title">Execution dependency</div>
    <p>{explanation}</p>
    {!!path?.length && <ul>{path.map(edge => <li key={edge.id}>{name(edge.fromNodeId)} → {name(edge.toNodeId)} · {describeCondition(edge.when) ?? 'after success'}</li>)}</ul>}
    <p>Parameters pass values. Edit execution conditions by selecting an execution line.</p>
  </section>;
}

function NodeDependencies({ props, nodeId }: { props: InspectorProps; nodeId: string }) {
  const graph = graphAt(props.definition, props.path);
  const name = (id: string) => id === INPUTS_NODE_ID ? 'Workflow / scope input' : graph.nodes.find(node => node.id === id)?.name ?? id;
  const execution = graph.controlEdges.filter(edge => edge.toNodeId === nodeId && !edge.loop);
  const parameters = graph.dataEdges.filter(edge => edge.toNodeId === nodeId);
  return <section className="inspector-section connection-explanation">
    <div className="section-title">Execution prerequisites</div>
    <p>{execution.length ? 'Waits for these predecessors to settle. At least one execution branch must match.' : 'No incoming execution line. Required parameter sources still need to succeed.'}</p>
    {!!execution.length && <ul>{execution.map(edge => <li key={edge.id}>{name(edge.fromNodeId)} · {describeCondition(edge.when) ?? 'after success'}</li>)}</ul>}
    <div className="section-title">Parameter sources</div>
    {parameters.length ? <ul>{parameters.map(edge => <li key={edge.id}>{edge.toPort} ← {name(edge.fromNodeId)}.{edge.fromPort} · {edge.required ? 'required' : 'optional / previous round'}</li>)}</ul> : <p>No parameter connections.</p>}
  </section>;
}

/** Right-hand editor for the selected node, connection, or the workflow itself. */
export function Inspector(props: InspectorProps) {
  const { definition, target, path } = props;
  const graph = graphAt(definition, path);
  const container = containerAt(definition, path);
  let title = '';
  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (target.type === 'workflow') {
    title = 'Workflow settings';
    const chief = definition.chief;
    body = (
      <>
        <TextField label="Name" value={definition.name} onChange={(v) => props.onChange(updateWorkflowMeta(definition, { name: v }), 'wf:name')} />
        <TextField
          label="Description"
          multiline
          value={definition.description ?? ''}
          onChange={(v) => props.onChange(updateWorkflowMeta(definition, { description: v }), 'wf:description')}
        />
        <section className="inspector-section">
          <div className="section-title">Chief agent</div>
          <Toggle
            label="Supervise runs"
            desc="Steps in when a step fails, loops stall or an agent asks a question; never changes what counts as done"
            checked={!!chief}
            onChange={(on) => props.onChange(updateWorkflowMeta(definition, { chief: on ? ChiefPolicySchema.parse({}) : null }))}
          />
          {chief && (
            <>
              <Field label="Chief">
                <select
                  value={chief.agentRef ?? ''}
                  onChange={(e) =>
                    props.onChange(
                      updateWorkflowMeta(definition, {
                        chief: e.target.value ? { ...chief, agentRef: e.target.value } : (({ agentRef: _a, ...rest }) => rest)(chief),
                      })
                    )
                  }
                >
                  <option value="">Default chief (on the engine this flow's agents use)</option>
                  {props.agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Allowed to">
                <select
                  value={chief.maxLevel}
                  onChange={(e) => props.onChange(updateWorkflowMeta(definition, { chief: { ...chief, maxLevel: e.target.value as ChiefLevel } }))}
                >
                  {CHIEF_LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </section>
        <WorkspaceSlotsEditor props={props} />
      </>
    );
  } else if (target.type === 'edge') {
    const data = graph.dataEdges.find((e) => e.id === target.edgeId);
    const control = graph.controlEdges.find((e) => e.id === target.edgeId);
    const name = (id: string) =>
      id === INPUTS_NODE_ID ? 'Inputs' : id === OUTPUTS_NODE_ID ? 'Outputs' : (graph.nodes.find((n) => n.id === id)?.name ?? id);
    title = control?.loop ? 'Execution loop-back' : data ? 'Parameter connection' : 'Execution connection';
    body = (
      <>
        <div className="inspector-summary">
          {data
            ? `${name(data.fromNodeId)} · ${data.fromPort}  →  ${name(data.toNodeId)} · ${data.toPort}`
            : control
              ? `${name(control.fromNodeId)}  →  ${name(control.toNodeId)}`
              : 'This connection no longer exists.'}
        </div>
        {data && <ParameterDependency props={props} edgeId={target.edgeId} />}
        {control && <>
          <div className="connection-explanation"><p>This line controls when the next step can run. Parameter bindings are shown separately.</p>
            {graph.dataEdges.some(edge => edge.fromNodeId === control.fromNodeId && edge.toNodeId === control.toNodeId) && <p>These steps also have parameter bindings. Their execution dependency is shown here, including dependencies added when parameters were connected.</p>}
          </div>
          <ConditionEditor props={props} edgeId={target.edgeId} />
        </>}
      </>
    );
    footer = (data || control) && (
      <>
      <div className="connection-explanation"><p>{data ? 'Deleting this parameter connection keeps the execution lines.' : 'Deleting this execution line keeps the parameter bindings and any required-input dependencies.'}</p></div>
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          props.onChange(removeEdge(definition, target.edgeId, path));
          props.onClose();
        }}
      >
        Delete {data ? 'parameter' : 'execution'} connection <span className="kbd">⌫</span>
      </button>
      </>
    );
  } else if (target.nodeId === INPUTS_NODE_ID || target.nodeId === OUTPUTS_NODE_ID) {
    const isInputs = target.nodeId === INPUTS_NODE_ID;
    const owner = container ? `“${container.name}”` : 'Workflow';
    title = `${owner} ${isInputs ? 'inputs' : 'outputs'}`;
    body = (
      <PortsEditor
        title={
          container
            ? isInputs
              ? `Fields every ${container.kind === 'loop' ? 'round' : 'item'} receives (same as the step's inputs outside)`
              : `Fields the ${container.kind === 'loop' ? 'loop' : 'parallel step'} hands back`
            : isInputs
              ? 'Fields you fill in when starting a run'
              : 'Fields the run delivers'
        }
        definition={definition}
        path={path}
        nodeId={target.nodeId}
        side={isInputs ? 'out' : 'in'}
        onChange={props.onChange}
        onError={props.onError}
      />
    );
  } else {
    const node = graph.nodes.find((n) => n.id === target.nodeId);
    if (!node) {
      title = 'Step removed';
    } else {
      title = { agent: 'Agent task', script: 'Script', gate: 'Human decision', subflow: 'Sub-flow', loop: 'Loop', parallel: 'Parallel' }[node.kind];
      const nodeIssues = props.issues.filter((i) => i.nodeId === node.id && i.scopePath === compilerScopePath(path));
      body = (
        <>
          <div className="inspector-summary">id: {node.id}</div>
          {nodeIssues.length > 0 && (
            <div className="inspector-issues">
              {nodeIssues.map((i) => (
                <div key={`${i.code}-${i.message}`}>{i.message}</div>
              ))}
            </div>
          )}
          {node.kind === 'loop' || node.kind === 'parallel' ? (
            <ContainerFields node={node} props={props} />
          ) : (
            <NodeFields node={node} props={props} />
          )}
          <NodeDependencies props={props} nodeId={node.id} />
          {/* A sub-flow step's fields are its workflow's. */}
          {node.kind !== 'subflow' && (
            <>
              <PortsEditor title="Inputs" definition={definition} path={path} nodeId={node.id} side="in" onChange={props.onChange} onError={props.onError} />
              <PortsEditor title="Outputs" definition={definition} path={path} nodeId={node.id} side="out" onChange={props.onChange} onError={props.onError} />
            </>
          )}
        </>
      );
      footer = (
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            props.onChange(removeNode(definition, node.id, path));
            props.onClose();
          }}
        >
          Delete step
        </button>
      );
    }
  }

  return (
    <aside className="sheet inspector nowheel" aria-label={title}>
      <div className="sheet-head">
        <span>{title}</span>
        <button type="button" className="btn" onClick={props.onClose}>
          Done
        </button>
      </div>
      <div className="inspector-body">{body}</div>
      {footer && <div className="inspector-footer">{footer}</div>}
    </aside>
  );
}
