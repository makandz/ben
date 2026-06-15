import "dotenv/config";

import { Events, type Guild, type GuildMember, type NonThreadGuildBasedChannel } from "discord.js";

import { BotSession } from "./bot/BotSession.js";
import { ConversationSummaryStore } from "./bot/conversationSummaryStore.js";
import { KnownPeopleStore } from "./bot/knownPeopleStore.js";
import { loadConfig } from "./config.js";
import { createDiscordClient } from "./discord/client.js";
import { isPing, toHumanMessage } from "./discord/message.js";
import {
  ChannelMentionDirectory,
  escapeBroadcastMentions,
  UserMentionDirectory,
} from "./discord/mentions.js";
import { handleUsageCommand, registerUsageCommand } from "./discord/usageCommand.js";
import { InternalActionRunner } from "./internal/actions.js";
import { InternalActionScheduler } from "./internal/scheduler.js";
import { InternalStateStore } from "./internal/stateStore.js";
import { Logger } from "./logger.js";
import { OpenAIResponder } from "./openai/responder.js";
import type {
  RememberPersonToolInput,
  RememberPersonToolResult,
  SendChannelMessageToolInput,
  SendChannelMessageToolResult,
} from "./openai/types.js";
import { OpenAIUsageStore } from "./openai/usageStore.js";

const config = loadConfig();
const logger = new Logger(config.logLevel);
const client = createDiscordClient();
const usageStore = new OpenAIUsageStore(config, logger);
const conversationSummaryStore = new ConversationSummaryStore(
  config.conversationSummaryPath,
  logger,
);
const knownPeopleStore = new KnownPeopleStore(config.knownPeoplePath, logger);
const responder = new OpenAIResponder(config, logger, usageStore);
const internalActionRunner = new InternalActionRunner(config, logger, usageStore);
const internalStateStore = new InternalStateStore(config.internalStatePath, logger);
const mentionDirectory = new UserMentionDirectory();
const channelDirectory = new ChannelMentionDirectory();
const sendLogMessage = async (text: string): Promise<boolean> => {
  if (config.discordLogChannelId === undefined) {
    return false;
  }

  const channel = await client.channels.fetch(config.discordLogChannelId);

  if (!channel?.isSendable()) {
    throw new Error("Log channel is not sendable.");
  }

  await channel.send({
    content: text,
    allowedMentions: {
      parse: [],
    },
  });

  return true;
};
const internalActionScheduler = new InternalActionScheduler(
  config,
  client,
  internalActionRunner,
  internalStateStore,
  async (text) => {
    await sendLogMessage(text);
  },
  logger,
);

