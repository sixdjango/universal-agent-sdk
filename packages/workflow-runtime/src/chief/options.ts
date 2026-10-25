import { CHIEF_COMMAND_LEVEL, type ArtifactVersion, type ChiefCommand } from '@universal-agent/workflow-contract';

export interface ChiefArtifactCandidate {
  readonly runId: string;
  readonly artifact: ArtifactVersion;
  /** Where the artifact was referenced in the run. */
  readonly source: { readonly scopeKey: string; readonly nodeId: string; readonly port: string };
}

export interface ChiefContextOptions {
  /** Include this run's diagnostic artifacts (default true). */
  readonly enabled?: boolean;
  /** Maximum bytes per read; defaults to 8 KiB. Must be a positive safe integer. */
  readonly pageReadBytes?: number;
  /** Cumulative bytes per chief review; omitted means unlimited. */
  readonly stageReadQuotaBytes?: number;
  /** Further restrict eligible current-run artifacts. Throwing fails the review closed. */
  readonly includeArtifact?: (candidate: ChiefArtifactCandidate) => boolean | Promise<boolean>;
}

/** Host policy, independent of the workflow's graph and persisted ChiefPolicy. */
export interface ChiefRuntimeOptions {
  /** Intersected with ChiefPolicy.maxLevel. Omit for existing behavior; [] permits no commands. */
  readonly allowedCommands?: readonly ChiefCommand['kind'][];
  readonly context?: ChiefContextOptions;
}

/** Validate and snapshot host configuration before any run is started. */
export function resolveChiefRuntimeOptions(options: ChiefRuntimeOptions = {}): ChiefRuntimeOptions {
  for (const key of ['pageReadBytes', 'stageReadQuotaBytes'] as const) {
    const value = options.context?.[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`chiefOptions.context.${key} must be a positive safe integer`);
    }
  }
  if (options.allowedCommands?.some(kind => !Object.hasOwn(CHIEF_COMMAND_LEVEL, kind))) {
    throw new TypeError('chiefOptions.allowedCommands contains an unknown command');
  }
  return {
    ...(options.allowedCommands ? { allowedCommands: Object.freeze([...options.allowedCommands]) } : {}),
    ...(options.context ? { context: Object.freeze({ ...options.context }) } : {}),
  };
}
