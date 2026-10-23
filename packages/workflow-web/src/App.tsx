import {
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowValidationIssue,
  validateWorkflowDefinition,
} from '@universal-agent/workflow-contract';
import { computeScopeReadyNodeIds } from '@universal-agent/workflow-runtime';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addNode,
  addPort,
  buildCanvasModel,
  type CanvasActions,
  CanvasActionsContext,
  CheckIcon,
  ChiefDock,
  compilePlan,
  connect,
  containerAt,
  containerInstanceKeys,
  createBlankWorkflow,
  describeLoop,
  describeRun,
  graphAt,
  INPUTS_NODE_ID,
  type InspectTarget,
  Inspector,
  layoutKey,
  Menu,
  type NewNodeKind,
  OUTPUTS_NODE_ID,
  removeEdge,
  TraceView,
  updateNode,
  updateWorkflowMeta,
  useRunStream,
  WorkflowCanvas,
  WorkspacesPanel,
} from '@universal-agent/workflow-ui';
import {
  type AgentListing,
  type AgentRuntimeInfo,
  api,
  type CanvasLayout,
  type RunSummary,
  type WorkflowRecord,
  type WorkflowSummary,
  type WorkspaceRecord,
} from './api';
import { describeError, timeAgo } from './format';
import { EscalationPanel } from './panels/EscalationPanel';
import { ImportPanel } from './panels/ImportPanel';
import { RunPanel } from './panels/RunPanel';
import { readRoute, type Route, writeRoute } from './routing';

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [record, setRecord] = useState<WorkflowRecord | null>(null);
  const [agents, setAgents] = useState<AgentListing[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [menu, setMenu] = useState<'workflows' | 'import' | 'workspaces' | 'runs' | 'start' | 'chief' | 'issues' | null>(null);
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<{ title: string; content: string } | null>(null);
  const [runView, setRunView] = useState<'trace' | 'canvas'>('trace');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>(0);

  // Editing: a new unsaved workflow, or a draft on top of the saved one, plus undo history.
  const [newWorkflow, setNewWorkflow] = useState<WorkflowDefinition | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [history, setHistory] = useState<WorkflowDefinition[]>([]);
  const [draftLayout, setDraftLayout] = useState<CanvasLayout | null>(null);
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  // Nested graph on screen (container ids from the root) and the run instance chosen per level.
  const [scopePath, setScopePath] = useState<string[]>([]);
  const [instanceChoice, setInstanceChoice] = useState<Record<string, number>>({});
  const lastEdit = useRef<{ key?: string; at: number }>({ at: 0 });

  const fail = useCallback((err: unknown) => {
    setToast(typeof err === 'string' ? err : describeError(err));
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const listed = await api.listWorkspaces();
      setWorkspaces(listed.workspaces);
      setDefaultWorkspaceId(listed.defaultWorkspaceId);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  const base = newWorkflow ?? record?.definition ?? null;
  const definition = draft ?? base;
  const dirty = !!draft || !!newWorkflow;
  const editable = !route.runId && !!definition;

  const resetEditing = useCallback(() => {
    setDraft(null);
    setHistory([]);
    setDraftLayout(null);
    setInspect(null);
    lastEdit.current = { at: 0 };
  }, []);

  const navigate = useCallback(
    (next: Route, options: { force?: boolean } = {}) => {
      if (dirty && !options.force && !window.confirm('Discard your unsaved changes?')) return;
      if (dirty) {
        resetEditing();
        setNewWorkflow(null);
      }
      writeRoute(next);
      setRoute(next);
      setMenu(null);
      setOpenPopover(null);
      setInspect(null);
      setScopePath([]);
      setInstanceChoice({});
    },
    [dirty, resetEditing]
  );

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const refreshWorkflows = useCallback(async () => {
    const list = await api.listWorkflows();
    setWorkflows(list);
    return list;
  }, []);

  useEffect(() => {
    refreshWorkflows()
      .then((list) => {
        if (!readRoute().workflowId && list[0]) {
          const next = { workflowId: list[0].id, runId: null };
          writeRoute(next);
          setRoute(next);
        }
      })
      .catch(fail);
    api.listAgents().then(setAgents).catch(fail);
    api.listRuntimes().then(setRuntimes).catch(fail);
    void loadWorkspaces();
  }, [refreshWorkflows, fail, loadWorkspaces]);

  /** Starts a client once to read its live models / efforts, then updates the pickers. */
  const refreshRuntime = useCallback(
    async (agentType: string) => {
      try {
        const fresh = await api.refreshRuntime(agentType);
        setRuntimes((list) => list.map((r) => (r.agentType === agentType ? fresh : r)));
      } catch (err) {
        fail(err);
      }
    },
    [fail]
  );

  useEffect(() => {
    setRecord(null);
    if (!route.workflowId) return;
    api.getWorkflow(route.workflowId).then(setRecord).catch(fail);
    api.listRuns(route.workflowId).then(setRuns).catch(fail);
  }, [route.workflowId, fail]);

  const stream = useRunStream(route.runId);
  const run = stream.run;

  // Keep the run list's status fresh while watching a run.
  useEffect(() => {
    if (!route.workflowId || !run) return;
    setRuns((list) => list.map((r) => (r.runId === run.runId ? { ...r, status: run.status } : r)));
  }, [route.workflowId, run?.status, run?.runId]);

  const issues: readonly WorkflowValidationIssue[] = useMemo(() => {
    if (!editable || !definition) return [];
    const result = validateWorkflowDefinition(definition);
    return result.ok ? [] : result.issues;
  }, [editable, definition]);

  // Leave a nested graph that no longer exists (e.g. its container was removed or undone).
  const shownDefinition = run?.definition ?? definition;
  /** A step's name wherever it sits in the graph (the chief refers to nested steps by id). */
  const nodeNameAnywhere = useCallback(
    (nodeId: string) => {
      const find = (nodes: readonly WorkflowNode[]): string | undefined => {
        for (const n of nodes) {
          if (n.id === nodeId) return n.name;
          const inner = n.kind === 'loop' ? n.bodyGraph.nodes : n.kind === 'parallel' ? n.itemGraph.nodes : [];
          const hit = find(inner);
          if (hit) return hit;
        }
        return undefined;
      };
      return (shownDefinition && find(shownDefinition.graph.nodes)) ?? nodeId;
    },
    [shownDefinition]
  );
  useEffect(() => {
    if (!shownDefinition || scopePath.length === 0) return;
    try {
      containerAt(shownDefinition, scopePath);
    } catch {
      setScopePath([]);
    }
  }, [shownDefinition, scopePath]);

  /** Run scope instance for the nested graph: the latest loop round / chosen item per level. */
  const scopeKey = useMemo(() => {
    if (!run) return '$root';
    let key = '$root';
    try {
      scopePath.forEach((id, depth) => {
        const node = containerAt(run.definition, scopePath.slice(0, depth + 1))!;
        const instances = containerInstanceKeys(run, `${key}/${id}`);
        const chosen = instanceChoice[scopePath.slice(0, depth + 1).join('/')];
        const index = chosen ?? (node.kind === 'loop' ? Math.max(0, instances.length - 1) : 0);
        key = node.kind === 'loop' ? `${key}/${id}:round_${index}` : `${key}/${id}[${index}]`;
      });
    } catch {
      return '$root';
    }
    return key;
  }, [run, scopePath, instanceChoice]);

  /** Records an edit; consecutive edits of one field within 1.5 s share an undo step. */
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const applyEdit = useCallback(
    (next: WorkflowDefinition, coalesceKey?: string) => {
      const current = definitionRef.current;
      if (!current) return;
      const now = Date.now();
      const coalesce = !!coalesceKey && lastEdit.current.key === coalesceKey && now - lastEdit.current.at < 1500;
      if (!coalesce) setHistory((h) => [...h.slice(-99), current]);
      lastEdit.current = { ...(coalesceKey ? { key: coalesceKey } : {}), at: now };
      setDraft(next);
    },
    []
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const previous = h[h.length - 1]!;
      setDraft(previous === base && !newWorkflow ? null : previous);
      lastEdit.current = { at: 0 };
      return h.slice(0, -1);
    });
  }, [base, newWorkflow]);

  const save = useCallback(async () => {
    if (!definition || !dirty) return;
    if (issues.length > 0) {
      fail(`Fix ${issues.length} issue${issues.length === 1 ? '' : 's'} before saving`);
      setMenu('issues');
      return;
    }
    const layout = { ...(record?.layout ?? {}), ...(draftLayout ?? {}) };
    try {
      const saved = newWorkflow ? await api.createWorkflow(definition, layout) : await api.updateWorkflow(definition, layout);
      resetEditing();
      setNewWorkflow(null);
      setRecord(saved);
      await refreshWorkflows();
      if (saved.id !== route.workflowId) {
        const next = { workflowId: saved.id, runId: null };
        writeRoute(next);
        setRoute(next);
      }
    } catch (err) {
      fail(err);
    }
  }, [definition, dirty, issues, record, draftLayout, newWorkflow, resetEditing, refreshWorkflows, route.workflowId, fail]);

  const discard = useCallback(() => {
    const wasNew = !!newWorkflow;
    resetEditing();
    setNewWorkflow(null);
    if (wasNew && workflows?.[0]) {
      const next = { workflowId: workflows[0].id, runId: null };
      writeRoute(next);
      setRoute(next);
    }
  }, [newWorkflow, resetEditing, workflows]);

  const startNewWorkflow = () => {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    let blank = createBlankWorkflow('Untitled workflow', (workflows ?? []).map((w) => w.id));
    const first = addNode(blank, 'agent');
    if (first.ok) {
      blank = first.definition;
      const wired = connect(blank, { source: INPUTS_NODE_ID, sourceHandle: 'out:request', target: first.nodeId, targetHandle: 'in:+' });
      if (wired.ok) blank = wired.definition;
    }
    resetEditing();
    setScopePath([]);
    setNewWorkflow(blank);
    writeRoute({ workflowId: null, runId: null });
    setRoute({ workflowId: null, runId: null });
    setMenu(null);
    setInspect({ type: 'workflow' });
  };

  // Keyboard: ⌘S save, ⌘Z undo, ⌫ delete the selected connection, Esc close the inspector.
  useEffect(() => {
    if (!editable) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      } else if (mod && event.key.toLowerCase() === 'z' && !event.shiftKey && !typing) {
        event.preventDefault();
        undo();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && inspect?.type === 'edge' && definition) {
        event.preventDefault();
        applyEdit(removeEdge(definition, inspect.edgeId, scopePath));
        setInspect(null);
      } else if (event.key === 'Escape' && !typing && inspect) {
        setInspect(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, save, undo, inspect, definition, applyEdit, scopePath]);

  // Esc with nothing open climbs out of a nested graph (design and run views).
  useEffect(() => {
    if (scopePath.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== 'Escape' || inspect || openPopover || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      setScopePath((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scopePath, inspect, openPopover]);

  const layout = useMemo(() => ({ ...(record?.layout ?? {}), ...(draftLayout ?? {}) }), [record, draftLayout]);
  const agentNames = useMemo(() => Object.fromEntries(agents.map((a) => [a.agentId, a.name])), [agents]);
  const agentRuntimes = useMemo(
    () => Object.fromEntries(agents.flatMap((a) => (a.profile ? [[a.agentId, a.profile.runtime] as const] : []))),
    [agents]
  );
  const model = useMemo(() => {
    if (!definition) return null;
    try {
      return buildCanvasModel({
        definition,
        run,
        runActive: stream.active,
        layout,
        agentNames,
        agentRuntimes,
        editable,
        issues,
        selectedEdgeId: inspect?.type === 'edge' ? inspect.edgeId : null,
        path: scopePath,
        scopeKey,
      });
    } catch {
      // The nested graph vanished mid-edit; the effect above climbs back out.
      return null;
    }
  }, [definition, run, stream.active, layout, agentNames, agentRuntimes, editable, issues, inspect, scopePath, scopeKey]);

  const runningCount = useMemo(() => {
    if (!run || run.status !== 'RUNNING' || !run.scopes.$root) return 0;
    return computeScopeReadyNodeIds(compilePlan(run.definition).rootScope, run.scopes.$root).length;
  }, [run]);
  const pill = describeRun(run, runningCount);
  const escalation = run?.chief.pendingEscalationId ? run.waitRequests[run.chief.pendingEscalationId] : undefined;

  const startRun = useCallback(
    async (inputs: Record<string, unknown>, chosen: Record<string, string>) => {
      if (!record) return;
      try {
        setMenu(null);
        const { runId } = await api.startRun(record.id, inputs, chosen);
        // The server remembers the choice; keep the local record in step for the next run.
        setRecord((r) => (r && r.id === record.id ? { ...r, workspaceBindings: { ...r.workspaceBindings, ...chosen } } : r));
        navigate({ workflowId: record.id, runId });
        setRuns(await api.listRuns(record.id));
      } catch (err) {
        fail(err);
      }
    },
    [record, navigate, fail]
  );

  const layoutTimer = useRef<number>(0);
  /** Canvas positions are per graph (bare node ids); the saved layout keys them by path. */
  const scopedLayout = useCallback(
    (positions: CanvasLayout): CanvasLayout =>
      Object.fromEntries(Object.entries(positions).map(([id, pos]) => [layoutKey(scopePath, id), pos])),
    [scopePath]
  );
  const onLayoutChange = useCallback(
    (positions: CanvasLayout) => {
      const next = { ...layout, ...scopedLayout(positions) };
      // Positions of a draft are saved together with it.
      if (dirty || !record) {
        setDraftLayout(next);
        return;
      }
      setRecord((r) => (r ? { ...r, layout: next } : r));
      window.clearTimeout(layoutTimer.current);
      layoutTimer.current = window.setTimeout(() => {
        api.saveLayout(record.id, next).catch(fail);
      }, 400);
    },
    [dirty, record, layout, scopedLayout, fail]
  );

  const actions: CanvasActions = useMemo(
    () => ({
      agents,
      runtimes,
      refreshRuntime,
      editable,
      openPopover,
      setOpenPopover,
      async assignAgent(nodeId, agentRef, runtime) {
        if (!definition) return;
        applyEdit(
          updateNode(
            definition,
            nodeId,
            { agentRef, agentType: runtime.agentType, modelId: runtime.modelId, effort: runtime.effort },
            scopePath
          )
        );
      },
      async answer(wait, answer) {
        try {
          await api.respond(wait.runId, wait.requestId, answer);
        } catch (err) {
          fail(err);
          throw err;
        }
      },
      async rerun(nodeId) {
        if (!run) return;
        try {
          await api.rerun(run.runId, nodeId);
        } catch (err) {
          fail(err);
        }
      },
      openArtifact(artifactId, title) {
        api
          .readArtifact(artifactId)
          .then(({ slice }) => setArtifact({ title, content: slice.content + (slice.hasMore ? '\n…' : '') }))
          .catch(fail);
      },
      inspectNode(nodeId) {
        setOpenPopover(null);
        setInspect({ type: 'node', nodeId });
      },
      addPort(nodeId, side) {
        if (!definition) return;
        const result = addPort(
          definition,
          nodeId,
          side,
          { name: nodeId === INPUTS_NODE_ID || nodeId === OUTPUTS_NODE_ID ? 'field' : side === 'in' ? 'input' : 'output' },
          scopePath
        );
        if (!result.ok) return fail(result.error);
        applyEdit(result.definition);
        setInspect({ type: 'node', nodeId });
      },
      openScope(nodeId) {
        setOpenPopover(null);
        setInspect(null);
        setScopePath((p) => [...p, nodeId]);
      },
    }),
    [agents, runtimes, refreshRuntime, editable, openPopover, definition, run, applyEdit, fail, scopePath]
  );

  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const onAddNode = useCallback(
    (kind: NewNodeKind, position: { x: number; y: number }, currentLayout: CanvasLayout) => {
      if (!definition) return;
      const result = addNode(definition, kind, {}, scopePath);
      if (!result.ok) return fail(result.error);
      applyEdit(result.definition);
      setDraftLayout({ ...layout, ...scopedLayout(currentLayout), [layoutKey(scopePath, result.nodeId)]: position });
      setInspect({ type: 'node', nodeId: result.nodeId });
      setFocusNodeId(result.nodeId);
    },
    [definition, applyEdit, fail, scopePath, layout, scopedLayout]
  );

  const loadSample = async () => {
    try {
      const sample = await api.loadSample();
      setAgents(await api.listAgents());
      await refreshWorkflows();
      navigate({ workflowId: sample.id, runId: null });
    } catch (err) {
      fail(err);
    }
  };

  const imported = async (created: WorkflowRecord) => {
    await refreshWorkflows();
    navigate({ workflowId: created.id, runId: null }, { force: true });
  };

  const nodeName = (nodeId: string | undefined, scope: string) => {
    if (!nodeId || !definition) return 'Workflow';
    try {
      return graphAt(definition, scope.split('/').slice(1)).nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
    } catch {
      return nodeId;
    }
  };

  const subtitle = run
    ? `Run ${run.runId.slice(-8)} · started ${timeAgo(run.createdAtMs)} · ${Object.keys(run.attempts).length} attempt${Object.keys(run.attempts).length === 1 ? '' : 's'}${
        Object.keys(run.workspaces).length > 0
          ? ` · in ${Object.values(run.workspaces)
              .map((w) => (Object.keys(run.workspaces).length > 1 ? `${w.slot}: ` : '') + (w.name ?? w.path) + (w.branch ? ` (${w.branch})` : ''))
              .join(', ')}`
          : ''
      }`
    : newWorkflow
      ? `New workflow · not saved yet · ${definition?.graph.nodes.length ?? 0} steps`
      : definition
        ? `${definition.description ?? 'Workflow'} · ${definition.graph.nodes.length} steps · ${dirty ? 'unsaved changes' : 'design view'}`
        : '';

  return (
    <div className="app">
      <header className="topbar">
        <div style={{ position: 'relative' }}>
          <button type="button" className="title-button" onClick={() => setMenu(menu === 'workflows' ? null : 'workflows')}>
            {definition?.name ?? (workflows?.length === 0 ? 'Agent workflows' : 'Loading…')}
            <span className="chev">⌄</span>
          </button>
          <div className="subtitle">{subtitle}</div>
          {scopePath.length > 0 && shownDefinition && (
            <nav className="crumbs" aria-label="Nested steps">
              <button type="button" onClick={() => setScopePath([])}>
                {shownDefinition.name}
              </button>
              {scopePath.map((id, i) => {
                let name = id;
                try {
                  name = containerAt(shownDefinition, scopePath.slice(0, i + 1))?.name ?? id;
                } catch {
                  // the path is being reset
                }
                const last = i === scopePath.length - 1;
                return (
                  <span key={id} style={{ display: 'contents' }}>
                    <span className="sep">›</span>
                    <button type="button" aria-current={last} onClick={() => !last && setScopePath(scopePath.slice(0, i + 1))}>
                      {name}
                    </button>
                  </span>
                );
              })}
            </nav>
          )}
          {run && scopePath.length > 0 && (() => {
            const parentKey = scopeKey.slice(0, scopeKey.lastIndexOf('/'));
            const id = scopePath[scopePath.length - 1]!;
            const instances = containerInstanceKeys(run, `${parentKey}/${id}`);
            if (instances.length <= 1) return null;
            const isLoop = instances[0]!.includes(':round_');
            // Each round's verdict from the step that decides the loop.
            let roundVerdicts: (string | undefined)[] = [];
            try {
              const container = containerAt(run.definition, scopePath);
              if (container?.kind === 'loop') {
                const order = compilePlan(run.definition).rootScope;
                let scope = order;
                for (const step of scopePath) scope = scope.childScopes[step] ?? scope;
                roundVerdicts = describeLoop(container, scope.topologicalOrder, { run, scopeKey: parentKey }).rounds.map((r) => r.verdict);
              }
            } catch {
              // the path is being reset
            }
            return (
              <div className="instances">
                {instances.map((key, index) => (
                  <button
                    key={key}
                    type="button"
                    className="chip"
                    aria-pressed={key === scopeKey}
                    onClick={() => setInstanceChoice((c) => ({ ...c, [scopePath.join('/')]: index }))}
                  >
                    <span className="chip-tag">{isLoop ? 'Round' : 'Item'}</span>
                    {index + 1}
                    {roundVerdicts[index] ? ` · ${roundVerdicts[index]}` : run.scopes[key]?.status === 'FAILED' ? ' · failed' : ''}
                  </button>
                ))}
              </div>
            );
          })()}
          <Menu open={menu === 'workflows'} onClose={() => setMenu(null)}>
            <div className="menu-label">Workflows</div>
            {(workflows ?? []).map((w) => (
              <button key={w.id} type="button" className="option" onClick={() => navigate({ workflowId: w.id, runId: null })}>
                <span>
                  <div className="option-title">{w.name}</div>
                  <div className="option-desc">{w.description ?? w.id}</div>
                </span>
                {w.id === route.workflowId && !newWorkflow && (
                  <span className="check">
                    <CheckIcon />
                  </span>
                )}
              </button>
            ))}
            <button type="button" className="option" onClick={startNewWorkflow}>
              <span className="option-title">New workflow</span>
            </button>
            {editable && (
              <button
                type="button"
                className="option"
                onClick={() => {
                  setMenu(null);
                  setInspect({ type: 'workflow' });
                }}
              >
                <span className="option-title">Workflow settings…</span>
              </button>
            )}
            <button type="button" className="option" onClick={() => void loadSample()}>
              <span className="option-title">Load sample workflow</span>
            </button>
            <button type="button" className="option" onClick={() => setMenu('import')}>
              <span className="option-title">Import JSON…</span>
            </button>
            <button type="button" className="option" onClick={() => setMenu('workspaces')}>
              <span className="option-title">Workspaces…</span>
            </button>
          </Menu>
          <Menu open={menu === 'workspaces'} onClose={() => setMenu(null)} width={420}>
            <WorkspacesPanel
              workspaces={workspaces}
              defaultWorkspaceId={defaultWorkspaceId}
              onCreate={api.createWorkspace}
              onUpdate={api.updateWorkspace}
              onDelete={api.deleteWorkspace}
              onChanged={loadWorkspaces}
              onError={fail}
            />
          </Menu>
          <Menu open={menu === 'import'} onClose={() => setMenu(null)} width={380}>
            <ImportPanel onDone={(r) => void imported(r)} onError={fail} />
          </Menu>
        </div>

        {definition && (
          <div className="topbar-right">
            {editable && issues.length > 0 && (
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="pill"
                  data-tone="danger"
                  style={{ background: 'none', cursor: 'pointer' }}
                  onClick={() => setMenu(menu === 'issues' ? null : 'issues')}
                >
                  <span className="dot" />
                  {issues.length} issue{issues.length === 1 ? '' : 's'}
                </button>
                <Menu open={menu === 'issues'} onClose={() => setMenu(null)} align="right" width={340}>
                  <div className="menu-label">Fix these before saving</div>
                  {issues.map((issue, i) => (
                    <button
                      key={`${issue.code}-${i}`}
                      type="button"
                      className="issue-item"
                      onClick={() => {
                        setMenu(null);
                        setScopePath(issue.scopePath.split('/').slice(1));
                        if (issue.edgeId) setInspect({ type: 'edge', edgeId: issue.edgeId });
                        else if (issue.nodeId) setInspect({ type: 'node', nodeId: issue.nodeId });
                      }}
                    >
                      <span>
                        {issue.code} · {nodeName(issue.nodeId, issue.scopePath)}
                      </span>
                      {issue.message}
                    </button>
                  ))}
                </Menu>
              </div>
            )}

            {dirty ? (
              <>
                <button type="button" className="btn" onClick={undo} disabled={history.length === 0} title="Undo (⌘Z)">
                  Undo
                </button>
                <button type="button" className="btn" onClick={discard}>
                  Discard
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void save()}>
                  {newWorkflow ? 'Create workflow' : 'Save'} <span className="kbd">⌘S</span>
                </button>
              </>
            ) : (
              record && (
                <>
                  {run && (
                    <div className="view-switch" role="tablist" aria-label="Run display mode">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={runView === 'trace'}
                        className="view-switch-btn"
                        data-active={runView === 'trace' ? 'true' : 'false'}
                        onClick={() => setRunView('trace')}
                      >
                        Trace
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={runView === 'canvas'}
                        className="view-switch-btn"
                        data-active={runView === 'canvas' ? 'true' : 'false'}
                        onClick={() => setRunView('canvas')}
                      >
                        Canvas
                      </button>
                    </div>
                  )}
                  {!(editable && issues.length > 0) && (
                    <div style={{ position: 'relative' }}>
                      <button
                        type="button"
                        className="pill"
                        data-tone={escalation ? 'warn' : pill.tone}
                        style={{ background: 'none', cursor: escalation ? 'pointer' : 'default' }}
                        onClick={() => escalation && setMenu(menu === 'chief' ? null : 'chief')}
                      >
                        {pill.tone === 'ok' ? <CheckIcon /> : <span className="dot" />}
                        {escalation ? 'Chief needs you' : pill.text}
                      </button>
                      <Menu open={menu === 'chief' && !!escalation} onClose={() => setMenu(null)} align="right" width={320}>
                        {escalation && (
                          <EscalationPanel
                            wait={escalation}
                            onAnswer={(answer) => {
                              setMenu(null);
                              void actions.answer(escalation, answer).catch(() => undefined);
                            }}
                          />
                        )}
                      </Menu>
                    </div>
                  )}
                  <div style={{ position: 'relative' }}>
                    <button type="button" className="btn" onClick={() => setMenu(menu === 'runs' ? null : 'runs')}>
                      Runs <span className="chev">⌄</span>
                    </button>
                    <Menu open={menu === 'runs'} onClose={() => setMenu(null)} align="right">
                      <div className="menu-label">Recent runs</div>
                      <button type="button" className="option" onClick={() => navigate({ workflowId: record.id, runId: null })}>
                        <span className="option-title">Design view (edit)</span>
                        {!route.runId && (
                          <span className="check">
                            <CheckIcon />
                          </span>
                        )}
                      </button>
                      {runs.map((r) => (
                        <button key={r.runId} type="button" className="option" onClick={() => navigate({ workflowId: record.id, runId: r.runId })}>
                          <span>
                            <div className="option-title">{r.runId.slice(-8)}</div>
                            <div className="option-desc" data-tone={r.status === 'FAILED' ? 'danger' : undefined}>
                              {r.status.toLowerCase()} · {timeAgo(r.createdAtMs)}
                            </div>
                          </span>
                          {r.runId === route.runId && (
                            <span className="check">
                              <CheckIcon />
                            </span>
                          )}
                        </button>
                      ))}
                      {runs.length === 0 && <div className="popover-note">No runs yet.</div>}
                    </Menu>
                  </div>
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setMenu(menu === 'start' ? null : 'start')}
                    >
                      Run
                    </button>
                    <Menu open={menu === 'start'} onClose={() => setMenu(null)} align="right" width={360}>
                      <RunPanel
                        definition={record.definition}
                        workspaces={workspaces}
                        bindings={record.workspaceBindings ?? {}}
                        defaultWorkspaceId={defaultWorkspaceId}
                        onManageWorkspaces={() => setMenu('workspaces')}
                        onStart={(inputs, chosen) => void startRun(inputs, chosen)}
                      />
                    </Menu>
                  </div>
                </>
              )
            )}
          </div>
        )}
      </header>

      {run && runView === 'trace' ? (
        <TraceView
          run={run}
          runActive={stream.active}
          agentNames={agentNames}
          onOpenArtifact={actions.openArtifact}
          onRerun={actions.rerun}
          onAnswer={actions.answer}
        />
      ) : (
        model &&
        definition && (
          <CanvasActionsContext.Provider value={actions}>
            <WorkflowCanvas
              model={model}
              fitKey={`${newWorkflow ? `new:${newWorkflow.id}` : `${record?.id ?? ''}:${route.runId ?? ''}`}:${scopePath.join('/')}:${scopeKey}`}
              editable={editable}
              onLayoutChange={onLayoutChange}
              onBackgroundClick={() => {
                setOpenPopover(null);
                setInspect(null);
              }}
              onConnect={(connection) => {
                const result = connect(definition, connection, scopePath);
                if (result.ok) applyEdit(result.definition);
                else fail(result.error);
              }}
              onNodeClick={(nodeId) => actions.inspectNode(nodeId)}
              onEdgeClick={(edgeId) => setInspect({ type: 'edge', edgeId })}
              onAddNode={onAddNode}
              focusNodeId={focusNodeId}
            />
          </CanvasActionsContext.Provider>
        )
      )}

      {workflows?.length === 0 && !newWorkflow && (
        <div className="empty">
          <div className="empty-card">
            <h2>No workflows yet</h2>
            <p>Draw one on the canvas, start from a sample review flow, or import a WorkflowDefinition built with the SDK.</p>
            <div className="empty-actions" style={{ position: 'relative' }}>
              <button type="button" className="btn btn-primary" onClick={startNewWorkflow}>
                New workflow
              </button>
              <button type="button" className="btn" onClick={() => void loadSample()}>
                Load sample
              </button>
              <button type="button" className="btn" onClick={() => setMenu('import')}>
                Import JSON
              </button>
              <Menu open={menu === 'import'} onClose={() => setMenu(null)} width={380}>
                <ImportPanel onDone={(r) => void imported(r)} onError={fail} />
              </Menu>
            </div>
          </div>
        </div>
      )}

      {editable && inspect && definition && (
        <Inspector
          definition={definition}
          path={scopePath}
          onOpenScope={(nodeId) => actions.openScope(nodeId)}
          runtimes={runtimes}
          onRefreshRuntime={refreshRuntime}
          target={inspect}
          agents={agents}
          issues={issues}
          onChange={applyEdit}
          onClose={() => setInspect(null)}
          onError={fail}
        />
      )}

      {definition && (
        <ChiefDock
          run={run}
          policy={run ? run.definition.chief : definition.chief}
          editable={editable}
          agents={agents}
          chiefAnswering={stream.chiefAnswering}
          nodeName={nodeNameAnywhere}
          onPolicyChange={(chief) => applyEdit(updateWorkflowMeta(definition, { chief }))}
          onSend={async (text) => {
            if (!run) return;
            try {
              await api.messageChief(run.runId, text);
            } catch (err) {
              fail(err);
              throw err;
            }
          }}
          onAnswer={(wait, answer) => void actions.answer(wait, answer).catch(() => undefined)}
        />
      )}

      {artifact && (
        <aside className="sheet" aria-label={artifact.title}>
          <div className="sheet-head">
            <span>{artifact.title}</span>
            <button type="button" className="btn" onClick={() => setArtifact(null)}>
              Close
            </button>
          </div>
          <pre className="sheet-body">{artifact.content}</pre>
        </aside>
      )}

      {(toast ?? stream.error) && <div className="toast">{toast ?? stream.error}</div>}
    </div>
  );
}
