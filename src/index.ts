import "dotenv/config";

import { Events, type GuildMember } from "discord.js";

import { BotSession } from "./bot/BotSession.js";
import { loadConfig } from "./config.js";
import { createDiscordClient } from "./discord/client.js";
import { isPing, toHumanMessage } from "./discord/message.js";
import { escapeBroadcastMentions, UserMentionDirectory } from "./discord/mentions.js";
import { handleUsageCommand, registerUsageCommand } from "./discord/usageCommand.js";
import { Logger } from "./logger.js";
import { OpenAIResponder } from "./openai/responder.js";
import { OpenAIUsageStore } from "./openai/usageStore.js";

const config = loadConfig();
const logger = new Logger(config.logLevel);
const client = createDiscordClient();
const usageStore = new OpenAIUsageStore(config, logger);
const responder = new OpenAIResponder(config, logger, usageStore);
const mentionDirectory = new UserMentionDirectory();

const session = new BotSession(
  config,
  responder,
  async (channelId, text) => {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isSendable()) {
      throw new Error("Response channel is not sendable.");
    }

    const safeText = escapeBroadcastMentions(text);
    await resolveUnknownMentions(channel, safeText);
    await channel.send({
      content: escapeBroadcastMentions(mentionDirectory.convertUsernamesToMentions(safeText)),
      allowedMentions: {
        parse: ["users"],
      },
    });
  },
  async (channelId) => {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isSendable()) {
      throw new Error("Typing channel is not sendable.");
    }

    await channel.sendTyping();
  },
  async (channelId, messageId, emoji) => {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isTextBased() || !("messages" in channel)) {
      throw new Error("Reaction channel is not text-based.");
    }

    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
  },
  logger,
);

client.once(Events.ClientReady, (readyClient) => {
  mentionDirectory.rememberUser(readyClient.user);
  logger.info("discord.ready", { user: readyClient.user.tag });
  void registerUsageCommand(readyClient, logger).catch((error: unknown) => {
    logger.warn("discord.command_registration_failed", { error: String(error) });
  });
});

client.on(Events.MessageCreate, (message) => {
  const humanMessage = toHumanMessage(message, client, mentionDirectory);

  if (humanMessage === null) {
    return;
  }

  session.handleMessage(humanMessage, isPing(message, client));
});

client.on(Events.TypingStart, (typing) => {
  const user = typing.user;

  if (user.bot || user.id === client.user?.id || user.username === null) {
    return;
  }

  mentionDirectory.rememberUser(user);
  session.handleTyping(typing.channel.id, user.username);
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "usage") {
    return;
  }

  void handleUsageCommand(interaction, usageStore, logger);
});

client.on(Events.Error, (error) => {
  logger.error("discord.error", { error: String(error) });
});

await client.login(config.discordToken);

async function resolveUnknownMentions(
  channel: Awaited<ReturnType<typeof client.channels.fetch>>,
  text: string,
): Promise<void> {
  if (channel === null || !("guild" in channel)) {
    return;
  }

  const usernames = mentionDirectory.findUnresolvedMentionUsernames(text);

  for (const username of usernames) {
    try {
      const members = await channel.guild.members.search({
        query: username,
        limit: 10,
        cache: true,
      });
      const member = findMatchingMember(username, [...members.values()]);

      if (member === undefined) {
        logger.debug("discord.mention_user_not_found", { username });
        continue;
      }

      mentionDirectory.rememberUser(member.user);
      mentionDirectory.rememberUsername(username, member.id);
    } catch (error) {
      logger.warn("discord.mention_lookup_failed", { username, error: String(error) });
    }
  }
}

function findMatchingMember(
  username: string,
  members: readonly GuildMember[],
): GuildMember | undefined {
  const normalizedUsername = username.toLowerCase();
  const exactMatch = members.find(
    (member) =>
      member.user.username.toLowerCase() === normalizedUsername ||
      member.displayName.toLowerCase() === normalizedUsername,
  );

  if (exactMatch !== undefined) {
    return exactMatch;
  }

  return members.length === 1 ? members[0] : undefined;
}
