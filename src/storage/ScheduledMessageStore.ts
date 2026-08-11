import { randomUUID } from "node:crypto";

import type { Logger } from "../logger.js";
import type { ScheduleRepeat } from "../scheduling/scheduleTime.js";
import { isRecord, readJsonFile, UpdateQueue, writeJsonFileAtomic } from "./JsonFile.js";

export type ScheduledMessageTarget = {
  userId: string;
  username: string;
};

export type ScheduledMessage = {
  id: string;
  channelId: string;
  channelName: string;
  message: string;
  targetUsers: ScheduledMessageTarget[];
  runDate: string;
  runTime: string;
  repeat: ScheduleRepeat;
  nextRunAt: string;
  enabled: boolean;
  createdByUserId: string;
  createdByUsername: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  failureCount?: number;
};

export type CreateScheduledMessageInput = {
  channelId: string;
  channelName: string;
  message: string;
  targetUsers: ScheduledMessageTarget[];
  runDate: string;
  runTime: string;
  repeat: ScheduleRepeat;
  nextRunAt: Date;
  createdByUserId: string;
  createdByUsername: string;
};

type ScheduledMessagesData = {
  version: number;
  messages: ScheduledMessage[];
};

/** Persists scheduled messages in the production-compatible JSON shape. */
export class ScheduledMessageStore {
  private readonly updates = new UpdateQueue();

  /**
   * @param filePath - JSON file using the production-compatible scheduled-message shape.
   * @param logger - Logger used when malformed individual entries are ignored.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /**
   * Adds and atomically persists one enabled schedule.
   *
   * @param input - Validated destination, target, recurrence, and creator data.
   * @param now - Creation instant, replaceable for deterministic tests.
   * @returns The stored scheduled message with its generated identifier.
   */
  async add(input: CreateScheduledMessageInput, now = new Date()): Promise<ScheduledMessage> {
    const timestamp = now.toISOString();
    const message: ScheduledMessage = {
      id: `sm_${randomUUID().slice(0, 8)}`,
      channelId: input.channelId,
      channelName: input.channelName,
      message: input.message,
      targetUsers: input.targetUsers,
      runDate: input.runDate,
      runTime: input.runTime,
      repeat: input.repeat,
      nextRunAt: input.nextRunAt.toISOString(),
      enabled: true,
      createdByUserId: input.createdByUserId,
      createdByUsername: input.createdByUsername,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.updates.run(async () => {
      const data = await this.read();
      data.messages.push(message);
      await writeJsonFileAtomic(this.filePath, data);
      return message;
    });
  }

  /**
   * @param now - Inclusive due-time boundary.
   * @returns Enabled schedules whose next run is at or before the boundary.
   */
  async listDue(now = new Date()): Promise<ScheduledMessage[]> {
    const data = await this.read();
    return data.messages.filter(
      (message) => message.enabled && Date.parse(message.nextRunAt) <= now.getTime(),
    );
  }

  /**
   * Marks a delivery successful, completing one-time schedules or advancing recurring ones.
   *
   * @param id - Stored schedule identifier.
   * @param nextRunAt - Next recurrence, or undefined to complete the schedule.
   * @param now - Successful delivery instant.
   * @returns A promise that resolves after the update is persisted, or immediately if absent.
   */
  async markSent(id: string, nextRunAt: Date | undefined, now = new Date()): Promise<void> {
    await this.updates.run(async () => {
      const data = await this.read();
      const message = data.messages.find((item) => item.id === id);
      if (message === undefined) return;

      const timestamp = now.toISOString();
      message.lastRunAt = timestamp;
      message.updatedAt = timestamp;
      message.failureCount = 0;
      if (nextRunAt === undefined) {
        message.enabled = false;
      } else {
        message.nextRunAt = nextRunAt.toISOString();
      }
      await writeJsonFileAtomic(this.filePath, data);
    });
  }

  /**
   * Advances a schedule without treating the skipped occurrence as a delivery.
   *
   * @param id - Stored schedule identifier.
   * @param nextRunAt - First future recurrence.
   * @param now - Rescheduling instant.
   * @returns A promise that resolves after the update is persisted, or immediately if absent.
   */
  async reschedule(id: string, nextRunAt: Date, now = new Date()): Promise<void> {
    await this.updates.run(async () => {
      const data = await this.read();
      const message = data.messages.find((item) => item.id === id);
      if (message === undefined) return;

      message.nextRunAt = nextRunAt.toISOString();
      message.updatedAt = now.toISOString();
      await writeJsonFileAtomic(this.filePath, data);
    });
  }

  /**
   * Records one failed delivery while leaving the schedule enabled and due for retry.
   *
   * @param id - Stored schedule identifier.
   * @param now - Failure instant.
   * @returns The resulting failure count, or zero when the schedule no longer exists.
   */
  async markFailed(id: string, now = new Date()): Promise<number> {
    return this.updates.run(async () => {
      const data = await this.read();
      const message = data.messages.find((item) => item.id === id);
      if (message === undefined) return 0;

      message.failureCount = (message.failureCount ?? 0) + 1;
      message.updatedAt = now.toISOString();
      await writeJsonFileAtomic(this.filePath, data);
      return message.failureCount;
    });
  }

  /** Reads the compatible container and ignores only malformed individual entries. */
  private async read(): Promise<ScheduledMessagesData> {
    let parsed: unknown;
    try {
      parsed = await readJsonFile(this.filePath);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`${this.filePath} must contain valid JSON.`);
      throw error;
    }
    if (parsed === undefined) return { version: 1, messages: [] };
    if (!isRecord(parsed)) throw new Error(`${this.filePath} must contain a JSON object.`);
    if (!Array.isArray(parsed.messages)) return { version: 1, messages: [] };
    return {
      version: 1,
      messages: parsed.messages
        .map((message) => parseScheduledMessage(message, this.logger))
        .filter((message): message is ScheduledMessage => message !== undefined),
    };
  }
}

