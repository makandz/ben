import { Client, GatewayIntentBits } from "discord.js";
import { BOT_TOKEN } from "./config.js";
import { setQueueClient } from "./conversation/queue.js";
import { registerMessageCreate } from "./discord/events/message-create.js";
import { registerReady } from "./discord/events/ready.js";
import { registerTypingStart } from "./discord/events/typing-start.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMembers,
  ],
});

setQueueClient(client);
registerReady(client);
registerMessageCreate(client);
registerTypingStart(client);

client.login(BOT_TOKEN);
