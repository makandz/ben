import type { Logger } from "../logger.js";
import type {
  ScheduledMessage,
  ScheduledMessageStore,
} from "../storage/ScheduledMessageStore.js";
import { computeNextRunAt } from "./scheduleTime.js";

export const SCHEDULE_CHECK_INTERVAL_MS = 30_000;
export const SCHEDULE_TIME_ZONE = "America/Toronto";

export type ScheduledMessageSchedulerOptions = {
  intervalMs?: number;
  timeZone?: string;
  now?: () => Date;
};

type SchedulerStore = Pick<
  ScheduledMessageStore,
  "listDue" | "markSent" | "reschedule" | "markFailed"
>;

type SchedulerLog = (text: string) => Promise<void>;

/** Polls persisted schedules and owns recurrence, retry, and missed-run behavior. */
export class ScheduledMessageScheduler {
  private readonly intervalMs: number;
  private readonly timeZone: string;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private startedAt: Date | undefined;

  /**
   * @param store - Persistent schedule operations.
   * @param deliver - Discord delivery capability.
   * @param logStatus - Operational schedule log destination.
   * @param logger - Structured application logger.
   * @param options - Narrow local timing and clock overrides, primarily for tests.
   * @throws When the configured polling interval is not a positive finite number.
   */
  constructor(
    private readonly store: SchedulerStore,
    private readonly deliver: (message: ScheduledMessage) => Promise<void>,
    private readonly logStatus: SchedulerLog,
    private readonly logger: Pick<Logger, "debug" | "info" | "warn">,
    options: ScheduledMessageSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? SCHEDULE_CHECK_INTERVAL_MS;
    this.timeZone = options.timeZone ?? SCHEDULE_TIME_ZONE;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive finite number");
    }
  }

  /**
   * Starts polling and waits for the initial startup pass to finish.
   *
   * @returns A promise that resolves after the initial due-message pass completes.
   */
  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.startedAt = this.now();
    this.timer = setInterval(() => {
      void this.runDueMessages("interval");
    }, this.intervalMs);
    this.logger.info("scheduled_messages.scheduler_started", {
      intervalMs: this.intervalMs,
      timeZone: this.timeZone,
    });
    await this.runDueMessages("startup", this.startedAt);
  }

  /** Stops polling without changing persisted schedules. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one non-overlapping due-message pass. */
  private async runDueMessages(reason: "startup" | "interval", now = this.now()): Promise<void> {
    if (this.running) {
      this.logger.debug("scheduled_messages.skipped_running", { reason });
      return;
    }
    this.running = true;
    try {
      const messages = await this.store.listDue(now);
      for (const message of messages) await this.runDueMessage(message, now, reason);
    } catch (error) {
      this.logger.warn("scheduled_messages.tick_failed", { reason, error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /** Applies missed-startup, successful-delivery, or retry behavior to one due schedule. */
  private async runDueMessage(
    message: ScheduledMessage,
    now: Date,
    reason: "startup" | "interval",
  ): Promise<void> {
    const dueAt = new Date(message.nextRunAt);
    if (message.repeat !== "none" && this.wasMissedBeforeStartup(dueAt)) {
      const nextRunAt = computeNextFutureRunAt(dueAt, message.repeat, this.timeZone, now);
      await this.store.reschedule(message.id, nextRunAt, now);
      await this.writeLogLine(
        `Skipped missed scheduled message ${message.id}; next run is ${nextRunAt.toISOString()}`,
      );
      this.logger.info("scheduled_messages.skipped_missed_recurring", {
        id: message.id,
        reason,
        dueAt: message.nextRunAt,
        nextRunAt: nextRunAt.toISOString(),
      });
      return;
    }

    try {
      await this.deliver(message);
      const nextRunAt = computeNextRunAt(dueAt, message.repeat, this.timeZone);
      await this.store.markSent(message.id, nextRunAt, now);
      await this.writeLogLine(formatSentLogLine(message, nextRunAt));
      this.logger.info("scheduled_messages.sent", {
        id: message.id,
        repeat: message.repeat,
        channelId: message.channelId,
        targetUsers: message.targetUsers.length,
        nextRunAt: nextRunAt?.toISOString(),
      });
    } catch (error) {
      const failureCount = await this.store.markFailed(message.id, now);
      await this.writeLogLine(`Failed to send scheduled message ${message.id}: ${String(error)}`);
      this.logger.warn("scheduled_messages.send_failed", {
        id: message.id,
        failureCount,
        error: String(error),
      });
    }
  }

  /** Returns whether a due occurrence predates this process's scheduler startup. */
  private wasMissedBeforeStartup(dueAt: Date): boolean {
    return this.startedAt !== undefined && dueAt.getTime() < this.startedAt.getTime();
  }

  /** Contains optional operational-log failures. */
  private async writeLogLine(text: string): Promise<void> {
    await this.logStatus(text).catch((error: unknown) => {
      this.logger.warn("scheduled_messages.log_failed", { error: String(error) });
    });
  }
}

/** Finds the first future recurring occurrence after an overdue startup pass. */
function computeNextFutureRunAt(
  dueAt: Date,
  repeat: "daily" | "weekly",
  timeZone: string,
  now: Date,
): Date {
  let nextRunAt = computeNextRunAt(dueAt, repeat, timeZone);
  while (nextRunAt !== undefined && nextRunAt.getTime() <= now.getTime()) {
    nextRunAt = computeNextRunAt(nextRunAt, repeat, timeZone);
  }
  if (nextRunAt === undefined) {
    throw new Error("Recurring scheduled message did not produce a next run.");
  }
  return nextRunAt;
}

/** Formats an operational success line with recurrence state. */
function formatSentLogLine(message: ScheduledMessage, nextRunAt: Date | undefined): string {
  const targetText = message.targetUsers.length === 0
    ? "no targets"
    : message.targetUsers.map((target) => `@${target.username}`).join(", ");
  if (nextRunAt === undefined) {
    return `Sent scheduled message ${message.id} to #${message.channelName} (${targetText}); schedule complete.`;
  }
  return `Sent scheduled message ${message.id} to #${message.channelName} (${targetText}); next run is ${nextRunAt.toISOString()}.`;
}
