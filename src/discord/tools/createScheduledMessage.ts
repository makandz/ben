import type { ChatTransport } from "../../app/ChatTransport.js";
import type { Logger } from "../../logger.js";
import {
  localScheduleToDate,
  type ScheduleRepeat,
} from "../../scheduling/scheduleTime.js";
import { SCHEDULE_TIME_ZONE } from "../../scheduling/ScheduledMessageScheduler.js";
import type {
  ScheduledMessage,
  ScheduledMessageStore,
  ScheduledMessageTarget,
} from "../../storage/ScheduledMessageStore.js";
import type { Tool, ToolResult } from "../../tools/Tool.js";
import {
  ChannelMentionDirectory,
  findMatchingChannel,
  findMatchingMember,
  UserMentionDirectory,
} from "../DiscordDirectory.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { escapeBroadcastMentions } from "../mentions.js";

export type ScheduledMessageCreator = {
  userId: string;
  username: string;
};

export type CreateScheduledMessageToolDependencies = {
  gateway: DiscordGateway;
  users: UserMentionDirectory;
  channels: ChannelMentionDirectory;
  store: Pick<ScheduledMessageStore, "add">;
  status: Pick<ChatTransport, "logStatus">;
  getActiveChannelId(): string | undefined;
  getCreator(): ScheduledMessageCreator | undefined;
  logger: Pick<Logger, "warn">;
  timeZone?: string;
  now?: () => Date;
};

/**
 * Creates the Discord-backed, non-terminal scheduled-message capability tool.
 *
 * @param dependencies - Discord lookup, persistence, active-session, time, and logging capabilities.
 * @returns A tool that validates and stores future one-time or recurring messages.
 */
export function createScheduledMessageTool(
  dependencies: CreateScheduledMessageToolDependencies,
): Tool {
  return {
    definition: {
      name: "create_scheduled_message",
      description:
        "Schedule Ben to ping verified users with a message at a future bot-local time, then continue.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message: { type: "string", minLength: 1, maxLength: 1_000 },
          target_usernames: { type: "array", items: { type: "string" }, minItems: 1 },
          channel: { type: ["string", "null"] },
          run_date: { type: "string" },
          run_time: { type: "string" },
          repeat: { type: "string", enum: ["none", "daily", "weekly"] },
        },
        required: ["message", "target_usernames", "channel", "run_date", "run_time", "repeat"],
      },
    },
    async execute(call) {
      return executeSchedule(dependencies, parseArguments(call.arguments));
    },
  };
}

/** Validates, resolves, and persists one schedule request. */
async function executeSchedule(
  dependencies: CreateScheduledMessageToolDependencies,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const message = sanitizeText(input.message);
  const targetUsernames = parseTargetUsernames(input.target_usernames);
  const channelName = sanitizeChannelName(input.channel);
  const runDate = typeof input.run_date === "string" ? input.run_date.trim() : "";
  const runTime = typeof input.run_time === "string" ? input.run_time.trim() : "";
  const repeat = parseRepeat(input.repeat);
  const activeChannelId = dependencies.getActiveChannelId();
  const creator = dependencies.getCreator();
  const fail = async (error: string): Promise<ToolResult> => {
    await sendCreationStatus(
      dependencies,
      activeChannelId,
      `> ⚠️ Failed to schedule message: ${error}`,
    );
    return failure(error);
  };

  if (message.length === 0 || message.length > 1_000) {
    return fail("message must be 1-1000 characters");
  }
  if (targetUsernames.length === 0) return fail("at least one real user must be targeted");
  if (repeat === undefined) return fail("repeat must be none, daily, or weekly");
  if (activeChannelId === undefined) return fail("no active Discord channel");
  if (creator === undefined || creator.userId.trim().length === 0 || creator.username.trim().length === 0) {
    return fail("missing creator");
  }

  let firstRunAt: Date;
  try {
    firstRunAt = localScheduleToDate({
      runDate,
      runTime,
      timeZone: dependencies.timeZone ?? SCHEDULE_TIME_ZONE,
    });
  } catch (error) {
    return fail(String(error));
  }
  if (firstRunAt.getTime() <= (dependencies.now ?? (() => new Date()))().getTime()) {
    return fail("run_date and run_time must be in the future");
  }

  try {
    const activeChannel = await dependencies.gateway.fetchChannel(activeChannelId);
    if (activeChannel?.guildId === undefined) return await fail("active channel is not in a server");
    const targetChannel = channelName.length === 0
      ? activeChannel
      : findMatchingChannel(
        channelName,
        await dependencies.gateway.fetchGuildChannels(activeChannel.guildId),
      );
    if (targetChannel === undefined || targetChannel.sendable === false) {
      return await fail("target channel is not sendable or could not be found");
    }
    dependencies.channels.rememberChannel(targetChannel);

    const targetUsers = await resolveTargets(
      dependencies.gateway,
      dependencies.users,
      activeChannel.guildId,
      targetUsernames,
    );
    if (targetUsers.length === 0) return await fail("at least one real user must be targeted");

    const scheduled = await dependencies.store.add({
      channelId: targetChannel.id,
      channelName: targetChannel.name ?? channelName,
      message,
      targetUsers,
      runDate,
      runTime,
      repeat,
      nextRunAt: firstRunAt,
      createdByUserId: creator.userId,
      createdByUsername: creator.username,
    });
    await sendCreationStatus(dependencies, activeChannelId, formatCreatedStatus(scheduled));
    await dependencies.status.logStatus(
      `Created scheduled message ${scheduled.id} for #${scheduled.channelName} at ${scheduled.nextRunAt} (${scheduled.repeat}).`,
    ).catch((error: unknown) => {
      dependencies.logger.warn("scheduled_messages.create_log_failed", { error: String(error) });
    });
    return {
      type: "continue",
      result: {
        ok: true,
        id: scheduled.id,
        nextRunAt: scheduled.nextRunAt,
        repeat: scheduled.repeat,
        channel: scheduled.channelName,
        targetUsernames: scheduled.targetUsers.map((target) => target.username),
      },
    };
  } catch (error) {
    return fail(String(error));
  }
}

