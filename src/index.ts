import * as dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { TextChannel } from 'discord.js';
import { generateMessageMemory } from './gpt.js';

dotenv.config();

console.log("Starting up the Discord bot...");

const discordClient = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const channels = new Map<string, TextChannel>();

const sendMessage = async (channel: TextChannel, messages: string[]) => {
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // TODO: this doesn't work
  for (const message of messages) {
    if (message.length > 0) {
      channel.sendTyping();
      console.log(`Sending '${message}' after ${(message.length / 200) * 6000}ms`);
      await setTimeout(() => channel.send(message), (message.length / 200) * 6000); // 200 characters per minute
    }
  }
}

// On ready listener
discordClient.on('ready', async () => {
  const generalChannel = discordClient.channels.cache.get(process.env.GENERAL_CHANNEL);

  if (generalChannel.isTextBased()) {
    channels.set('general', generalChannel as TextChannel);
    sendMessage(channels.get('general'), (await generateMessageMemory('hey ben, welcome to the server! introduce yourself')));
  } else {
    console.error("General channel is not a text channel!");
    process.exit(1);
  }

  console.log(`Done! Logged in as ${discordClient.user.tag}!`);
});

discordClient.login(process.env['DISCORD_KEY']);