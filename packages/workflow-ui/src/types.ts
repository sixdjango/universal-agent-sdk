import type { AgentProfile, WorkspaceIsolation } from '@universal-agent/workflow-contract';

/** Canvas positions keyed by node path. */
export type CanvasLayout = Record<string, { x: number; y: number }>;

/** An agent the user can assign to a step. */
export interface AgentListing {
  agentId: string;
  name: string;
  latestVersion: string;
  profile: AgentProfile | null;
}

/** One agent client (engine) and what a step can pick on it. */
export interface AgentRuntimeInfo {
  agentType: string;
  installed: boolean;
  models: { id: string; name?: string; description?: string }[];
  efforts: string[];
  effortsByModel?: Record<string, string[]>;
  source: 'static' | 'probed' | 'none';
}

export type { WorkspaceIsolation };

/** A directory runs can bind workspace slots to. */
export interface WorkspaceRecord {
  id: string;
  name: string;
  path: string;
  isolation: WorkspaceIsolation;
  git: boolean;
  exists: boolean;
}
