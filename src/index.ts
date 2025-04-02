import {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  User,
} from "discord.js";
import { BOT_TOKEN, TARGET_CHANNEL_ID } from "./config.js";
import { queryGemini } from "./query-gemini.js";
import { isTextChannel } from "./utils/is-text-channel.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const WPM = 130;
const calculateTypingSpeed = (message: string): number => {
  const wordCount = message.trim().split(/\s+/).length;
  const delay = (wordCount / WPM) * 60000;
  return Math.min(Math.max(1500, delay), 4000);
};

let conversationTimeout: NodeJS.Timeout | null = null;
let typingMessage: string | null = null;
const messageQueue: {
  content: string;
  channel: TextChannel;
}[] = [];

const processQueue = () => {
  typingMessage = null;
  if (conversationTimeout) {
    clearTimeout(conversationTimeout);
    conversationTimeout = null;
  }

  if (messageQueue.length === 0) {
    return;
  }

  const message = messageQueue.shift()!;
  message.channel.sendTyping();

  const typingDuration = calculateTypingSpeed(message.content);
  console.log(
    `Simulating typing for "${message.content}" in ${typingDuration}ms`
  );

  // Simulate typing
  conversationTimeout = setTimeout(async () => {
    typingMessage = message.content;
    await message.channel.send(message.content);

    // Process the next message in the queue
    processQueue();
  }, calculateTypingSpeed(message.content));
};

/**
 * Once the client is ready, we're alive!
 */
client.once(Events.ClientReady, async (readyClient) => {
  const channel = await readyClient.channels.fetch(TARGET_CHANNEL_ID);

  if (!isTextChannel(channel)) {
    return console.error(
      "Target channel is not text-based, not found, or is a PartialGroupDMChannel."
    );
  }

  console.log(`Logged in as ${readyClient.user.tag}`);
  await channel.send("hello world!");
});

/**
 * Listen for messages in the target channel.
 */
client.on(Events.MessageCreate, async (message) => {
  if (
    message.author.bot ||
    message.channel.id !== TARGET_CHANNEL_ID ||
    !client.user ||
    !isTextChannel(message.channel)
  ) {
    return;
  }

  const isMentioned = message.mentions.has(client.user.id);
  if (!isMentioned) {
    console.log("Not mentioned, ignoring message: ", message.content);
    return;
  }

  let content = message.content
    .replace(new RegExp(`<@!?${client?.user?.id}>`, "g"), "")
    .trim();

  if (!content) {
    console.log("No content after mention, ignoring message.");
    return;
  }

  let prompt: string = `Users:\n`;
  const usersInConversation: Set<User> = new Set([message.author]);

  const messageHistory = await message.channel.messages.fetch({
    limit: 20,
    before: message.id,
  });

  messageHistory.forEach((msg) => {
    if (msg.author.id !== client.user?.id) {
      usersInConversation.add(msg.author);
    }
  });

  prompt += `Ben (You are Ben)\n`;
  usersInConversation.forEach((user) => {
    prompt += `${user.username} (id: ${user.id})\n`;
  });

  prompt += `\nConversation:\n`;
  messageHistory.forEach((msg) => {
    prompt += `${msg.author.username}: ${msg.content.replaceAll(/\n/g, " ")}\n`;
  });

  // TODO: add the current user to the list of unique users
  prompt += `${message.author.username}: ${content}\n\n`;

  console.log("Prompt: ", prompt);

  const response = await queryGemini(prompt, "conversation");

  response.split("\n\n").forEach((part) => {
    messageQueue.push({
      content: part.replaceAll(/\n/g, " "),
      channel: message.channel as TextChannel,
    });
  });

  processQueue();
});

client.login(BOT_TOKEN);
