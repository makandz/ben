import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const targetChannelId = process.env.DISCORD_TARGET_CHANNEL_ID;
const queueSizeRaw = process.env.DISCORD_MESSAGE_QUEUE_SIZE;

type TrackedMessage = {
  userName: string;
  content: string;
  createdAt: string;
};

const messageQueue: TrackedMessage[] = [];

if (!token) {
  throw new Error("Missing DISCORD_TOKEN in environment");
}

if (!targetChannelId) {
  throw new Error("Missing DISCORD_TARGET_CHANNEL_ID in environment");
}

if (!queueSizeRaw) {
  throw new Error("Missing DISCORD_MESSAGE_QUEUE_SIZE in environment");
}

const queueSize = Number.parseInt(queueSizeRaw, 10);

if (!Number.isInteger(queueSize) || queueSize <= 0) {
  throw new Error("DISCORD_MESSAGE_QUEUE_SIZE must be a positive integer");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ben is online as ${readyClient.user.tag}`);

  const channel = await readyClient.channels.fetch(targetChannelId);

  if (!channel || !channel.isSendable()) {
    console.warn("Target channel not found or is not sendable.");
    return;
  }

  await channel.send("Hey! I'm online.");
});

client.on(Events.MessageCreate, async (message) => {
  if (message.channelId !== targetChannelId) {
    return;
  }

  const userName =
    message.author.id === client.user?.id
      ? "ben"
      : message.author.username;

  messageQueue.push({
    userName,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  });

  while (messageQueue.length > queueSize) {
    messageQueue.shift();
  }

  console.log("Tracked messages:", JSON.stringify(messageQueue, null, 2));

  if (message.author.bot) {
    return;
  }

  await message.reply("Hey! I'm Ben. How can I help?");
});

client.login(token);
