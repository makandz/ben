import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { aiService } from "./services/aiService.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.channelId !== config.channelId) return;

  if (aiService.isBusy()) return;

  try {
    await message.channel.sendTyping();
    const response = await aiService.generateResponse(message.content);
    await message.reply(response);
  } catch (error) {
    console.error("AI response error:", error);
    await message.reply(
      "Sorry, I encountered an error processing your message."
    );
  }
});

client.login(config.discordToken);
