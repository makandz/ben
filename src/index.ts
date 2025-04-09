import {
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  TextChannel,
  User,
} from "discord.js";
import { BOT_TOKEN, TARGET_CHANNEL_ID } from "./config.js";
import { queryGemini } from "./query-gemini.js";
import { isTextChannel } from "./utils/is-text-channel.js";

const DEBUG = false;

/**
 * Converts any @username mentions in a message to proper Discord mentions.
 * Uses Discord.js's built-in cache for guild members.
 */
const convertUsernamesToMentions = async (
  guild: Guild,
  content: string
): Promise<string> => {
  const mentionRegex = /@(\w+)/g;
  const matches = content.match(mentionRegex);
  if (!matches) return content;

  let result = content;
  for (const match of matches) {
    const username = match.substring(1); // Remove @ symbol

    // Look up the member from the built-in cache first
    let member = guild.members.cache.find(
      (m) => m.user.username.toLowerCase() === username.toLowerCase()
    );

    // Fall back to API fetch if not found in the cache
    if (!member) {
      const fetchedMembers = await guild.members.fetch({
        query: username,
        limit: 1,
      });
      member = fetchedMembers.first();
    }

    if (member) {
      result = result.replace(
        new RegExp(`@${username}\\b`, "g"),
        `<@${member.id}>`
      );
    }
  }

  return result;
};

/**
 * Converts Discord mention format (<@userId>) to @username format
 */
const convertMentionsToUsernames = (content: string, message: any): string => {
  return content.replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = message.mentions.users.get(userId);
    return user ? `@${user.username}` : match;
  });
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMembers,
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

let lastInvolved: number | null = null;
let ignoreCount = 0; // TODO:
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
  // console.log(prompt)

  console.log(prompt);
  const shouldRespond = await queryGemini(prompt, "think-should-respond");
  if (DEBUG) {
    await channel.send(`> thinking.. should I respond? ${shouldRespond}`);
  }

  console.log("Should respond:", shouldRespond);

  if (!shouldRespond || !shouldRespond.includes("YES")) {
    console.log("Not responding to the message.");
    processMessageArgs = null;
    return;
  }

  const response = await queryGemini(prompt, "conversation");

  response.split("\n\n").forEach((part) => {
    const partParsed = part.replaceAll(/\n/g, " ").trim();
    if (!partParsed || partParsed === "N/A") {
      return;
    }

    messageQueue.push({
      content: partParsed,
      channel: channel,
    });
  });

  // Clear the processMessageArgs before processing the queue
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

    // Convert any @username mentions to proper Discord mentions
    const convertedContent = await convertUsernamesToMentions(
      message.channel.guild,
      message.content
    );

    // Adds the bot's own message to the channel history
    addToChannelHistory({
      author: client.user!,
      content: message.content, // Store original content in history
    });

    lastInvolved = new Date().getTime();
    await message.channel.send(convertedContent);

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
  await channel.send(`hello world! (debug: ${DEBUG.toString()})`);
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

  // Convert mentions to usernames before adding to history
  const convertedContent = convertMentionsToUsernames(message.content, message);
  addToChannelHistory({
    author: message.author,
    content: convertedContent,
  });

  const isMentioned = message.mentions.has(client.user.id);
  if (
    !isMentioned &&
    (!lastInvolved || lastInvolved <= new Date().getTime() - 60000)
  ) {
    console.log(
      "Not mentioned and last ping was longer than a minute, ignoring message: ",
      message.content
    );
    return;
  }

  if (isMentioned) {
    lastInvolved = new Date().getTime();
  }

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

  let prompt: string = ``;
  const usersInConversation: Set<User> = new Set([client.user, message.author]);

  channelHistory.forEach((msg) => {
    if (msg.author.id !== client.user?.id) {
      usersInConversation.add(msg.author);
    }
  });

  prompt += `You are Ben with the ID: ${client.user.id}.\n\n`;
  prompt += `Conversation:\n`;

  channelHistory.forEach((msg) => {
    let content = msg.content;
    usersInConversation.forEach((user) => {
      content = content.replaceAll(
        `<@${user.id}>`,
        `@${user.username} (id: ${user.id})`
      );
    });

    prompt += `${msg.author.username} (id: ${msg.author.id}): ${content}\n`;
  });

  processMessageArgs = {
    prompt,
    channel: message.channel,
  };

  waitingTimeout = setTimeout(processMessage, 3000);
});

client.on("typingStart", (typing) => {
  if (typing.user.id === client.user?.id || !processMessageArgs) {
    return;
  }

  if (waitingTimeout) {
    clearTimeout(waitingTimeout);
    waitingTimeout = null;
  }

  waitingTimeout = setTimeout(processMessage, 3000);
});

client.login(BOT_TOKEN);
