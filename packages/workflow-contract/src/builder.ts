import { type ChiefPolicy, type ChiefPolicyInput, ChiefPolicySchema } from './chief';
import { compileWorkflowDefinition, type CompiledWorkflowPlan } from './dag-compiler';
import type {
  AgentNode,
  LoopExhaustedPolicy,
  ControlEdge,
  DataDeliveryMode,
  DataEdge,
  EdgeCondition,
  GateNode,
  LoopNode,
  ParallelNode,
  PortDefinition,
  ScriptNode,
  SubflowNode,
  WorkspaceSlot,
  WorkspaceSlotInput,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowNode,
} from './schema';
import { WorkspaceSlotSchema } from './schema';

export class WorkflowGraphBuilder {
  private readonly nodes: WorkflowNode[] = [];
  private readonly controlEdges: ControlEdge[] = [];
  private readonly dataEdges: DataEdge[] = [];
  private edgeSeq = 0;

  addNode(node: WorkflowNode): this {
    this.nodes.push(node);
    return this;
  }

  addAgent(
    config: Omit<AgentNode, 'kind' | 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'acceptanceCriteria' | 'constraints' | 'producesAssessment' | 'readWorkspaces'> &
      Partial<Pick<AgentNode, 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'acceptanceCriteria' | 'constraints' | 'producesAssessment' | 'readWorkspaces'>>
  ): this {
    this.nodes.push({
      kind: 'agent',
      inputs: [],
      outputs: [],
      writeScopes: [],
      maxTechnicalRetries: 0,
      acceptanceCriteria: [],
      constraints: [],
      producesAssessment: false,
      readWorkspaces: [],
      ...config,
    });
    return this;
  }

  addScript(
    config: Omit<ScriptNode, 'kind' | 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'args' | 'timeoutMs' | 'producesAssessment'> &
      Partial<Pick<ScriptNode, 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'args' | 'timeoutMs' | 'producesAssessment'>>
  ): this {
    this.nodes.push({
      kind: 'script',
      inputs: [],
      outputs: [],
      writeScopes: [],
      maxTechnicalRetries: 0,
      args: [],
      timeoutMs: 60_000,
      producesAssessment: true,
      ...config,
    });
    return this;
  }

  addGate(
    config: Omit<GateNode, 'kind' | 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'options'> &
      Partial<Pick<GateNode, 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'options'>>
  ): this {
    this.nodes.push({
      kind: 'gate',
      inputs: [],
      outputs: [],
      writeScopes: [],
      maxTechnicalRetries: 0,
      options: [],
      ...config,
    });
    return this;
  }

  /** A step that runs the saved workflow `workflowId` (embedded when a run starts). */
  addSubflow(
    config: Omit<SubflowNode, 'kind' | 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries'> &
      Partial<Pick<SubflowNode, 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries'>>
  ): this {
    this.nodes.push({ kind: 'subflow', inputs: [], outputs: [], writeScopes: [], maxTechnicalRetries: 0, ...config });
    return this;
  }

  /**
   * Closes a loop: from the deciding step `fromNodeId` back to the earlier step `toNodeId`,
   * taken while `when` (on the decider's result) holds, at most `maxRounds` rounds in all.
   */
  loopBack(
    fromNodeId: string,
    toNodeId: string,
    when: EdgeCondition,
    loop: { maxRounds?: number; onExhausted?: LoopExhaustedPolicy } = {},
    id?: string
  ): this {
    this.connectControl(fromNodeId, toNodeId, when, id ?? `loop_${fromNodeId}_to_${toNodeId}`);
    const edge = this.controlEdges[this.controlEdges.length - 1]!;
    edge.loop = { maxRounds: loop.maxRounds ?? 3, onExhausted: loop.onExhausted ?? 'fail' };
    return this;
  }

  addLoop(
    config: Omit<LoopNode, 'kind' | 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'maxRounds' | 'onExhausted' | 'bodyGraph'> &
      Partial<Pick<LoopNode, 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'maxRounds' | 'onExhausted'>> & {
        body: WorkflowGraph | ((builder: WorkflowGraphBuilder) => void);
      }
  ): this {
    let bodyGraph: WorkflowGraph;
    if (typeof config.body === 'function') {
      const sub = new WorkflowGraphBuilder();
      config.body(sub);
      bodyGraph = sub.toGraph();
    } else {
      bodyGraph = config.body;
    }
    const { body: _body, ...rest } = config;
    this.nodes.push({
      kind: 'loop',
      inputs: [],
      outputs: [],
      writeScopes: [],
      maxTechnicalRetries: 0,
      maxRounds: 3,
      onExhausted: 'fail',
      ...rest,
      bodyGraph,
    });
    return this;
  }

