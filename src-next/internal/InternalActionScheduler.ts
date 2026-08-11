import type { ActivityPresence, PresenceTransport } from "../app/PresenceTransport.js";
import type { ChatTransport } from "../app/ChatTransport.js";
import type { Logger } from "../logger.js";
import type { InternalActionRunner } from "./InternalActionRunner.js";
import { InternalStateStore, isFreshStatusState } from "./InternalStateStore.js";
import { formatActivityStatus, type InternalStatus } from "./InternalStatus.js";

export const INTERNAL_ACTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type InternalActionSchedulerOptions = {
  intervalMs?: number;
  now?: () => Date;
};

/** Reuses fresh activity state and runs non-overlapping status refreshes. */
export class InternalActionScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private running = false;
  private currentStatus: InternalStatus | undefined;
  private availability: "idle" | "online" = "idle";

  /**
   * @param runner - Controlled internal action capability.
   * @param stateStore - Compatible status persistence operations.
   * @param presence - Underlying platform presence transport.
   * @param transport - Operational status destination.
   * @param logger - Structured scheduler logger.
   * @param options - Narrow interval and clock overrides.
   */
  constructor(
    private readonly runner: Pick<InternalActionRunner, "runStatusAction">,
    private readonly stateStore: Pick<InternalStateStore, "readCurrentStatus" | "writeCurrentStatus">,
    private readonly presence: PresenceTransport,
    private readonly transport: Pick<ChatTransport, "logStatus">,
    private readonly logger: Pick<Logger, "debug" | "info" | "warn">,
    options: InternalActionSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? INTERNAL_ACTION_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive finite number");
    }
  }

  /** @returns A promise that resolves after status initialization and scheduling. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const saved = await this.stateStore.readCurrentStatus();
    const now = this.now();
    let delay = this.intervalMs;
    if (saved !== undefined && isFreshStatusState(saved, this.intervalMs, now)) {
      this.applyStatus(saved.status);
      delay = Math.max(this.intervalMs - (now.getTime() - Date.parse(saved.setAt)), 0);
      this.logger.info("internal.status_reused", { setAt: saved.setAt, nextDelayMs: delay, ...saved.status });
    } else {
      await this.runStatusAction("startup");
    }
    this.schedule(delay);
    this.logger.info("internal.scheduler_started", { intervalMs: this.intervalMs });
  }

  /** Stops future refreshes. */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  /** @returns The formatted current custom activity. */
  getCurrentActivityStatus(): string | undefined {
    return this.currentStatus === undefined ? undefined : formatActivityStatus(this.currentStatus);
  }

  /**
   * Updates availability while retaining the current activity.
   *
   * @param awake - Whether the conversation session is awake.
   */
  setAwakePresence(awake: boolean): void {
    this.availability = awake ? "online" : "idle";
    this.presence.setPresence({
      status: this.availability,
      ...(this.currentStatus === undefined ? {} : { activity: formatActivityStatus(this.currentStatus) }),
    });
  }

  /**
   * Applies session availability while preserving scheduler-owned activity text.
   *
   * @param presence - Session-requested availability.
   */
  setPresence(presence: ActivityPresence): void {
    this.setAwakePresence(presence.status === "online");
  }

  private schedule(delay: number): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      void this.runStatusAction("interval").finally(() => this.schedule(this.intervalMs));
    }, delay);
  }

  /** Runs one refresh while suppressing overlapping invocations. */
  private async runStatusAction(reason: "startup" | "interval"): Promise<void> {
    if (this.running) {
      this.logger.debug("internal.skipped_running", { action: "status", reason });
      return;
    }
    this.running = true;
    try {
      const result = await this.runner.runStatusAction();
      if (result.type === "budget_exceeded") {
        this.logger.info("internal.status_budget_exceeded", { reason, ...result });
        return;
      }
      if (result.type === "failed") {
        this.logger.warn("internal.status_failed", { reason, error: String(result.error) });
        return;
      }
      const changed = !sameStatus(this.currentStatus, result.status);
      this.applyStatus(result.status);
      await this.stateStore.writeCurrentStatus(result.status, this.now());
      if (!changed) {
        this.logger.info("internal.status_unchanged", { reason, ...result.status });
        return;
      }
      await this.writeLog("Thinking of a new activity status..");
      if (result.reasoningSummary !== undefined) {
        const thought = stripBoldMarkdown(result.reasoningSummary);
        if (thought.length > 0) await this.writeLog(`> 💭 ${thought}`);
      }
      await this.writeLog(`Setting status to "${formatActivityStatus(result.status)}"`);
      this.logger.info("internal.status_applied", { reason, ...result.status });
    } catch (error) {
      this.logger.warn("internal.status_failed", { reason, error: String(error) });
    } finally {
      this.running = false;
    }
  }

  private applyStatus(status: InternalStatus): void {
    this.currentStatus = status;
    this.presence.setPresence({ status: this.availability, activity: formatActivityStatus(status) });
  }

  private async writeLog(text: string): Promise<void> {
    await this.transport.logStatus(text).catch((error: unknown) => {
      this.logger.warn("internal.log_send_failed", { error: String(error) });
    });
  }
}

function sameStatus(left: InternalStatus | undefined, right: InternalStatus): boolean {
  return left?.emoji === right.emoji && left.text === right.text;
}

function stripBoldMarkdown(text: string): string {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").trim();
}
