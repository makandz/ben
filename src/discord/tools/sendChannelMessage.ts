import type { ChatTransport } from "../../app/ChatTransport.js";
import type { Logger } from "../../logger.js";
import type { Tool, ToolResult } from "../../tools/Tool.js";
import { isSingleUnicodeEmoji } from "../../util/emoji.js";
import { ChannelMentionDirectory, findMatchingChannel } from "../DiscordDirectory.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { escapeBroadcastMentions } from "../mentions.js";

export type SendMessageToolDependencies = {
  gateway: DiscordGateway;
  transport: ChatTransport;
  channels: ChannelMentionDirectory;
  getActiveChannelId(): string | undefined;
  recordBotMessage(channelId: string, content: string): void;
  logger: Pick<Logger, "warn">;
};

/**
 * Creates `send_message` with terminal current-channel and continuing cross-channel behavior.
 *
 * @param dependencies - Discord delivery, lookup, session, and logging capabilities.
 * @returns A tool supporting current-channel replies and cross-channel messages.
 */
export function createSendMessageTool(dependencies: SendMessageToolDependencies): Tool {
  return {
    definition: {
      name: "send_message",
      description:
        "Send or react in the current channel and finish, or send to another server channel and continue.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: ["string", "null"] },
          reaction: { type: ["string", "null"] },
          channel: { type: ["string", "null"] },
        },
        required: ["text", "reaction", "channel"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const channel = sanitizeChannelName(input.channel);
      if (channel.length === 0) return executeCurrentChannel(input);
      return executeCrossChannel(dependencies, channel, sanitizeText(input.text));
    },
  };
}

/** Validates the generic terminal current-channel action. */
function executeCurrentChannel(input: Record<string, unknown>): ToolResult {
  const text = sanitizeText(input.text);
  const reaction = sanitizeText(input.reaction);
  if (reaction.length > 0 && !isSingleUnicodeEmoji(reaction)) {
    return failure("reaction must be exactly one standard Unicode emoji");
  }
  if (text.length === 0 && reaction.length === 0) return failure("text or reaction is required");

  return {
    type: "finish",
    result: { ok: true, pausedUntil: "new_human_message" },
    outcome: text.length > 0
      ? { type: "reply", text, ...(reaction.length > 0 ? { reaction } : {}) }
      : { type: "react", reaction },
  };
}

/** Resolves and delivers one continuing cross-channel action. */
async function executeCrossChannel(
  dependencies: SendMessageToolDependencies,
  channelName: string,
  text: string,
): Promise<ToolResult> {
  const activeChannelId = dependencies.getActiveChannelId();
  const fail = async (error: string): Promise<ToolResult> => {
    if (activeChannelId !== undefined) {
      await dependencies.gateway
        .sendMessage(
          activeChannelId,
          escapeBroadcastMentions(`> ⚠️ Failed to send message to #${channelName}: ${error}`),
          { allowUserMentions: false },
        )
        .catch((statusError: unknown) => {
          dependencies.logger.warn("discord.cross_channel_send_status_failed", {
            error: String(statusError),
          });
        });
    }
    return failure(error);
  };

  if (text.length === 0) return fail("message text must be non-empty");
  if (activeChannelId === undefined) return fail("no active Discord channel");

  try {
    const activeChannel = await dependencies.gateway.fetchChannel(activeChannelId);
    if (activeChannel?.guildId === undefined) return await fail("active channel is not in a server");
    const target = findMatchingChannel(
      channelName,
      await dependencies.gateway.fetchGuildChannels(activeChannel.guildId),
    );
    if (target === undefined) return await fail("no matching server channel found");

    dependencies.channels.rememberChannel(target);
    await dependencies.transport.sendMessage(target.id, text);
    dependencies.recordBotMessage(target.id, text);
    return {
      type: "continue",
      result: { ok: true, channel: target.name ?? channelName, channelId: target.id },
    };
  } catch (error) {
    return fail(String(error));
  }
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

/** Reads and trims a string argument. */
function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalizes a channel name for exact lookup. */
function sanitizeChannelName(value: unknown): string {
  return sanitizeText(value).replace(/^#+/, "").trim().toLowerCase();
}
