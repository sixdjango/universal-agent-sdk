import { useState } from 'react';
import type { WorkspaceIsolation, WorkspaceRecord } from '../types';

const ISOLATION_LABEL: Record<WorkspaceIsolation, string> = {
  'in-place': 'In place',
  'git-worktree': 'Git worktree per run',
};

export interface WorkspaceInput {
  readonly path: string;
  readonly name?: string;
  readonly isolation?: WorkspaceIsolation;
}

/** Registered workspaces: add a directory, switch its isolation, or remove it. */
export function WorkspacesPanel(props: {
  workspaces: readonly WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  onCreate(input: WorkspaceInput): Promise<unknown>;
  onUpdate(id: string, patch: Partial<WorkspaceInput>): Promise<unknown>;
  onDelete(id: string): Promise<unknown>;
  /** Called after every successful change, e.g. to reload the list. */
  onChanged(): Promise<void>;
  onError(message: string): void;
}) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [isolation, setIsolation] = useState<WorkspaceIsolation>('in-place');
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await props.onChanged();
      return true;
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const ok = await run(() => props.onCreate({ path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}), isolation }));
    if (ok) {
      setPath('');
      setName('');
      setIsolation('in-place');
    }
  };

  return (
    <>
      <div className="menu-label">Workspaces</div>
      {props.workspaces.map((ws) => (
        <div key={ws.id} className="workspace-item">
          <div className="workspace-main">
            <div className="option-title">
              {ws.name}
              {ws.id === props.defaultWorkspaceId && <span className="field-hint"> · server directory</span>}
            </div>
            <div className="option-desc mono path-tail" data-tone={ws.exists ? undefined : 'danger'} title={ws.path}>
              <span>{ws.exists ? ws.path : `${ws.path} (missing)`}</span>
            </div>
          </div>
          <select
            aria-label={`${ws.name} isolation`}
            value={ws.isolation}
            disabled={busy}
            onChange={(e) => void run(() => props.onUpdate(ws.id, { isolation: e.target.value as WorkspaceIsolation }))}
          >
            <option value="in-place">{ISOLATION_LABEL['in-place']}</option>
            <option value="git-worktree" disabled={!ws.git}>
              {ISOLATION_LABEL['git-worktree']}
              {ws.git ? '' : ' (not a git repo)'}
            </option>
          </select>
          {ws.id === props.defaultWorkspaceId ? (
            <span />
          ) : (
            <button
              type="button"
              className="icon-btn visible"
              aria-label={`Remove ${ws.name}`}
              disabled={busy}
              onClick={() => void run(() => props.onDelete(ws.id))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <div className="menu-label">Add a directory</div>
      <label className="field">
        <span>Absolute path</span>
        <input
          type="text"
          placeholder="/Users/me/projects/web"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && path.trim() && void add()}
        />
      </label>
      <label className="field">
        <span>Name (optional)</span>
        <input type="text" placeholder="Folder name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Runs</span>
        <select value={isolation} onChange={(e) => setIsolation(e.target.value as WorkspaceIsolation)}>
          <option value="in-place">{ISOLATION_LABEL['in-place']}</option>
          <option value="git-worktree">{ISOLATION_LABEL['git-worktree']}</option>
        </select>
      </label>
      <div className="popover-footer">
        <button type="button" className="btn btn-primary" disabled={busy || !path.trim()} onClick={() => void add()}>
          Add workspace
        </button>
      </div>
    </>
  );
}
