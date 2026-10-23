import type { WaitRequest } from '@universal-agent/workflow-contract';
import { createContext, useContext } from 'react';
import type { AgentListing, AgentRuntimeInfo } from '../types';
import type { RuntimeChoice } from '../model/runtime';
import type { PortSide } from '../model/editing';

/** Callbacks cards use to talk to the app, without threading props through React Flow. */
export interface CanvasActions {
  readonly agents: readonly AgentListing[];
  /** Agent clients with their models and effort levels. */
  readonly runtimes: readonly AgentRuntimeInfo[];
  /** Design view: the graph is a draft the user can change. */
  readonly editable: boolean;
  readonly openPopover: string | null;
  setOpenPopover(id: string | null): void;
  /** Sets the step's agent and its client / model / effort overrides (unset = agent's). */
  assignAgent(nodeId: string, agentRef: string, runtime: RuntimeChoice): Promise<void>;
  refreshRuntime(agentType: string): Promise<void>;
  answer(wait: WaitRequest, answer: string): Promise<void>;
  rerun(nodeId: string): Promise<void>;
  openArtifact(artifactId: string, title: string): void;
  inspectNode(nodeId: string): void;
  /** Shows a loop body / parallel item graph in place of the current one. */
  openScope(nodeId: string): void;
  addPort(nodeId: string, side: PortSide): void;
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null);

export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext);
  if (!actions) throw new Error('CanvasActionsContext is missing');
  return actions;
}
