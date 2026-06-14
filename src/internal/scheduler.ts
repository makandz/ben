import { ActivityType, type Client } from "discord.js";

import type { AppConfig } from "../config.js";
import { escapeBroadcastMentions } from "../discord/mentions.js";
import type { Logger } from "../logger.js";
import type { InternalActionRunner } from "./actions.js";
import { InternalStateStore, isFreshStatusState } from "./stateStore.js";
import type { InternalStatus } from "./statusSchema.js";

type SendLogMessage = (text: string) => Promise<void>;

export class InternalActionScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private currentStatus: InternalStatus | undefined;
  private presenceStatus: "idle" | "online" = "idle";

  constructor(
    private readonly config: AppConfig,
    private readonly client: Client,
    private readonly runner: InternalActionRunner,
    private readonly stateStore: InternalStateStore,
    private readonly sendLogMessage: SendLogMessage,
    private readonly logger: Logger,
  ) {}

  start(): void {
    void this.startStatusSchedule();

    this.logger.info("internal.scheduler_started", {
      intervalMs: this.config.internalActionIntervalMs,
    });
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getCurrentActivityStatus(): string | undefined {
    if (this.currentStatus === undefined) {
      return undefined;
    }

    return formatActivityStatus(this.currentStatus);
  }

  setAwakePresence(awake: boolean): void {
    this.presenceStatus = awake ? "online" : "idle";

    if (this.currentStatus === undefined) {
      this.client.user?.setPresence({ status: this.presenceStatus });
      return;
    }

    this.applyStatus(this.currentStatus);
  }

  private async startStatusSchedule(): Promise<void> {
    const nextDelayMs = await this.applyFreshSavedStatusOrRun();

    this.timer = setTimeout(() => {
      void this.runStatusActionAndReschedule("interval");
    }, nextDelayMs);
  }

  private async applyFreshSavedStatusOrRun(): Promise<number> {
    const saved = await this.stateStore.readCurrentStatus();
    const now = new Date();

    if (saved !== undefined && isFreshStatusState(saved, this.config.internalActionIntervalMs, now)) {
      this.applyStatus(saved.status);

      const setAtMs = Date.parse(saved.setAt);
      const nextDelayMs = Math.max(this.config.internalActionIntervalMs - (now.getTime() - setAtMs), 0);

      this.logger.info("internal.status_reused", {
        setAt: saved.setAt,
        nextDelayMs,
        ...saved.status,
      });

      return nextDelayMs;
    }

    await this.runStatusAction("startup");
    return this.config.internalActionIntervalMs;
  }

  private async runStatusActionAndReschedule(reason: string): Promise<void> {
    await this.runStatusAction(reason);

    this.timer = setTimeout(() => {
      void this.runStatusActionAndReschedule("interval");
    }, this.config.internalActionIntervalMs);
  }

  private async runStatusAction(reason: string): Promise<void> {
    if (this.running) {
      this.logger.debug("internal.skipped_running", { action: "status", reason });
      return;
    }

    this.running = true;

    try {
      const result = await this.runner.runStatusAction();

      if (result.type === "status") {
        const statusChanged = !areStatusesEqual(this.currentStatus, result.status);

        this.applyStatus(result.status);
        await this.stateStore.writeCurrentStatus(result.status);

        if (!statusChanged) {
          this.logger.info("internal.status_unchanged", { reason, ...result.status });
          return;
        }

        await this.writeLogLine("Thinking of a new activity status..");
        if (result.reasoningSummary !== undefined) {
          await this.writeThoughtBubble(result.reasoningSummary);
        }
        await this.writeStatusSetLine(result.status);
        this.logger.info("internal.status_applied", { reason, ...result.status });
        return;
      }

      if (result.type === "budget_exceeded") {
        this.logger.info("internal.status_budget_exceeded", {
          reason,
          day: result.day,
          costUsd: result.costUsd,
          budgetUsd: result.budgetUsd,
        });
        return;
      }

      this.logger.warn("internal.status_failed", { reason, error: String(result.error) });
    } finally {
      this.running = false;
    }
  }

  private applyStatus(status: InternalStatus): void {
    this.currentStatus = status;
    this.client.user?.setPresence({
      status: this.presenceStatus,
      activities: [
        {
          name: "custom",
          state: `${status.emoji} ${status.text}`,
          type: ActivityType.Custom,
        },
      ],
    });
  }

  private async writeLogLine(text: string): Promise<void> {
    if (this.config.discordLogChannelId === undefined) {
      this.logger.debug("internal.log_skipped", { reason: "missing_channel" });
      return;
    }

    await this.sendLogMessage(escapeBroadcastMentions(text)).catch((error: unknown) => {
      this.logger.warn("internal.log_send_failed", { error: String(error) });
    });
  }

  private async writeThoughtBubble(text: string): Promise<void> {
    const visibleText = stripBoldMarkdown(text);

    if (visibleText.length === 0) {
      return;
    }

    await this.writeLogLine(`> 💭 ${visibleText}`);
  }

  private async writeStatusSetLine(status: InternalStatus): Promise<void> {
    await this.writeLogLine(`Setting status to "${formatActivityStatus(status)}"`);
  }
}

function formatActivityStatus(status: InternalStatus): string {
  return `${status.emoji} ${status.text}`.replace(/"/g, "'");
}

function areStatusesEqual(
  left: InternalStatus | undefined,
  right: InternalStatus,
): boolean {
  return left?.emoji === right.emoji && left.text === right.text;
}

function stripBoldMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1");
}
