import type { AgentRuntimeBinding } from '@universal-agent/workflow-contract';
import { useState } from 'react';
import type { AgentRuntimeInfo } from '../types';
import { effectiveRuntime, type RuntimeChoice } from '../model/runtime';

export { describeRuntime, effectiveRuntime, type RuntimeChoice } from '../model/runtime';

/**
 * Client / model / effort selects. Lists follow the chosen client; switching clients drops
 * a model or effort that the new client does not offer.
 */
export function RuntimeFields(props: {
  value: RuntimeChoice;
  agentRuntime?: AgentRuntimeBinding;
  runtimes: readonly AgentRuntimeInfo[];
  compact?: boolean;
  onChange(next: RuntimeChoice): void;
  onRefresh?(agentType: string): Promise<void>;
}) {
  const { value, agentRuntime, runtimes } = props;
  const [refreshing, setRefreshing] = useState(false);
  const inherited = effectiveRuntime({}, agentRuntime);
  const clientType = value.agentType ?? agentRuntime?.agentType;
  const client = runtimes.find((r) => r.agentType === clientType);
  const sameClient = !value.agentType || value.agentType === agentRuntime?.agentType;
  const modelForEfforts = value.modelId ?? (sameClient ? agentRuntime?.modelId : undefined);
  const efforts = (modelForEfforts && client?.effortsByModel?.[modelForEfforts]) || client?.efforts || [];

  const set = (patch: RuntimeChoice) => {
    const next: RuntimeChoice = { ...value, ...patch };
    for (const key of Object.keys(next) as (keyof RuntimeChoice)[]) if (!next[key]) delete next[key];
    props.onChange(next);
  };
  const changeClient = (agentType: string) => {
    const target = runtimes.find((r) => r.agentType === (agentType || agentRuntime?.agentType));
    const keepModel = value.modelId && target?.models.some((m) => m.id === value.modelId);
    const keepEffort = value.effort && target?.efforts.includes(value.effort);
    props.onChange({
      ...(agentType && agentType !== agentRuntime?.agentType ? { agentType } : {}),
      ...(keepModel ? { modelId: value.modelId } : {}),
      ...(keepEffort ? { effort: value.effort } : {}),
    });
  };
  const label = (text: string) => (props.compact ? null : <span>{text}</span>);

  return (
    <div className={props.compact ? 'runtime-fields compact' : 'runtime-fields'}>
      <label className="field">
        {label('Agent client')}
        <select aria-label="Agent client" value={value.agentType ?? ''} onChange={(e) => changeClient(e.target.value)}>
          <option value="">{inherited.agentType ? `Agent's client (${inherited.agentType})` : 'Agent default'}</option>
          {runtimes.map((r) => (
            <option key={r.agentType} value={r.agentType}>
              {r.agentType}
              {r.installed ? '' : ' · not installed'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {label('Model')}
        <select aria-label="Model" value={value.modelId ?? ''} onChange={(e) => set({ modelId: e.target.value })}>
          <option value="">{sameClient && agentRuntime?.modelId ? `Agent's model (${agentRuntime.modelId})` : 'Client default'}</option>
          {(client?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
            </option>
          ))}
          {value.modelId && !client?.models.some((m) => m.id === value.modelId) && <option value={value.modelId}>{value.modelId}</option>}
        </select>
      </label>
      <label className="field">
        {label('Effort')}
        <select aria-label="Effort" value={value.effort ?? ''} onChange={(e) => set({ effort: e.target.value })}>
          <option value="">{agentRuntime?.effort ? `Agent's effort (${agentRuntime.effort})` : 'Client default'}</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
          {value.effort && !efforts.includes(value.effort) && <option value={value.effort}>{value.effort}</option>}
        </select>
      </label>
      {client && client.installed && client.source !== 'probed' && props.onRefresh && (
        <button
          type="button"
          className="link-btn"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await props.onRefresh!(client.agentType);
            } finally {
              setRefreshing(false);
            }
          }}
        >
          {refreshing ? `Asking ${client.agentType}…` : `Get the latest ${client.agentType} models`}
        </button>
      )}
      {client && !client.installed && <div className="popover-note">{client.agentType} is not installed on this machine.</div>}
    </div>
  );
}
