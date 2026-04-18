import { run } from "@openai/agents";
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type SendableChannels,
  type Typing,
} from "discord.js";
import { createDiscordAgent } from "./agent.js";
import { createChannelRuntime } from "./channel-runtime.js";
import { loadConfig, loadEnvironmentFile } from "./config.js";
import {
  buildPrompt,
  createAssistantMessage,
  createUserMessage,
  extractResponseText,
  splitForDiscord,
} from "./discord-messages.js";
import {
  initializeOpenAiLogging,
  logAgentRunCompleted,
  logAgentRunFailed,
  logAgentRunStarted,
  logAgentStreamEvent,
} from "./openai-logging.js";
import { createReminderService, type Reminder } from "./reminders.js";
import { loadSystemPrompt } from "./system-prompt.js";
import {
  formatStatusUpdateMessage,
  formatToolExecutionMessage,
} from "./tool-status.js";

const CHANNEL_QUEUE_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const ACTIVE_TYPING_WINDOW_MS = 10_000;
const NO_RESPONSE_TEXT = "N/A";
const SLEEPING_ACTIVITY_TEXT = "zzz";
const AWAKE_ACTIVITY_TEXT = "thinking..";

loadEnvironmentFile();

const openAiLogging = initializeOpenAiLogging();
const config = loadConfig();
const systemPrompt = loadSystemPrompt();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.MessageContent,
  ],
});
const reminderService = createReminderService({
  databasePath: config.sqliteDatabasePath,
  deliverReminder: (reminder) =>
    sendReminderToAssignedChannel(client, config.discordChannelId, reminder),
});
const agent = createDiscordAgent(config, reminderService, systemPrompt);
const runtime = createChannelRuntime();

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Discord bot logged in as ${readyClient.user.tag}`);
  console.log("Tracking guild channel conversations");
  console.log(`Reminder delivery channel ${config.discordChannelId}`);
  console.log(`Reminder database ${config.sqliteDatabasePath}`);
  console.log(`Response silence timeout ${config.responseSilenceTimeoutMs}ms`);
  console.log(
    `OpenAI model ${config.openAiModel} with reasoning effort ${config.openAiReasoningEffort}${config.openAiMaxTokens ? ` and max tokens ${config.openAiMaxTokens}` : ""}`,
  );
  console.log(
    `OpenAI raw event logging ${openAiLogging.logRawModelEvents ? "enabled" : "disabled"}`,
  );

  updateActivityStatus();
  await reminderService.start();
  console.log("Reminder scheduler started");
});

client.on(Events.MessageCreate, async (message) => {
  if (!shouldTrackChannelMessage(message)) {
    return;
  }

  const prompt = buildPrompt(message, client.user?.id);

  if (!prompt) {
    return;
  }

  runtime.recordMessage(message.channelId, createUserMessage(prompt), {
    createdAt: message.createdTimestamp,
    messageId: message.id,
    userId: message.author.id,
  });
  scheduleConversationExpiry(message.channelId);

  if (shouldWakeChannel(message)) {
    const previousMode = runtime.getMode(message.channelId);
    runtime.setMode(message.channelId, "awake");

    if (previousMode !== "awake") {
      updateActivityStatus();
    }
  }

  if (runtime.getMode(message.channelId) === "awake") {
    scheduleReplyAttempt(message.channelId);
  }
});

client.on(Events.TypingStart, async (typing) => {
  if (!shouldTrackTyping(typing)) {
    return;
  }

  const channelId = typing.channel.id;

  if (runtime.getMode(channelId) !== "awake") {
    return;
  }

  runtime.recordTyping(
    channelId,
    typing.user.id,
    typing.startedTimestamp +
      Math.max(config.responseSilenceTimeoutMs, ACTIVE_TYPING_WINDOW_MS),
    typing.startedTimestamp,
  );
  scheduleReplyAttempt(channelId);
});

client.login(config.discordBotToken);

/**
 * Returns whether the incoming Discord message should be tracked for conversation state.
 *
 * @param message - Incoming Discord message.
 * @returns `true` when the message belongs to a sendable guild text channel.
 */
function shouldTrackChannelMessage(message: Message): boolean {
  return (
    message.inGuild() &&
    !message.author.bot &&
    !message.channel.isThread() &&
    message.channel.isSendable()
  );
}

/**
 * Returns whether the message should wake Ben into active reply mode for that channel.
 *
 * @param message - Incoming Discord message.
 * @returns `true` when the bot was mentioned directly.
 */
function shouldWakeChannel(message: Message): boolean {
  const botUserId = client.user?.id;

  return botUserId !== undefined && message.mentions.users.has(botUserId);
}

/**
 * Returns whether a typing event should delay an awake channel's next response attempt.
 *
 * @param typing - Discord typing event.
 * @returns `true` when the event belongs to a tracked guild channel.
 */
function shouldTrackTyping(typing: Typing): boolean {
  return (
    typing.inGuild() &&
    !typing.user.bot &&
    !typing.channel.isThread?.() &&
    typing.channel.isSendable()
  );
}

/**
 * Schedules the channel queue to be cleared after prolonged message inactivity.
 *
 * @param channelId - Discord channel id whose conversation queue should expire.
 * @returns Nothing.
 */
function scheduleConversationExpiry(channelId: string): void {
  const timer = setTimeout(() => {
    const wasAwake = runtime.getMode(channelId) === "awake";

    runtime.clearChannel(channelId);

    if (wasAwake) {
      updateActivityStatus();
    }
  }, CHANNEL_QUEUE_IDLE_TIMEOUT_MS);

  runtime.setClearTimer(channelId, timer);
}

/**
 * Schedules a silence-gated reply attempt for an awake channel.
 *
 * @param channelId - Discord channel id whose next reply should be debounced.
 * @returns Nothing.
 */
function scheduleReplyAttempt(channelId: string): void {
  const delay = Math.max(
    runtime.getRemainingSilenceMs(
      channelId,
      Date.now(),
      config.responseSilenceTimeoutMs,
    ),
    0,
  );
  const timer = setTimeout(() => {
    runtime.clearResponseTimer(channelId);
    runtime.queueWork(channelId, async () => {
      await handleChannelReply(channelId);
    });
  }, delay);

  runtime.setResponseTimer(channelId, timer);
}

/**
 * Runs the model for an awake channel once the conversation has gone quiet.
 *
 * @param channelId - Discord channel id whose queue should be evaluated.
 * @returns Nothing.
 */
async function handleChannelReply(channelId: string): Promise<void> {
  const state = runtime.getChannel(channelId);

  if (!state || state.mode !== "awake" || state.history.length === 0) {
    return;
  }

  const remainingSilenceMs = runtime.getRemainingSilenceMs(
    channelId,
    Date.now(),
    config.responseSilenceTimeoutMs,
  );

  if (remainingSilenceMs > 0) {
    scheduleReplyAttempt(channelId);
    return;
  }

  const channel = await fetchSendableChannel(channelId);

  if (!channel) {
    runtime.clearChannel(channelId);
    updateActivityStatus();
    return;
  }

  const messageId = state.lastMessageId;
  const requestingUserId = state.lastRequestingUserId;

  if (!messageId || !requestingUserId) {
    return;
  }

  const history = [...state.history];
  const currentTimeIso = new Date().toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const prompt = describeLatestPrompt(history.at(-1));

  logAgentRunStarted({
    channelId,
    messageId,
    requestingUserId,
    historyLength: history.length,
    model: config.openAiModel,
    timeZone,
    prompt,
  });

  await channel.sendTyping();

  try {
    const result = await run(agent, history, {
      stream: true,
      context: {
        currentTimeIso,
        timeZone,
        requestingUserId,
        announceToolExecution: async (toolName: string) => {
          await channel.send(formatToolExecutionMessage(toolName));
        },
        sendStatusUpdate: async (statusMessage: string) => {
          await channel.send(formatStatusUpdateMessage(statusMessage));
        },
      },
    });

    for await (const event of result) {
      logAgentStreamEvent(event, openAiLogging);
    }

    const responseText = extractResponseText(result.finalOutput);

    if (!responseText) {
      throw new Error("Model returned an empty response.");
    }

    logAgentRunCompleted({
      channelId,
      messageId,
      lastResponseId: result.lastResponseId,
      historyLength: result.history.length,
      newItemTypes: result.newItems.map((item) => item.type),
      finalOutput: result.finalOutput,
    });

    if (isNoResponse(responseText)) {
      runtime.setMode(channelId, "sleep");
      runtime.clearTyping(channelId);
      runtime.trimHistoryToCurrentMode(channelId);
      updateActivityStatus();
      return;
    }

    for (const chunk of splitForDiscord(responseText)) {
      await channel.send(chunk);
      runtime.recordAssistantMessage(
        channelId,
        createAssistantMessage(chunk),
        Date.now(),
      );
    }
  } catch (error) {
    logAgentRunFailed({
      channelId,
      messageId,
      historyLength: history.length,
      prompt,
      error,
    });
    console.error(`Failed to handle channel ${channelId}:`, error);

    const fallback =
      "I hit an error while generating a reply. Please try again in a moment.";

    await channel.send(fallback);
    runtime.recordAssistantMessage(
      channelId,
      createAssistantMessage(fallback),
      Date.now(),
    );
  }
}

/**
 * Updates the bot's visible Discord activity to match whether any channel is awake.
 *
 * @returns Nothing.
 */
function updateActivityStatus(): void {
  const text =
    runtime.countAwakeChannels() > 0 ? AWAKE_ACTIVITY_TEXT : SLEEPING_ACTIVITY_TEXT;

  client.user?.setPresence({
    activities: [
      {
        name: text,
        state: text,
        type: ActivityType.Custom,
      },
    ],
    status: "online",
  });
}

/**
 * Fetches a sendable, non-thread channel by id.
 *
 * @param channelId - Discord channel id to fetch.
 * @returns The sendable channel, or `null` when unavailable.
 */
async function fetchSendableChannel(
  channelId: string,
): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(channelId);

  if (!channel || channel.isThread() || !channel.isSendable()) {
    return null;
  }

  return channel;
}

/**
 * Sends a due reminder into the configured reminder channel.
 *
 * @param discordClient - Logged-in Discord client.
 * @param channelId - Configured destination channel id.
 * @param reminder - Reminder that should be delivered.
 * @returns Nothing.
 */
async function sendReminderToAssignedChannel(
  discordClient: Client,
  channelId: string,
  reminder: Reminder,
): Promise<void> {
  const channel = await discordClient.channels.fetch(channelId);

  if (!channel || !channel.isSendable() || channel.isThread()) {
    throw new Error(
      "Configured reminder channel is unavailable or not a text channel.",
    );
  }

  await channel.send(`<@${reminder.userId}> ${reminder.reminderText}`);
}

/**
 * Returns the last stored user prompt for logging purposes.
 *
 * @param item - Most recent history item.
 * @returns Prompt preview text for logging.
 */
function describeLatestPrompt(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }

  const content = (item as { content?: Array<{ text?: string }> }).content;

  if (!Array.isArray(content)) {
    return "";
  }

  const text = content
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");

  return text;
}

/**
 * Returns whether the model explicitly chose to stay silent.
 *
 * @param responseText - Final model output text.
 * @returns `true` when the response means Ben should go back to sleep.
 */
function isNoResponse(responseText: string): boolean {
  return responseText.trim().toUpperCase() === NO_RESPONSE_TEXT;
}
