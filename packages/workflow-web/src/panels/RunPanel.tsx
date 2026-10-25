import type { WorkflowDefinition } from '@universal-agent/workflow-contract';
import { listWorkspaceSlots, type WorkspaceRecord } from '@universal-agent/workflow-ui';
import { useState } from 'react';

function extractExampleValue(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = description.match(/e\.g\.\s*(\[[\s\S]*\]|\{[\s\S]*\})/i);
  return match?.[1]?.trim();
}

/** Start a run: the workflow's inputs plus a workspace for each slot. */
export function RunPanel(props: {
  definition: WorkflowDefinition;
  workspaces: readonly WorkspaceRecord[];
  /** The workflow's remembered choice per slot. */
  bindings: Record<string, string>;
  defaultWorkspaceId: string | null;
  onManageWorkspaces(): void;
  onStart(inputs: Record<string, unknown>, workspaces: Record<string, string>): void;
}) {
  const { definition } = props;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const port of definition.inputs) {
      const example = extractExampleValue(port.description);
      if (example) initial[port.name] = example;
    }
    return initial;
  });
  const slots = listWorkspaceSlots(definition);
  const implicit = definition.workspaces.length === 0;
  const [chosen, setChosen] = useState<Record<string, string>>(() => {
    const known = new Set(props.workspaces.map((w) => w.id));
    const initial: Record<string, string> = {};
    for (const slot of slots) {
      const remembered = props.bindings[slot.name];
      const pick = remembered && known.has(remembered) ? remembered : implicit ? props.defaultWorkspaceId : null;
      if (pick) initial[slot.name] = pick;
    }
    return initial;
  });
  const missing = [
    ...definition.inputs.filter((p) => p.required && !values[p.name]?.trim()),
    ...slots.filter((s) => s.required && !chosen[s.name]),
  ];
  const start = () => {
    const inputs: Record<string, unknown> = {};
    for (const port of definition.inputs) {
      const raw = values[port.name];
      if (raw === undefined || raw === '') continue;
      if (port.type === 'string' || port.type === 'artifact') inputs[port.name] = raw;
      else {
        try {
          inputs[port.name] = JSON.parse(raw);
        } catch {
          if (port.type === 'json') {
            const parts = raw
              .split(/[\r\n,，;；]+/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            inputs[port.name] = parts.length > 1 ? parts : raw;
          } else {
            inputs[port.name] = raw;
          }
        }
      }
    }
    props.onStart(inputs, chosen);
  };
  return (
    <>
      <div className="menu-label">Start a run</div>
      {slots.map((slot) => (
        <label key={slot.name} className="field">
          <span>
            {implicit ? 'Workspace' : `Workspace · ${slot.name}`}
            {slot.description ? ` — ${slot.description}` : ''}
            {slot.required ? '' : ' (optional)'}
          </span>
          <select
            aria-label={implicit ? 'Workspace' : `Workspace ${slot.name}`}
            value={chosen[slot.name] ?? ''}
            onChange={(e) => {
              if (e.target.value === '__manage') return props.onManageWorkspaces();
              setChosen((c) => {
                const next = { ...c };
                if (e.target.value) next[slot.name] = e.target.value;
                else delete next[slot.name];
                return next;
              });
            }}
          >
            <option value="">{slot.required ? 'Choose a workspace…' : 'None'}</option>
            {props.workspaces.map((ws) => (
              <option key={ws.id} value={ws.id} disabled={!ws.exists}>
                {ws.name} · {ws.path}
                {ws.isolation === 'git-worktree' ? ' · worktree' : ''}
              </option>
            ))}
            <option value="__manage">Add or manage workspaces…</option>
          </select>
        </label>
      ))}
      {definition.inputs.map((port) => (
        <label key={port.name} className="field">
          <span>
            {port.name}
            {port.required ? '' : ' (optional)'} · {port.type}
            {port.description ? ` — ${port.description}` : ''}
          </span>
          <textarea
            rows={port.type === 'string' || port.type === 'artifact' ? 3 : 2}
            placeholder={port.description}
            value={values[port.name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [port.name]: e.target.value }))}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && missing.length === 0) start();
            }}
          />
        </label>
      ))}
      <div className="popover-footer">
        <button type="button" className="btn btn-primary" disabled={missing.length > 0} onClick={start}>
          Run <span className="kbd">⌘↵</span>
        </button>
      </div>
    </>
  );
}
