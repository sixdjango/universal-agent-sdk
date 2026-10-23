import {
  type AcpCapabilitiesResult,
  BUILTIN_AGENT_TYPES,
  type BuiltinAgentType,
  detectAgentExecutable,
  getStaticBuiltinAcpCapabilities,
  isAcpThoughtLevelConfigOption,
  probeAgentCapabilities,
} from '@universal-agent/client';

/** What a step can pick for one agent client (engine). */
export interface AgentRuntimeInfo {
  readonly agentType: string;
  readonly installed: boolean;
  readonly resolvedPath?: string;
  readonly models: readonly { readonly id: string; readonly name?: string; readonly description?: string }[];
  /** Effort levels the client accepts (its "default" placeholder removed). */
  readonly efforts: readonly string[];
  /** Per-model effort levels when the client restricts them. */
  readonly effortsByModel?: Readonly<Record<string, readonly string[]>>;
  /** `static`: shipped catalog; `probed`: read from the running client; `none`: unknown. */
  readonly source: 'static' | 'probed' | 'none';
}

const DEFAULT_VALUE = 'default';

function fromCapabilities(
  agentType: string,
  installed: { found: boolean; resolvedPath?: string },
  capabilities: Pick<AcpCapabilitiesResult, 'models' | 'configOptions' | 'modelReasoningEfforts'> | undefined,
  source: AgentRuntimeInfo['source']
): AgentRuntimeInfo {
  const effortOption = capabilities?.configOptions?.find((o) =>
    isAcpThoughtLevelConfigOption({ id: o.id, ...(o.category ? { category: o.category } : {}) })
  );
  return {
    agentType,
    installed: installed.found,
    ...(installed.resolvedPath ? { resolvedPath: installed.resolvedPath } : {}),
    models: (capabilities?.models ?? [])
      .filter((m) => m.modelId !== DEFAULT_VALUE)
      .map((m) => ({ id: m.modelId, ...(m.name ? { name: m.name } : {}), ...(m.description ? { description: m.description } : {}) })),
    efforts: (effortOption?.options ?? []).map((o) => String(o.value)).filter((v) => v !== DEFAULT_VALUE),
    ...(capabilities?.modelReasoningEfforts && Object.keys(capabilities.modelReasoningEfforts).length > 0
      ? { effortsByModel: capabilities.modelReasoningEfforts }
      : {}),
    source: capabilities ? source : 'none',
  };
}

/**
 * Catalog of agent clients for pickers: which built-in clients are installed and which
 * models / effort levels they offer. Uses the shipped static catalog by default; `refresh`
 * starts the client once to read its live lists (slower, but current).
 */
export class AgentRuntimeCatalog {
  private readonly options: { workdir: string; dataDir?: string; env?: NodeJS.ProcessEnv };
  private readonly probed = new Map<string, AgentRuntimeInfo>();
  private detected: { at: number; results: Map<string, { found: boolean; resolvedPath?: string }> } | null = null;

  constructor(options: { workdir: string; dataDir?: string; env?: NodeJS.ProcessEnv }) {
    this.options = options;
  }

  private async detectAll(): Promise<Map<string, { found: boolean; resolvedPath?: string }>> {
    if (this.detected && Date.now() - this.detected.at < 60_000) return this.detected.results;
    const entries = await Promise.all(
      BUILTIN_AGENT_TYPES.map(async (type) => {
        const result = await detectAgentExecutable(type).catch(() => ({ found: false }));
        return [type, result] as const;
      })
    );
    this.detected = { at: Date.now(), results: new Map(entries) };
    return this.detected.results;
  }

  async list(): Promise<AgentRuntimeInfo[]> {
    const detected = await this.detectAll();
    return BUILTIN_AGENT_TYPES.map(
      (type) =>
        this.probed.get(type) ??
        fromCapabilities(type, detected.get(type) ?? { found: false }, getStaticBuiltinAcpCapabilities(type), 'static')
    );
  }

  /** Starts `agentType` once to read its current models and effort levels. */
  async refresh(agentType: string): Promise<AgentRuntimeInfo> {
    if (!(BUILTIN_AGENT_TYPES as readonly string[]).includes(agentType)) {
      throw new Error(`Unknown agent client "${agentType}"`);
    }
    const detected = (await this.detectAll()).get(agentType) ?? { found: false };
    if (!detected.found) throw new Error(`Agent client "${agentType}" is not installed`);
    const capabilities = await probeAgentCapabilities({
      agentType: agentType as BuiltinAgentType,
      workdir: this.options.workdir,
      ...(this.options.dataDir ? { dataDir: this.options.dataDir } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    const info = fromCapabilities(agentType, detected, capabilities, 'probed');
    this.probed.set(agentType, info);
    return info;
  }
}
