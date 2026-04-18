import { run, type AgentInputItem } from "@openai/agents";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type AnyThreadChannel,
  type Message,
  type ThreadAutoArchiveDuration,
} from "discord.js";
import { createDiscordThreadAgent } from "./agent.js";
import { loadConfig, loadEnvironmentFile } from "./config.js";
import {
  buildPrompt,
  buildThreadName,
  createAssistantMessage,
  createUserMessage,
  extractResponseText,
  splitForDiscord,
} from "./discord-messages.js";
import { createReminderService, type Reminder } from "./reminders.js";
import { loadSystemPrompt } from "./system-prompt.js";
import { createThreadRuntime } from "./thread-runtime.js";
import {
  initializeOpenAiLogging,
  logAgentRunCompleted,
  logAgentRunFailed,
  logAgentRunStarted,
  logAgentStreamEvent,
} from "./openai-logging.js";
import {
  formatStatusUpdateMessage,
  formatToolExecutionMessage,
  isOperationalStatusMessage,
} from "./tool-status.js";

const THREAD_AUTO_ARCHIVE_DURATION: ThreadAutoArchiveDuration = 1_440;

loadEnvironmentFile();

const openAiLogging = initializeOpenAiLogging();
const config = loadConfig();
const systemPrompt = loadSystemPrompt();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const reminderService = createReminderService({
  databasePath: config.sqliteDatabasePath,
  deliverReminder: (reminder) =>
    sendReminderToAssignedChannel(client, config.discordChannelId, reminder),
});
const agent = createDiscordThreadAgent(config, reminderService, systemPrompt);
const runtime = createThreadRuntime();

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Discord bot logged in as ${readyClient.user.tag}`);
  console.log(`Monitoring channel ${config.discordChannelId}`);
  console.log(`Reminder database ${config.sqliteDatabasePath}`);
  console.log(
    `OpenAI model ${config.openAiModel} with reasoning effort ${config.openAiReasoningEffort}${config.openAiMaxTokens ? ` and max tokens ${config.openAiMaxTokens}` : ""}`,
  );
  console.log(
    `OpenAI raw event logging ${openAiLogging.logRawModelEvents ? "enabled" : "disabled"}`,
  );

  await reminderService.start();
  console.log("Reminder scheduler started");
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  if (message.channel.isThread()) {
    if (!(await isManagedThread(message))) {
      return;
    }

    runtime.queueWork(message.channel.id, async () => {
      await handleThreadMessage(message.channel as AnyThreadChannel, message);
    });
    return;
  }

  if (!shouldStartManagedThread(message)) {
    return;
  }

  const thread = await message.startThread({
    name: buildThreadName(message, client.user?.id),
    autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION,
  });

  runtime.markManagedThread(thread.id);

  runtime.queueWork(thread.id, async () => {
    await handleThreadMessage(thread, message);
  });
});

client.login(config.discordBotToken);

/**
 * Returns true for root-channel messages that should spawn a managed bot thread.
 *
 * @param message - Incoming Discord message.
 * @returns `true` when the message should create a managed thread.
 */
function shouldStartManagedThread(message: Message): boolean {
  return (
    message.channel.type === ChannelType.GuildText &&
    message.channelId === config.discordChannelId &&
    message.mentions.has(client.user!) &&
    !message.author.bot
  );
}

/**
 * Determines whether an existing Discord thread belongs to this bot's workflow.
 *
 * @param message - Incoming Discord message from a thread.
 * @returns Whether the thread is managed by this bot.
 */
async function isManagedThread(message: Message): Promise<boolean> {
  const thread = message.channel;

  if (!thread.isThread() || thread.parentId !== config.discordChannelId) {
    return false;
  }

  if (runtime.hasManagedThread(thread.id)) {
    return true;
  }

  const starterMessage = await thread.fetchStarterMessage();

  if (!starterMessage) {
    return false;
  }

  const managed = shouldStartManagedThread(starterMessage);

  if (managed) {
    runtime.markManagedThread(thread.id);
  }

  return managed;
}

/**
 * Rebuilds the prompt, executes the agent, and posts streamed tool notices and replies.
 *
 * @param thread - Discord thread to reply in.
 * @param message - Message that triggered the reply.
 * @returns Nothing.
 */
async function handleThreadMessage(
  thread: AnyThreadChannel,
  message: Message,
): Promise<void> {
  const history = await getThreadHistory(thread, message.id);
  const prompt = buildPrompt(message, client.user?.id);

  if (!prompt) {
    return;
  }

  history.push(createUserMessage(prompt));
  const currentTimeIso = new Date().toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  logAgentRunStarted({
    threadId: thread.id,
    messageId: message.id,
    requestingUserId: message.author.id,
    historyLength: history.length,
    model: config.openAiModel,
    timeZone,
    prompt,
  });

  await thread.sendTyping();

  try {
    const result = await run(agent, history, {
      stream: true,
      context: {
        currentTimeIso,
        timeZone,
        requestingUserId: message.author.id,
        announceToolExecution: async (toolName: string) => {
          await thread.send(formatToolExecutionMessage(toolName));
        },
        sendStatusUpdate: async (statusMessage: string) => {
          await thread.send(formatStatusUpdateMessage(statusMessage));
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
      threadId: thread.id,
      messageId: message.id,
      lastResponseId: result.lastResponseId,
      historyLength: result.history.length,
      newItemTypes: result.newItems.map((item) => item.type),
      finalOutput: result.finalOutput,
    });

    for (const chunk of splitForDiscord(responseText)) {
      await thread.send(chunk);
      history.push(createAssistantMessage(chunk));
    }
  } catch (error) {
    logAgentRunFailed({
      threadId: thread.id,
      messageId: message.id,
      historyLength: history.length,
      prompt,
      error,
    });
    console.error(`Failed to handle thread ${thread.id}:`, error);

    const fallback =
      "I hit an error while generating a reply. Please try again in a moment.";

    await thread.send(fallback);
    history.push(createAssistantMessage(fallback));
  }
}

/**
 * Returns cached thread history when available, otherwise rebuilds it from Discord.
 *
 * @param thread - Discord thread whose history should be loaded.
 * @param skipMessageId - Message id to omit from rebuilt history.
 * @returns Agent history for the thread.
 */
async function getThreadHistory(
  thread: AnyThreadChannel,
  skipMessageId?: string,
): Promise<AgentInputItem[]> {
  const existing = runtime.getHistory(thread.id);

  if (existing) {
    return existing;
  }

  const history = await rebuildThreadHistory(thread, skipMessageId);
  runtime.setHistory(thread.id, history);
  return history;
}

/**
 * Sends a due reminder into the configured root channel.
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
 * Reconstructs agent history from the thread starter plus prior thread messages.
 *
 * @param thread - Discord thread whose history should be rebuilt.
 * @param skipMessageId - Message id to omit while rebuilding history.
 * @returns Reconstructed agent history.
 */
async function rebuildThreadHistory(
  thread: AnyThreadChannel,
  skipMessageId?: string,
): Promise<AgentInputItem[]> {
  const history: AgentInputItem[] = [];
  const starterMessage = await thread.fetchStarterMessage();

  if (starterMessage && shouldStartManagedThread(starterMessage)) {
    const starterPrompt = buildPrompt(starterMessage, client.user?.id);

    if (starterPrompt) {
      history.push(createUserMessage(starterPrompt));
    }
  }

  const messages = await thread.messages.fetch({ limit: 100 });
  const sortedMessages = [...messages.values()].sort(
    (left, right) => left.createdTimestamp - right.createdTimestamp,
  );

  for (const existingMessage of sortedMessages) {
    if (existingMessage.id === skipMessageId) {
      continue;
    }

    if (existingMessage.author.id === client.user?.id) {
      const text = existingMessage.content.trim();

      if (text && !isOperationalStatusMessage(text)) {
        history.push(createAssistantMessage(text));
      }

      continue;
    }

    if (existingMessage.author.bot) {
      continue;
    }

    const prompt = buildPrompt(existingMessage, client.user?.id);

    if (prompt) {
      history.push(createUserMessage(prompt));
    }
  }

  return history;
}