/** Parses one production-compatible scheduled message. */
function parseScheduledMessage(
  value: unknown,
  logger: Pick<Logger, "warn">,
): ScheduledMessage | undefined {
  if (!isRecord(value)) {
    logger.warn("scheduled_messages.invalid_entry_ignored");
    return undefined;
  }

  const targetUsers = parseTargetUsers(value.targetUsers);
  if (
    typeof value.id !== "string" ||
    typeof value.channelId !== "string" ||
    typeof value.channelName !== "string" ||
    typeof value.message !== "string" ||
    targetUsers === undefined ||
    typeof value.runDate !== "string" ||
    typeof value.runTime !== "string" ||
    !isScheduleRepeat(value.repeat) ||
    typeof value.nextRunAt !== "string" ||
    typeof value.enabled !== "boolean" ||
    typeof value.createdByUserId !== "string" ||
    typeof value.createdByUsername !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    logger.warn("scheduled_messages.invalid_entry_ignored");
    return undefined;
  }

  return {
    id: value.id,
    channelId: value.channelId,
    channelName: value.channelName,
    message: value.message,
    targetUsers,
    runDate: value.runDate,
    runTime: value.runTime,
    repeat: value.repeat,
    nextRunAt: value.nextRunAt,
    enabled: value.enabled,
    createdByUserId: value.createdByUserId,
    createdByUsername: value.createdByUsername,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastRunAt === "string" ? { lastRunAt: value.lastRunAt } : {}),
    ...(typeof value.failureCount === "number" ? { failureCount: value.failureCount } : {}),
  };
}

/** Parses verified target identities from persisted data. */
function parseTargetUsers(value: unknown): ScheduledMessageTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const targets: ScheduledMessageTarget[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.userId !== "string" || typeof item.username !== "string") {
      return undefined;
    }
    targets.push({ userId: item.userId, username: item.username });
  }
  return targets;
}

/** Narrows a persisted recurrence value. */
function isScheduleRepeat(value: unknown): value is ScheduleRepeat {
  return value === "none" || value === "daily" || value === "weekly";
}