  addParallel(
    config: Omit<ParallelNode, 'kind' | 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'itemsPort' | 'maxConcurrency' | 'failurePolicy' | 'itemGraph'> &
      Partial<Pick<ParallelNode, 'inputs' | 'outputs' | 'writeScopes' | 'maxTechnicalRetries' | 'itemsPort' | 'maxConcurrency' | 'failurePolicy'>> & {
        itemBody: WorkflowGraph | ((builder: WorkflowGraphBuilder) => void);
      }
  ): this {
    let itemGraph: WorkflowGraph;
    if (typeof config.itemBody === 'function') {
      const sub = new WorkflowGraphBuilder();
      config.itemBody(sub);
      itemGraph = sub.toGraph();
    } else {
      itemGraph = config.itemBody;
    }
    const { itemBody: _itemBody, ...rest } = config;
    this.nodes.push({
      kind: 'parallel',
      inputs: [{ name: config.itemsPort ?? 'items', type: 'array', required: true }],
      outputs: [{ name: 'results', type: 'array', required: true }],
      writeScopes: [],
      maxTechnicalRetries: 0,
      itemsPort: 'items',
      maxConcurrency: 4,
      failurePolicy: 'settle_all',
      ...rest,
      itemGraph,
    });
    return this;
  }

  connectControl(fromNodeId: string, toNodeId: string, when?: EdgeCondition, id?: string): this {
    const baseId = id ?? `ctrl_${fromNodeId}_to_${toNodeId}`;
    const finalId = this.controlEdges.some((e) => e.id === baseId)
      ? `${baseId}_${++this.edgeSeq}`
      : baseId;
    this.controlEdges.push({
      id: finalId,
      fromNodeId,
      toNodeId,
      ...(when ? { when } : {}),
    });
    return this;
  }

  connectData(options: {
    id?: string;
    fromNodeId: string;
    fromPort: string;
    toNodeId: string;
    toPort: string;
    required?: boolean;
    delivery?: DataDeliveryMode;
    /** If true, also adds a control edge between fromNodeId and toNodeId when both are regular nodes. */
    withControl?: boolean;
  }): this {
    const baseId =
      options.id ??
      `data_${options.fromNodeId}.${options.fromPort}_to_${options.toNodeId}.${options.toPort}`;
    const finalId = this.dataEdges.some((e) => e.id === baseId)
      ? `${baseId}_${++this.edgeSeq}`
      : baseId;
    this.dataEdges.push({
      id: finalId,
      fromNodeId: options.fromNodeId,
      fromPort: options.fromPort,
      toNodeId: options.toNodeId,
      toPort: options.toPort,
      required: options.required ?? true,
      delivery: options.delivery ?? 'auto',
    });
    if (
      options.withControl &&
      options.fromNodeId !== '$input' &&
      options.toNodeId !== '$output'
    ) {
      const exists = this.controlEdges.some(
        (e) => e.fromNodeId === options.fromNodeId && e.toNodeId === options.toNodeId && !e.when
      );
      if (!exists) {
        this.connectControl(options.fromNodeId, options.toNodeId);
      }
    }
    return this;
  }

  toGraph(): WorkflowGraph {
    return {
      nodes: [...this.nodes],
      controlEdges: [...this.controlEdges],
      dataEdges: [...this.dataEdges],
    };
  }
}

export class WorkflowBuilder extends WorkflowGraphBuilder {
  private readonly id: string;
  private readonly name: string;
  private version = '1.0.0';
  private description?: string;
  private readonly workflowInputs: PortDefinition[] = [];
  private readonly workflowOutputs: PortDefinition[] = [];
  private metadata?: Record<string, string | number | boolean>;
  private chief?: ChiefPolicy;
  private readonly workspaceSlots: WorkspaceSlot[] = [];
  private defaultWorkspace?: string;

  constructor(id: string, name?: string) {
    super();
    this.id = id;
    this.name = name ?? id;
  }

  setVersion(version: string): this {
    this.version = version;
    return this;
  }

  setDescription(description: string): this {
    this.description = description;
    return this;
  }

  addWorkflowInput(port: PortDefinition): this {
    this.workflowInputs.push(port);
    return this;
  }

  addWorkflowOutput(port: PortDefinition): this {
    this.workflowOutputs.push(port);
    return this;
  }

  /** Declares a workspace slot; each run binds it to a concrete directory. */
  addWorkspace(slot: WorkspaceSlotInput): this {
    this.workspaceSlots.push(WorkspaceSlotSchema.parse(slot));
    return this;
  }

  setDefaultWorkspace(slot: string): this {
    this.defaultWorkspace = slot;
    return this;
  }

  /** Attaches a chief agent that supervises runs of this workflow. */
  setChief(policy: ChiefPolicyInput = {}): this {
    this.chief = ChiefPolicySchema.parse(policy);
    return this;
  }

  setMetadata(metadata: Record<string, string | number | boolean>): this {
    this.metadata = metadata;
    return this;
  }

  buildDefinition(): WorkflowDefinition {
    return {
      id: this.id,
      version: this.version,
      name: this.name,
      ...(this.description ? { description: this.description } : {}),
      inputs: [...this.workflowInputs],
      outputs: [...this.workflowOutputs],
      graph: this.toGraph(),
      workspaces: [...this.workspaceSlots],
      ...(this.defaultWorkspace ? { defaultWorkspace: this.defaultWorkspace } : {}),
      ...(this.chief ? { chief: this.chief } : {}),
      ...(this.metadata ? { metadata: this.metadata } : {}),
    };
  }

  compile(): CompiledWorkflowPlan {
    return compileWorkflowDefinition(this.buildDefinition());
  }
}

export function createWorkflowBuilder(id: string, name?: string): WorkflowBuilder {
  return new WorkflowBuilder(id, name);
}