/** Resolves every requested username to one unique, non-bot server member. */
async function resolveTargets(
  gateway: DiscordGateway,
  users: UserMentionDirectory,
  guildId: string,
  usernames: readonly string[],
): Promise<ScheduledMessageTarget[]> {
  const targets: ScheduledMessageTarget[] = [];
  const seenUserIds = new Set<string>();
  for (const username of usernames) {
    const normalized = username.toLowerCase();
    if (normalized === "everyone" || normalized === "here") {
      throw new Error("target usernames must be real Discord users");
    }
    const candidates = (await gateway.searchGuildMembers(guildId, username))
      .filter((member) => !member.bot);
    const member = findMatchingMember(username, candidates);
    if (member === undefined) {
      throw new Error(`no matching server member found for "${username}"`);
    }
    if (seenUserIds.has(member.id)) continue;

    users.rememberUser(member);
    users.rememberUsername(username, member.id);
    seenUserIds.add(member.id);
    targets.push({ userId: member.id, username: member.username });
  }
  return targets;
}

/** Sends a user-visible creation status while containing status failures. */
async function sendCreationStatus(
  dependencies: Pick<CreateScheduledMessageToolDependencies, "gateway" | "logger">,
  channelId: string | undefined,
  text: string,
): Promise<void> {
  if (channelId === undefined) {
    dependencies.logger.warn("discord.schedule_status_failed", { error: "Missing channel ID" });
    return;
  }
  await dependencies.gateway.sendMessage(channelId, escapeBroadcastMentions(text), {
    allowUserMentions: false,
  }).catch((error: unknown) => {
    dependencies.logger.warn("discord.schedule_status_failed", { error: String(error) });
  });
}

/** Formats the successful status displayed in the active conversation. */
function formatCreatedStatus(message: ScheduledMessage): string {
  const targets = message.targetUsers.map((target) => `@${target.username}`).join(", ");
  const repeat = message.repeat === "none"
    ? "once"
    : `every ${message.repeat === "daily" ? "day" : "week"}`;
  return `> ⏰ Scheduled ${repeat} for ${message.runDate} at ${message.runTime} to ${targets}`;
}

/** Creates a continuing model-readable failure. */
function failure(error: string): ToolResult {
  return { type: "continue", result: { ok: false, error } };
}

/** Narrows unknown model arguments to a record. */
function parseArguments(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Reads, trims, and collapses whitespace in message text. */
function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/** Normalizes an optional channel name for exact lookup. */
function sanitizeChannelName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^#+/, "").trim().toLowerCase() : "";
}

/** Parses unique non-empty usernames in encounter order. */
function parseTargetUsernames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const usernames = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const username = item.trim().replace(/^@+/, "").replace(/\s+/g, " ");
    if (username.length > 0) usernames.add(username);
  }
  return [...usernames];
}

/** Narrows a model recurrence argument without silently changing invalid input. */
function parseRepeat(value: unknown): ScheduleRepeat | undefined {
  return value === "none" || value === "daily" || value === "weekly" ? value : undefined;
}
