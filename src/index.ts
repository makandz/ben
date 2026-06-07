import "dotenv/config";

import { Events } from "discord.js";

import { BotSession } from "./bot/BotSession.js";
import { loadConfig } from "./config.js";
import { createDiscordClient } from "./discord/client.js";
import { isPing, toHumanMessage } from "./discord/message.js";
import { handleUsageCommand, registerUsageCommand } from "./discord/usageCommand.js";
import { Logger } from "./logger.js";
import { OpenAIResponder } from "./openai/responder.js";
import { OpenAIUsageStore } from "./openai/usageStore.js";

const config = loadConfig();
const logger = new Logger(config.logLevel);
const client = createDiscordClient();
const usageStore = new OpenAIUsageStore(config, logger);
const responder = new OpenAIResponder(config, logger, usageStore);

const session = new BotSession(
  config,
  responder,
  async (channelId, text) => {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isSendable()) {
      throw new Error("Response channel is not sendable.");
    }

    await channel.send(text);
  },
  async (channelId) => {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isSendable()) {
      throw new Error("Typing channel is not sendable.");
    }

    await channel.sendTyping();
  },
  logger,
);

client.once(Events.ClientReady, (readyClient) => {
  logger.info("discord.ready", { user: readyClient.user.tag });
  void registerUsageCommand(readyClient, logger).catch((error: unknown) => {
    logger.warn("discord.command_registration_failed", { error: String(error) });
  });
});

client.on(Events.MessageCreate, (message) => {
  const humanMessage = toHumanMessage(message, client);

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

  session.handleTyping(user.username);
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
