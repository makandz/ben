import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import { config } from "./config.js";
import { generateReply } from "./gemini.js";
import { addMessage } from "./messageHistory.js";
import { isGuildTextChannel } from "./utils/discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMembers,
  ],
});

/**
 * Handle the client being ready.
 */
client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

let idleTimer: NodeJS.Timeout | undefined;

/**
 * Schedule an idle reply for the given channel. Generates a reply after 5
 * seconds of inactivity and sends it.
 * @param channel - The channel to send the reply to.
 */
const scheduleIdleReply = (channel: TextChannel) => {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  idleTimer = setTimeout(async () => {
    idleTimer = undefined;
    const reply = await generateReply(channel.name);
    addMessage("Ben", reply);
    await channel.send(reply);
  }, 5000);
};

/**
 * Handle a message create event.
 * @param message - The message that was created.
 */
client.on("messageCreate", async (message) => {
  const channel = message.channel;

  if (
    message.author.bot ||
    channel.id !== config.targetChannelId ||
    !isGuildTextChannel(channel)
  ) {
    return;
  }

  addMessage(message.author.username, message.content);
  scheduleIdleReply(channel);
});

/**
 * Handle a typing start event.
 * @param typing - The typing event.
 */
client.on("typingStart", (typing) => {
  const channel = typing.channel;

  if (
    typing.user?.bot ||
    !channel ||
    channel.id !== config.targetChannelId ||
    !isGuildTextChannel(channel)
  ) {
    return;
  }

  scheduleIdleReply(channel);
});

client.login(config.discordToken);
