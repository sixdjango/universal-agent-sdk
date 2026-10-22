import type { LodyGoalSnapshot } from 'acp-extension-core';

/** Native Goal keeps continuation authority separate from its durable phase. */
export type NativeGoal = {
  id: string;
  revision: number;
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  activation: 'armed' | 'disarmed';
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  blockedReason?: { code: string; message: string };
};
export type GoalService<A> = {
  get(agent: A): NativeGoal | undefined;
  create(agent: A, request: { objective: string }): NativeGoal;
  resume(agent: A, ref: NativeGoal): NativeGoal;
  pause(agent: A, ref: NativeGoal): NativeGoal;
  clear(agent: A, ref: NativeGoal): unknown;
};
export function goalSnapshot(goal: NativeGoal | undefined): LodyGoalSnapshot | null {
  return goal
    ? {
        objective: goal.objective,
        status:
          goal.blockedReason?.code === 'round-limit'
            ? 'limited'
            : goal.phase === 'active' && goal.activation === 'disarmed'
              ? 'paused'
              : goal.phase,
        iterations: goal.roundsStarted,
        createdAtEpochSeconds: goal.createdAt / 1000,
        updatedAtEpochSeconds: goal.updatedAt / 1000,
        ...(goal.blockedReason ? { lastReason: goal.blockedReason.message } : {}),
      }
    : null;
}
