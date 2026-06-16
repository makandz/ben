import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Logger } from "../logger.js";
import type { ScheduleRepeat } from "./scheduleTime.js";

export interface ScheduledMessageTarget {
  userId: string;
  username: string;
}

export interface ScheduledMessage {
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
}

export interface CreateScheduledMessageInput {
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
}

interface ScheduledMessagesData {
  version: number;
  messages: ScheduledMessage[];
}

export class ScheduledMessageStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  async add(input: CreateScheduledMessageInput, now = new Date()): Promise<ScheduledMessage> {
    const data = await this.read();
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

    data.messages.push(message);
    await this.write(data);

    return message;
  }

  async listDue(now = new Date()): Promise<ScheduledMessage[]> {
    const data = await this.read();

    return data.messages.filter(
      (message) => message.enabled && Date.parse(message.nextRunAt) <= now.getTime(),
    );
  }

  async markSent(id: string, nextRunAt: Date | undefined, now = new Date()): Promise<void> {
    const data = await this.read();
    const message = data.messages.find((item) => item.id === id);

    if (message === undefined) {
      return;
    }

    message.lastRunAt = now.toISOString();
    message.updatedAt = now.toISOString();
    message.failureCount = 0;

    if (nextRunAt === undefined) {
      message.enabled = false;
    } else {
      message.nextRunAt = nextRunAt.toISOString();
    }

    await this.write(data);
  }

  async reschedule(id: string, nextRunAt: Date, now = new Date()): Promise<void> {
    const data = await this.read();
    const message = data.messages.find((item) => item.id === id);

    if (message === undefined) {
      return;
    }

    message.nextRunAt = nextRunAt.toISOString();
    message.updatedAt = now.toISOString();
    await this.write(data);
  }

  async markFailed(id: string, now = new Date()): Promise<number> {
    const data = await this.read();
    const message = data.messages.find((item) => item.id === id);

    if (message === undefined) {
      return 0;
    }

    message.failureCount = (message.failureCount ?? 0) + 1;
    message.updatedAt = now.toISOString();
    await this.write(data);

    return message.failureCount;
  }

  private async read(): Promise<ScheduledMessagesData> {
    let raw: string;

    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, messages: [] };
      }

      throw error;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${this.filePath} must contain valid JSON.`);
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`${this.filePath} must contain a JSON object.`);
    }

    const messages = (parsed as { messages?: unknown }).messages;

    if (!Array.isArray(messages)) {
      return { version: 1, messages: [] };
    }

    return {
      version: 1,
      messages: messages
        .map((message) => parseScheduledMessage(message, this.logger))
        .filter((message): message is ScheduledMessage => message !== undefined),
    };
  }

  private async write(data: ScheduledMessagesData): Promise<void> {
    const dir = path.dirname(this.filePath);

    await mkdir(dir, { recursive: true });

    const tempPath = path.join(
      dir,
      `.${path.basename(this.filePath)}.${String(process.pid)}.${String(Date.now())}.tmp`,
    );

    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

function parseScheduledMessage(
  value: unknown,
  logger: Logger,
): ScheduledMessage | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    logger.warn("scheduled_messages.invalid_entry_ignored");
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const targetUsers = parseTargetUsers(record.targetUsers);

  if (
    typeof record.id !== "string" ||
    typeof record.channelId !== "string" ||
    typeof record.channelName !== "string" ||
    typeof record.message !== "string" ||
    targetUsers === undefined ||
    typeof record.runDate !== "string" ||
    typeof record.runTime !== "string" ||
    !isScheduleRepeat(record.repeat) ||
    typeof record.nextRunAt !== "string" ||
    typeof record.enabled !== "boolean" ||
    typeof record.createdByUserId !== "string" ||
    typeof record.createdByUsername !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    logger.warn("scheduled_messages.invalid_entry_ignored");
    return undefined;
  }

  const message: ScheduledMessage = {
    id: record.id,
    channelId: record.channelId,
    channelName: record.channelName,
    message: record.message,
    targetUsers,
    runDate: record.runDate,
    runTime: record.runTime,
    repeat: record.repeat,
    nextRunAt: record.nextRunAt,
    enabled: record.enabled,
    createdByUserId: record.createdByUserId,
    createdByUsername: record.createdByUsername,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  if (typeof record.lastRunAt === "string") {
    message.lastRunAt = record.lastRunAt;
  }

  if (typeof record.failureCount === "number") {
    message.failureCount = record.failureCount;
  }

  return message;
}

function parseTargetUsers(value: unknown): ScheduledMessageTarget[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const targets: ScheduledMessageTarget[] = [];

  for (const item of value) {
    if (item === null || Array.isArray(item) || typeof item !== "object") {
      return undefined;
    }

    const record = item as Record<string, unknown>;

    if (typeof record.userId !== "string" || typeof record.username !== "string") {
      return undefined;
    }

    targets.push({
      userId: record.userId,
      username: record.username,
    });
  }

  return targets;
}

function isScheduleRepeat(value: unknown): value is ScheduleRepeat {
  return value === "none" || value === "daily" || value === "weekly";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
