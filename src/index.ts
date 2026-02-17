import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const targetChannelId = process.env.DISCORD_TARGET_CHANNEL_ID;

if (!token) {
  throw new Error("Missing DISCORD_TOKEN in environment");
}

if (!targetChannelId) {
  throw new Error("Missing DISCORD_TARGET_CHANNEL_ID in environment");
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
  if (message.author.bot) {
    return;
  }

  if (message.channelId !== targetChannelId) {
    return;
  }

  await message.reply("Hey! I'm Ben. How can I help?");
});

client.login(token);
