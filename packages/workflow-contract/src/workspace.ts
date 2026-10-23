/** How a run uses a registered workspace directory. */
export type WorkspaceIsolation = 'in-place' | 'git-worktree';

/**
 * The directory a run bound to one workspace slot, fixed when the run starts so retries,
 * reruns and later follow-ups always work in the same place.
 */
export interface RunWorkspaceBinding {
  readonly slot: string;
  /** Directory nodes in this slot work in (a worktree path under `git-worktree`). */
  readonly path: string;
  /** Registered workspace the slot was bound to; absent for ad-hoc paths. */
  readonly workspaceId?: string;
  readonly name?: string;
  readonly isolation?: WorkspaceIsolation;
  /** `git-worktree`: the repository the worktree was created from, and its branch. */
  readonly sourcePath?: string;
  readonly branch?: string;
}

/** What an attempt was told about where it works; recorded in its ContextManifest. */
export interface ManifestWorkspace {
  readonly slot: string;
  readonly path: string;
  readonly writeScopes: readonly string[];
  readonly readOnly: readonly { readonly slot: string; readonly path: string }[];
}
