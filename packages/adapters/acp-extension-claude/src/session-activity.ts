import type { LodySessionActivityState, LodySessionActivityUpdate } from "acp-extension-core";

type Publish = (update: LodySessionActivityUpdate) => Promise<void>;

/** One entry of the SDK's `background_tasks_changed` payload. */
type BackgroundTaskLevelEntry = { task_id: string; ambient?: boolean };

/**
 * Reports the session's activity level to the client: Claude Code's own
 * `session_state_changed` state plus how many background tasks are live.
 *
 * The client cannot see either from prompt responses. A turn ends with
 * `end_turn` while a `run_in_background` shell or a Monitor keeps running, and
 * when that task finishes Claude Code starts a new model turn by itself. Without
 * this level the client treats such a session as idle and may stop the agent
 * process, which kills the task before it can wake the model.
 *
 * The SDK message loop calls this without awaiting, so it never yields there.
 * Order is still kept: each call hands its message to the connection before
 * its first `await`.
 */
export class SessionActivityReporter {
  private state: LodySessionActivityState = "idle";
  private backgroundTaskCount = 0;
  /** The last level sent, as `state:count`; undefined until the first send. */
  private reported: string | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly publish: Publish,
    private readonly logError: (message: string, error: unknown) => void,
  ) {}

  async stateChanged(state: LodySessionActivityState): Promise<void> {
    this.state = state;
    await this.report();
  }

  /** Takes the full live set with replace semantics, as the SDK sends it. */
  async backgroundTasksChanged(tasks: readonly BackgroundTaskLevelEntry[]): Promise<void> {
    // The SDK marks internal watchers and skip_transcript tasks `ambient`, and
    // says hosts should not count them as activity.
    this.backgroundTaskCount = tasks.filter((task) => task.ambient !== true).length;
    await this.report();
  }

  private async report(): Promise<void> {
    const key = `${this.state}:${this.backgroundTaskCount}`;
    if (key === this.reported) return;
    this.reported = key;
    try {
      await this.publish({
        version: 1,
        sessionId: this.sessionId,
        state: this.state,
        backgroundTaskCount: this.backgroundTaskCount,
      });
    } catch (error) {
      // A failed send must not stop the SDK message loop. The next change
      // sends the full level again, so nothing is lost for good.
      this.reported = undefined;
      this.logError(
        `[claude-agent-acp] Session ${this.sessionId}: failed to send activity update`,
        error,
      );
    }
  }
}