const session = new BotSession(
  config,
  responder,
  sendDiscordMessage,
  async (text, fallbackChannelId) => {
    const sentToLog = await sendLogMessage(text);

    if (sentToLog || fallbackChannelId === undefined) {
      return;
    }

    const channel = await client.channels.fetch(fallbackChannelId);

    if (!channel?.isSendable()) {
      throw new Error("Status fallback channel is not sendable.");
    }

    await channel.send({
      content: text,
      allowedMentions: {
        parse: [],
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
  () => internalActionScheduler.getCurrentActivityStatus(),
  (awake) => {
    internalActionScheduler.setAwakePresence(awake);
  },
  conversationSummaryStore,
  knownPeopleStore,
  rememberPersonInChannel,
  sendMessageToNamedChannel,
  logger,
);

client.once(Events.ClientReady, (readyClient) => {
  mentionDirectory.rememberUser(readyClient.user);
  logger.info("discord.ready", { user: readyClient.user.tag });
  internalActionScheduler.setAwakePresence(false);
  internalActionScheduler.start();
  void registerUsageCommand(readyClient, logger).catch((error: unknown) => {
    logger.warn("discord.command_registration_failed", { error: String(error) });
  });
});

client.on(Events.MessageCreate, (message) => {
  const humanMessage = toHumanMessage(message, client, mentionDirectory, channelDirectory);

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
  channelDirectory.rememberChannel(typing.channel);
  session.handleTyping(typing.channel.id, user.id, user.username);
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

process.once("SIGINT", () => {
  internalActionScheduler.stop();
  void client.destroy();
});

process.once("SIGTERM", () => {
  internalActionScheduler.stop();
  void client.destroy();
});

await client.login(config.discordToken);

async function sendDiscordMessage(channelId: string, text: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);

  if (!channel?.isSendable()) {
    throw new Error("Response channel is not sendable.");
  }

  channelDirectory.rememberChannel(channel);

  const safeText = escapeBroadcastMentions(text);
  await resolveUnknownMentions(channel, safeText);
  await resolveUnknownChannels(channel, safeText);
  const contentWithChannelMentions = channelDirectory.convertNamesToMentions(safeText);
  const contentWithUserMentions = mentionDirectory.convertUsernamesToMentions(
    contentWithChannelMentions,
  );

  await channel.send({
    content: escapeBroadcastMentions(contentWithUserMentions),
    allowedMentions: {
      parse: ["users"],
    },
  });
}

async function sendMessageToNamedChannel(
  input: SendChannelMessageToolInput,
  activeChannelId: string | undefined,
): Promise<SendChannelMessageToolResult> {
  const channelName = sanitizeChannelName(input.channel);
  const fail = async (error: string): Promise<SendChannelMessageToolResult> => {
    await sendChannelMessageFailureStatus(channelName, error, activeChannelId);
    return { ok: false, error };
  };

  if (channelName.length === 0) {
    return fail("channel must be non-empty");
  }

  if (input.text.trim().length === 0) {
    return fail("message text must be non-empty");
  }

  if (activeChannelId === undefined) {
    return fail("no active Discord channel");
  }

  try {
    const activeChannel = await client.channels.fetch(activeChannelId);

    if (activeChannel === null || !("guild" in activeChannel)) {
      return await fail("active channel is not in a server");
    }

    const targetChannel = await findMatchingGuildChannel(activeChannel.guild, channelName);

    if (targetChannel === undefined) {
      return await fail("no matching server channel found");
    }

    channelDirectory.rememberChannel(targetChannel);
    await sendDiscordMessage(targetChannel.id, input.text);

    return {
      ok: true,
      channel: targetChannel.name,
      channelId: targetChannel.id,
    };
  } catch (error) {
    const message = String(error);
    await sendChannelMessageFailureStatus(channelName, message, activeChannelId);
    return { ok: false, error: message };
  }
}

async function sendChannelMessageFailureStatus(
  channelName: string,
  error: string,
  activeChannelId: string | undefined,
): Promise<void> {
  if (activeChannelId === undefined) {
    logger.warn("discord.cross_channel_send_status_failed", {
      error: "Cannot send cross-channel failure status without a channel ID.",
    });
    return;
  }

  await sendRememberStatus(
    `> ⚠️ Failed to send message to #${channelName}: ${error}`,
    activeChannelId,
  );
}

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

async function resolveUnknownChannels(
  channel: Awaited<ReturnType<typeof client.channels.fetch>>,
  text: string,
): Promise<void> {
  if (channel === null || !("guild" in channel)) {
    return;
  }

  const channelNames = channelDirectory.findUnresolvedChannelNames(text);

  for (const channelName of channelNames) {
    try {
      const targetChannel = await findMatchingGuildChannel(channel.guild, channelName);

      if (targetChannel === undefined) {
        logger.debug("discord.channel_not_found", { channelName });
        continue;
      }

      channelDirectory.rememberChannel(targetChannel);
    } catch (error) {
      logger.warn("discord.channel_lookup_failed", { channelName, error: String(error) });
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

async function findMatchingGuildChannel(
  guild: Guild,
  channelName: string,
): Promise<NonThreadGuildBasedChannel | undefined> {
  const normalizedChannelName = sanitizeChannelName(channelName).toLowerCase();
  const channels = await guild.channels.fetch();
  const matches = [...channels.values()].filter(
    (channel): channel is NonThreadGuildBasedChannel =>
      channel !== null &&
      typeof channel.name === "string" &&
      channel.name.toLowerCase() === normalizedChannelName,
  );

  if (matches.length === 1) {
    return matches[0];
  }

  return undefined;
}

async function rememberPersonInChannel(
  input: RememberPersonToolInput,
  channelId: string | undefined,
): Promise<RememberPersonToolResult> {
  const username = sanitizeRememberText(input.username).replace(/^@+/, "");
  const name = sanitizeRememberText(input.name);
  const fail = async (error: string): Promise<RememberPersonToolResult> => {
    await sendRememberStatus(
      `> ⚠️ Failed to remember "${username}" as "${name}": ${error}`,
      channelId,
    );
    return { ok: false, error };
  };

  if (username.length === 0 || name.length === 0) {
    return fail("username and name must be non-empty");
  }

  if (channelId === undefined) {
    return fail("no active Discord channel");
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (channel === null || !("guild" in channel)) {
      return await fail("active channel is not in a server");
    }

    const members = await channel.guild.members.search({
      query: username,
      limit: 10,
      cache: true,
    });
    const member = findMatchingMember(username, [...members.values()]);

    if (member === undefined) {
      return await fail("no matching server member found");
    }

    mentionDirectory.rememberUser(member.user);
    mentionDirectory.rememberUsername(username, member.id);

    const result = await knownPeopleStore.remember({
      userId: member.id,
      username: member.user.username,
      name,
    });

    if (!result.ok) {
      await sendRememberStatus(
        `> ⚠️ Failed to remember "${username}" as "${name}": ${result.error}`,
        channelId,
      );
      return result;
    }

    await sendRememberStatus(
      `> 🧠 Remembering that "${result.username}" is "${result.name}"`,
      channelId,
    );
    return result;
  } catch (error) {
    const message = String(error);
    await sendRememberStatus(
      `> ⚠️ Failed to remember "${username}" as "${name}": ${message}`,
      channelId,
    );
    return { ok: false, error: message };
  }
}

async function sendRememberStatus(
  text: string,
  channelId: string | undefined,
): Promise<void> {
  try {
    if (channelId === undefined) {
      logger.warn("discord.remember_status_failed", {
        error: "Cannot send remember status without a channel ID.",
      });
      return;
    }

    const channel = await client.channels.fetch(channelId);

    if (!channel?.isSendable()) {
      throw new Error("Remember status channel is not sendable.");
    }

    await channel.send({
      content: escapeBroadcastMentions(text),
      allowedMentions: {
        parse: [],
      },
    });
  } catch (error) {
    logger.warn("discord.remember_status_failed", { error: String(error) });
  }
}

function sanitizeRememberText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function sanitizeChannelName(channelName: string): string {
  return channelName.trim().replace(/^#+/, "").trim().toLowerCase();
}
