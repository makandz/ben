import { Client, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { addMessage } from "./messageHistory.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  addMessage(message.author.username, message.content);
});

client.login(config.discordToken);
