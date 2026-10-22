/** Shared ACP config option. Planning does not change sandbox or approval policy. */
export const PLAN_MODE_CONFIG_ID = 'plan_mode' as const;
/** @deprecated Use `PLAN_MODE_CONFIG_ID` instead. */
export const LODY_PLAN_MODE_CONFIG_ID = PLAN_MODE_CONFIG_ID;

export type PlanModeConfigOption = {
  id: typeof PLAN_MODE_CONFIG_ID;
  name: string;
  description: string;
  type: 'boolean';
  currentValue: boolean;
};

/** @deprecated Use `PlanModeConfigOption` instead. */
export type LodyPlanModeConfigOption = PlanModeConfigOption;

/** Advertise only when the current session supports independent planning. */
export function createPlanModeConfigOption(currentValue: boolean): PlanModeConfigOption {
  return {
    id: PLAN_MODE_CONFIG_ID,
    name: 'Plan',
    description: 'Plan before implementing; permissions are controlled separately.',
    type: 'boolean',
    currentValue,
  };
}
