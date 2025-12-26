import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import { config } from "./config.js";
import { generateReply } from "./llm/gemini.js";
import { addMessage, getHistory } from "./messageHistory.js";
import { simulateTyping } from "./typing.js";
import {
  isGuildTextChannel,
  resolveMentionsToUsernames,
  resolveUsernamesToMentions,
} from "./utils/discord.js";

const IDLE_DELAY = 7000;
const INTERACTION_COOLDOWN = 120_000; // 120 seconds in ms

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMembers,
  ],
});

let idleTimer: NodeJS.Timeout | undefined;
let currentOperationId = 0;
let isProcessing = false; // Ignore typing events while processing
let lastInteractionTime = 0;

/**
 * Check if Ben was mentioned in the message.
 * @param resolvedContent - The message content with mentions resolved to usernames.
 * @returns True if Ben was mentioned, false otherwise.
 */
const isBotMentioned = (resolvedContent: string): boolean => {
  // tbh could have used the built in isMentioned method but this is simpler
  return resolvedContent.includes("@Ben");
};

/**
 * Check if we are within the interaction cooldown window.
 * @returns True if within cooldown, false otherwise.
 */
const isWithinInteractionWindow = (): boolean => {
  return Date.now() - lastInteractionTime < INTERACTION_COOLDOWN;
};

/**
 * Check if the current operation has been interrupted.
 * @param operationId - The operation ID to check.
 * @param stage - Optional stage name for debug logging.
 * @returns True if interrupted, false otherwise.
 */
const isInterrupted = (operationId: number, stage?: string): boolean => {
  if (operationId !== currentOperationId) {
    console.log(`🛑 Interrupted ${stage}, likely a new message received.`);

    return true;
  }
  return false;
};

/**
 * Process and send a reply to the channel.
 * This handles generating the reply, typing simulation, and sending messages.
 * Can be interrupted at any point by a new message.
 * @param channel - The channel to send the reply to.
 * @param operationId - The operation ID to check for interruption.
 */
const processAndReply = async (
  channel: TextChannel,
  operationId: number
): Promise<void> => {
  isProcessing = true;

  try {
    console.log(`💭 Generating reply for #${channel.name}`);
    const { messages, tokenUsage, model } = await generateReply(channel.name);

    if (isInterrupted(operationId, "during generation")) {
      return;
    }

    const {
      current: { inputTokens: curIn, outputTokens: curOut },
      total: { inputTokens: totIn, outputTokens: totOut },
    } = tokenUsage;

    console.log(
      `📊 Tokens: ${curIn} in / ${curOut} out (total: ${totIn} in / ${totOut} out)`
    );

    if (config.debug) {
      const historyLength = getHistory().length;
      await channel.send(
        `> 📊 ${model}: ${curIn}/${curOut} (total: ${totIn}/${totOut}), history: ${historyLength}`
      );
    }

    console.log(`⏳ Sending ${messages.length} messages...`);

    for (const msg of messages) {
      await simulateTyping(channel, msg);
      if (isInterrupted(operationId, "during typing")) {
        return;
      }

      console.log(`💬 Sending message: ${msg}`);
      const resolvedMsg = await resolveUsernamesToMentions(msg, channel.guild!);
      await channel.send(resolvedMsg);
      lastInteractionTime = Date.now();
      addMessage("Ben", msg);

      if (isInterrupted(operationId, "after sending")) {
        return;
      }
    }
  } finally {
    // Only mark as not processing if this operation wasn't interrupted
    if (operationId === currentOperationId) {
      isProcessing = false;
    }
  }
};

/**
 * Schedule an idle reply for the given channel. Generates a reply after 5
 * seconds of inactivity and sends it.
 * @param channel - The channel to send the reply to.
 */
const scheduleIdleReply = (channel: TextChannel) => {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  const operationId = currentOperationId;

  idleTimer = setTimeout(async () => {
    idleTimer = undefined;
    await processAndReply(channel, operationId);
  }, IDLE_DELAY);
};

/**
 * Handle a message create event.
 * Always adds messages to history, but only schedules replies when Ben is
 * mentioned or within the interaction cooldown window.
 * Messages can interrupt Ben at any time (idle, generating, or typing).
 * @param message - The message that was created.
 */
client.on("messageCreate", async (message) => {
  const channel = message.channel;

  if (
    message.author.bot ||
    channel.id !== config.targetChannelId ||
    !isGuildTextChannel(channel)
  ) {
    return;
  }

  const resolvedContent = await resolveMentionsToUsernames(
    message.content,
    message.guild!
  );

  console.log(
    `📔 Received message ${message.author.username}: ${resolvedContent}`
  );

  // Always add to history
  addMessage(message.author.username, resolvedContent);

  // Only enter scheduling mode if pinged OR within cooldown
  const shouldSchedule =
    isBotMentioned(resolvedContent) || isWithinInteractionWindow();

  if (shouldSchedule) {
    // Increment operation ID to interrupt any ongoing operation
    currentOperationId++;
    lastInteractionTime = Date.now();
    isProcessing = false;

    scheduleIdleReply(channel);
  }
});

/**
 * Handle a typing start event.
 * Typing only resets the idle timer when Ben is in idle mode (not processing).
 * @param typing - The typing event.
 */
client.on("typingStart", (typing) => {
  const channel = typing.channel;

  if (
    typing.user?.bot ||
    !channel ||
    channel.id !== config.targetChannelId ||
    !isGuildTextChannel(channel) ||
    isProcessing ||
    !idleTimer
  ) {
    return;
  }

  scheduleIdleReply(channel);
});

/**
 * Handle the client being ready.
 */
client.once("ready", () => {
  console.log(`👋 Logged in as ${client.user?.tag}`);
});

client.login(config.discordToken);
