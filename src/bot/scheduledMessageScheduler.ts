import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { computeNextRunAt } from "./scheduleTime.js";
import type { ScheduledMessage, ScheduledMessageStore } from "./scheduledMessageStore.js";

type SendScheduledMessage = (message: ScheduledMessage) => Promise<void>;
type SendLogMessage = (text: string) => Promise<boolean>;

export class ScheduledMessageScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private startedAt: Date | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: ScheduledMessageStore,
    private readonly sendScheduledMessage: SendScheduledMessage,
    private readonly sendLogMessage: SendLogMessage,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.startedAt = new Date();
    void this.runDueMessages("startup");
    this.timer = setInterval(() => {
      void this.runDueMessages("interval");
    }, this.config.scheduleCheckIntervalMs);

    this.logger.info("scheduled_messages.scheduler_started", {
      intervalMs: this.config.scheduleCheckIntervalMs,
      timeZone: this.config.scheduleTimezone,
    });
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runDueMessages(reason: string): Promise<void> {
    if (this.running) {
      this.logger.debug("scheduled_messages.skipped_running", { reason });
      return;
    }

    this.running = true;

    try {
      const now = new Date();
      const dueMessages = await this.store.listDue(now);

      for (const message of dueMessages) {
        await this.runDueMessage(message, now, reason);
      }
    } catch (error) {
      this.logger.warn("scheduled_messages.tick_failed", { reason, error: String(error) });
    } finally {
      this.running = false;
    }
  }

  private async runDueMessage(
    message: ScheduledMessage,
    now: Date,
    reason: string,
  ): Promise<void> {
    const dueAt = new Date(message.nextRunAt);

    if (message.repeat !== "none" && this.wasMissedBeforeStartup(dueAt)) {
      const nextRunAt = computeNextFutureRunAt(dueAt, message.repeat, this.config.scheduleTimezone, now);

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
      await this.sendScheduledMessage(message);

      const nextRunAt = computeNextRunAt(dueAt, message.repeat, this.config.scheduleTimezone);
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

      await this.writeLogLine(
        `Failed to send scheduled message ${message.id}: ${String(error)}`,
      );
      this.logger.warn("scheduled_messages.send_failed", {
        id: message.id,
        failureCount,
        error: String(error),
      });
    }
  }

  private wasMissedBeforeStartup(dueAt: Date): boolean {
    return this.startedAt !== undefined && dueAt.getTime() < this.startedAt.getTime();
  }

  private async writeLogLine(text: string): Promise<void> {
    await this.sendLogMessage(text).catch((error: unknown) => {
      this.logger.warn("scheduled_messages.log_failed", { error: String(error) });
    });
  }
}

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

function formatSentLogLine(
  message: ScheduledMessage,
  nextRunAt: Date | undefined,
): string {
  const targetText =
    message.targetUsers.length === 0
      ? "no targets"
      : message.targetUsers.map((target) => `@${target.username}`).join(", ");

  if (nextRunAt === undefined) {
    return `Sent scheduled message ${message.id} to #${message.channelName} (${targetText}); schedule complete.`;
  }

  return `Sent scheduled message ${message.id} to #${message.channelName} (${targetText}); next run is ${nextRunAt.toISOString()}.`;
}
