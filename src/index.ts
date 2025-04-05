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
    GatewayIntentBits.GuildMessageTyping,
  ],
});

const channelHistory: {
  author: User;
  content: string;
}[] = [];

/**
 * Adds a message to the channel history. Maintains a maximum length of 20 messages.
 * @param message - The message to add to the history.
 */
const addToChannelHistory = (message: { author: User; content: string }) => {
  channelHistory.push(message);
  if (channelHistory.length > 20) {
    channelHistory.shift();
  }
};

const WPM = 130;
const calculateTypingSpeed = (message: string): number => {
  const wordCount = message.trim().split(/\s+/).length;
  const delay = (wordCount / WPM) * 60000;
  return Math.min(Math.max(1500, delay), 4000);
};

let processMessageArgs: {
  prompt: string;
  channel: TextChannel;
} | null = null;

let lastPing: number | null = null;
let waitingTimeout: NodeJS.Timeout | null = null;
let conversationTimeout: NodeJS.Timeout | null = null;
let typingMessage: string | null = null;
const messageQueue: {
  content: string;
  channel: TextChannel;
}[] = [];

const processMessage = async () => {
  if (!processMessageArgs) {
    return;
  }

  const { prompt, channel } = processMessageArgs;
  console.log(prompt);

  const response = await queryGemini(prompt, "conversation");

  response.split("\n\n").forEach((part) => {
    messageQueue.push({
      content: part.replaceAll(/\n/g, " "),
      channel: channel,
    });
  });

  // Clear the processMessageArgs
  processMessageArgs = null;

  processQueue();
};

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

    // Adds the bot's own message to the channel history
    addToChannelHistory({
      author: client.user!,
      content: message.content,
    });

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

  // Clear all timers, we starting again here.
  if (waitingTimeout) {
    clearTimeout(waitingTimeout);
    waitingTimeout = null;
  }

  if (conversationTimeout) {
    clearTimeout(conversationTimeout);
    conversationTimeout = null;
  }

  addToChannelHistory({
    author: message.author,
    content: message.content,
  });

  const isMentioned = message.mentions.has(client.user.id);
  if (!isMentioned && (!lastPing || lastPing <= new Date().getTime() - 60000)) {
    console.log(
      "Not mentioned and last ping was longer than a minute, ignoring message: ",
      message.content
    );
    return;
  }

  lastPing = new Date().getTime();
  let content = message.content
    .replace(new RegExp(`<@!?${client?.user?.id}>`, "g"), "")
    .trim();

  if (!content) {
    console.log("No content after mention, ignoring message.");
    return;
  }

  // debug
  if (content === "debug") {
    if (typingMessage) {
      message.channel.send(`Typing message: ${typingMessage}`);
    }
    return;
  }

  let prompt: string = `Users:\n`;
  const usersInConversation: Set<User> = new Set([message.author]);

  channelHistory.forEach((msg) => {
    if (msg.author.id !== client.user?.id) {
      usersInConversation.add(msg.author);
    }
  });

  prompt += `You are Ben with the ID: ${client.user.id}.\n`;

  prompt += `\nConversation:\n`;
  channelHistory.forEach((msg) => {
    prompt += `${msg.author.id}: ${msg.content}\n`;
  });

  processMessageArgs = {
    prompt: prompt + `${message.author.id}: ${content}\n`,
    channel: message.channel,
  };

  waitingTimeout = setTimeout(processMessage, 4000);
});

client.on("typingStart", (typing) => {
  if (typing.user.id === client.user?.id || !processMessageArgs) {
    return;
  }

  if (waitingTimeout) {
    clearTimeout(waitingTimeout);
    waitingTimeout = null;
  }

  waitingTimeout = setTimeout(processMessage, 10000);
});

client.login(BOT_TOKEN);
