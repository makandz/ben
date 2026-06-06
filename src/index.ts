import "dotenv/config";

import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

if (!token) {
  throw new Error("Missing DISCORD_TOKEN. Add it to .env before starting the bot.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Hello, logged in as ${readyClient.user.tag}.`);

  if (!channelId) {
    return;
  }

  const channel = await readyClient.channels.fetch(channelId);

  if (channel?.type !== ChannelType.GuildText) {
    throw new Error("DISCORD_CHANNEL_ID must point to a text channel the bot can access.");
  }

  await channel.send("Hello!");
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

await client.login(token);
