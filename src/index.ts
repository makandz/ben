import {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  User,
} from "discord.js";
import { BOT_TOKEN, TARGET_CHANNEL_ID } from "./config.js";
import { memoryStore } from "./memory.js";
import { getEmbedding, queryGemini } from "./query-gemini.js";
import { isTextChannel } from "./utils/is-text-channel.js";

const DEBUG = true;

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

  if (shouldRespond.trim() !== "YES") {
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

    // Adds the bot's own message to the channel history
    addToChannelHistory({
      author: client.user!,
      content: message.content,
    });

    lastInvolved = new Date().getTime();
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

  addToChannelHistory({
    author: message.author,
    content: message.content,
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

  // Handle memory commands
  if (content.startsWith("remember: ")) {
    const memoryContent = content.substring("remember: ".length).trim();
    try {
      const embedding = await getEmbedding(memoryContent);
      memoryStore.add(Date.now().toString(), embedding, memoryContent, {
        author: message.author.id,
        timestamp: Date.now(),
      });
      await message.channel.send("got it, i'll remember that");
    } catch (error) {
      console.error("Error storing memory:", error);
      await message.channel.send("sorry, couldn't store that in my memory");
    }
    return;
  }

  if (content.startsWith("query: ")) {
    const queryContent = content.substring("query: ".length).trim();
    try {
      const queryEmbedding = await getEmbedding(queryContent);
      const results = memoryStore.query(queryEmbedding, 1);

      if (results.length > 0 && results[0].score > 0.7) {
        await message.channel.send(`this reminds me of: ${results[0].content}`);
      } else {
        await message.channel.send(
          "hmm, nothing quite like that comes to mind"
        );
      }
    } catch (error) {
      console.error("Error querying memory:", error);
      await message.channel.send("sorry, had trouble searching my memories");
    }
    return;
  }

  let prompt: string = `Conversation:\n`;

  channelHistory.forEach((msg) => {
    prompt += `${msg.author.username}: ${msg.content}\n`;
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

  waitingTimeout = setTimeout(processMessage, 10000);
});

client.login(BOT_TOKEN);
