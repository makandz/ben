import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import "dotenv/config";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { loadPrompt } from "./prompts/load-prompt.js";

const token = process.env.DISCORD_TOKEN;
const targetChannelId = process.env.DISCORD_TARGET_CHANNEL_ID;
const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiModel = "gpt-5.1";
const openAiMaxOutputTokens = 128;
const queueSize = 30;
const messageQueueTtlMs = 30 * 60 * 1000;
const usageStatePath = path.resolve(process.cwd(), "usage-state.json");
const dailySpendLimitUsd = 1;
const inputTokenPricePerMillionUsd = 1.25;
const cachedInputTokenPricePerMillionUsd = 0.125;
const outputTokenPricePerMillionUsd = 10;
const dailyResetCheckIntervalMs = 5 * 60 * 1000;
const typingIndicatorTtlMs = 12 * 1000;
const typingRecheckDelayMs = 1000;
const listeningInactivityTimeoutMs = 10 * 60 * 1000;
const tokenReportPrefix = "> 📊 ";
const responseDebounceDelayMs = 10000;
const responseLineDelayMs = 1500;
const discordUserMentionPattern = /<@!?(\d+)>/g;
const usernameMentionPattern = /(^|[^\w@])@([a-zA-Z0-9_.]{2,32})\b/g;

type TrackedMessage = {
  role: "user" | "assistant";
  speakerName: string;
  content: string;
  createdAt: string;
};

type UsageState = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  spendUsd: number;
  dateKey: string;
  lastSavedAt: string;
};

const messageQueue: TrackedMessage[] = [];
const userIdsByUsername = new Map<string, string>();
const typingActivityByUserId = new Map<string, number>();
let runningInputTokens = 0;
let runningOutputTokens = 0;
let runningCachedInputTokens = 0;
let runningReasoningTokens = 0;
let runningDailySpendUsd = 0;
let usageDateKey = getLocalDateKey(new Date());
let responseDebounceTimeout: ReturnType<typeof setTimeout> | undefined;
let dailyResetInterval: ReturnType<typeof setInterval> | undefined;
let listeningInactivityTimeout: ReturnType<typeof setTimeout> | undefined;
let responseInProgress = false;
let pendingResponse = false;
let isShuttingDown = false;
let conversationMode: "sleeping" | "listening" = "sleeping";

function normalizeUsername(userName: string): string {
  return userName.toLowerCase();
}

function trackUser(userId: string, userName: string): void {
  userIdsByUsername.set(normalizeUsername(userName), userId);
}

function convertMentionsToUsernames(content: string): string {
  return content.replace(
    discordUserMentionPattern,
    (fullMatch, userId: string) => {
      const cachedUser = client.users.cache.get(userId);

      if (!cachedUser) {
        return fullMatch;
      }

      trackUser(cachedUser.id, cachedUser.username);
      return `@${cachedUser.username}`;
    },
  );
}

function convertUsernamesToMentions(content: string): string {
  return content.replace(
    usernameMentionPattern,
    (fullMatch, prefix: string, userName: string) => {
      const userId = userIdsByUsername.get(normalizeUsername(userName));

      if (!userId) {
        return fullMatch;
      }

      return `${prefix}<@${userId}>`;
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

function resetDailyTotals(date: Date): void {
  usageDateKey = getLocalDateKey(date);
  runningInputTokens = 0;
  runningOutputTokens = 0;
  runningCachedInputTokens = 0;
  runningReasoningTokens = 0;
  runningDailySpendUsd = 0;
}

function buildUsageState(now: Date): UsageState {
  return {
    inputTokens: runningInputTokens,
    outputTokens: runningOutputTokens,
    cachedInputTokens: runningCachedInputTokens,
    reasoningTokens: runningReasoningTokens,
    spendUsd: runningDailySpendUsd,
    dateKey: usageDateKey,
    lastSavedAt: now.toISOString(),
  };
}

async function saveUsageState(): Promise<void> {
  const usageState = buildUsageState(new Date());
  const json = `${JSON.stringify(usageState, null, 2)}\n`;
  const usageStateTempPath = `${usageStatePath}.tmp`;

  await writeFile(usageStateTempPath, json, "utf8");
  await rename(usageStateTempPath, usageStatePath);
}

async function loadUsageState(): Promise<void> {
  const now = new Date();
  const currentDateKey = getLocalDateKey(now);
  let rawUsageState: string;

  try {
    rawUsageState = await readFile(usageStatePath, "utf8");
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code !== "ENOENT") {
      console.error("Failed to load usage state:", error);
    }

    resetDailyTotals(now);
    return;
  }

  const trimmedUsageState = rawUsageState.trim();

  if (trimmedUsageState.length === 0) {
    console.warn("Usage state was empty, resetting totals.");
    resetDailyTotals(now);
    await saveUsageState();
    return;
  }

  let usageState: Partial<UsageState>;

  try {
    usageState = JSON.parse(trimmedUsageState) as Partial<UsageState>;
  } catch {
    console.warn("Usage state was invalid JSON, resetting totals.");
    resetDailyTotals(now);
    await saveUsageState();
    return;
  }

  const savedAt = usageState.lastSavedAt
    ? new Date(usageState.lastSavedAt)
    : undefined;
  const savedDateKey =
    savedAt && !Number.isNaN(savedAt.getTime())
      ? getLocalDateKey(savedAt)
      : usageState.dateKey;

  if (savedDateKey !== currentDateKey) {
    resetDailyTotals(now);
    return;
  }

  usageDateKey = currentDateKey;
  runningInputTokens = toNonNegativeNumber(usageState.inputTokens);
  runningOutputTokens = toNonNegativeNumber(usageState.outputTokens);
  runningCachedInputTokens = toNonNegativeNumber(usageState.cachedInputTokens);
  runningReasoningTokens = toNonNegativeNumber(usageState.reasoningTokens);
  runningDailySpendUsd = toNonNegativeNumber(usageState.spendUsd);
}

function resetDailyTotalsIfNeeded(): void {
  const now = new Date();
  const currentDateKey = getLocalDateKey(now);

  if (currentDateKey === usageDateKey) {
    return;
  }

  resetDailyTotals(now);
  void saveUsageState().catch((error: unknown) => {
    console.error("Failed to persist usage state after daily reset:", error);
  });
}

function calculateRequestSpendUsd(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const nonCachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const inputCost =
    (nonCachedInputTokens / 1_000_000) * inputTokenPricePerMillionUsd;
  const cachedInputCost =
    (cachedInputTokens / 1_000_000) * cachedInputTokenPricePerMillionUsd;
  const outputCost = (outputTokens / 1_000_000) * outputTokenPricePerMillionUsd;

  return inputCost + cachedInputCost + outputCost;
}

function calculateDailyUsagePercent(spendUsd: number): number {
  if (dailySpendLimitUsd <= 0) {
    return 0;
  }

  return (spendUsd / dailySpendLimitUsd) * 100;
}

function startDailyResetMonitor(): void {
  if (dailyResetInterval) {
    return;
  }

  dailyResetInterval = setInterval(() => {
    resetDailyTotalsIfNeeded();
  }, dailyResetCheckIntervalMs);
}

function stopDailyResetMonitor(): void {
  if (!dailyResetInterval) {
    return;
  }

  clearInterval(dailyResetInterval);
  dailyResetInterval = undefined;
}

function pruneExpiredMessages(nowMs: number): void {
  const cutoffMs = nowMs - messageQueueTtlMs;

  for (let index = messageQueue.length - 1; index >= 0; index -= 1) {
    const createdAtMs = Date.parse(messageQueue[index].createdAt);

    if (createdAtMs <= cutoffMs) {
      messageQueue.splice(index, 1);
    }
  }
}

function getMessageQueueForResponse(): TrackedMessage[] {
  pruneExpiredMessages(Date.now());
  return messageQueue;
}

function clearListeningInactivityTimeout(): void {
  if (!listeningInactivityTimeout) {
    return;
  }

  clearTimeout(listeningInactivityTimeout);
  listeningInactivityTimeout = undefined;
}

function setSleepMode(reason: string): void {
  const didChangeMode = conversationMode !== "sleeping";

  conversationMode = "sleeping";
  pendingResponse = false;

  if (responseDebounceTimeout) {
    clearTimeout(responseDebounceTimeout);
    responseDebounceTimeout = undefined;
  }

  clearListeningInactivityTimeout();
  updatePresenceForMode();

  if (didChangeMode) {
    console.log(`[mode] sleeping (${reason})`);
  }
}

function refreshListeningInactivityTimeout(): void {
  if (conversationMode !== "listening") {
    return;
  }

  clearListeningInactivityTimeout();
  listeningInactivityTimeout = setTimeout(() => {
    setSleepMode("inactivity");
  }, listeningInactivityTimeoutMs);
}

function setListeningMode(reason: string): void {
  const didChangeMode = conversationMode !== "listening";

  conversationMode = "listening";
  refreshListeningInactivityTimeout();
  updatePresenceForMode();

  if (didChangeMode) {
    console.log(`[mode] awake (${reason})`);
  }
}

function updatePresenceForMode(): void {
  if (!client.user) {
    return;
  }

  if (conversationMode === "listening") {
    client.user.setPresence({ status: "online" });
    client.user.setActivity("👀", { type: ActivityType.Playing });
    return;
  }

  client.user.setPresence({ status: "online" });
  client.user.setActivity("zzz", { type: ActivityType.Playing });
}

function isPingingBen(message: {
  mentions: { users: Map<string, { id: string }> };
  author: { bot: boolean };
}): boolean {
  if (message.author.bot) {
    return false;
  }

  if (!client.user) {
    return false;
  }

  return message.mentions.users.has(client.user.id);
}

function pruneInactiveTyping(nowMs: number): void {
  for (const [userId, typedAtMs] of typingActivityByUserId) {
    if (nowMs - typedAtMs >= typingIndicatorTtlMs) {
      typingActivityByUserId.delete(userId);
    }
  }
}

function hasActiveTypingIndicator(): boolean {
  const nowMs = Date.now();
  pruneInactiveTyping(nowMs);

  for (const userId of typingActivityByUserId.keys()) {
    if (userId !== client.user?.id) {
      return true;
    }
  }

  return false;
}

function scheduleResponseDebounce(delayMs = responseDebounceDelayMs): void {
  if (!pendingResponse) {
    return;
  }

  if (responseDebounceTimeout) {
    clearTimeout(responseDebounceTimeout);
  }

  responseDebounceTimeout = setTimeout(() => {
    responseDebounceTimeout = undefined;
    void flushPendingResponse();
  }, delayMs);
}

function parseAssistantResponse(responseText: string): {
  responseLines: string[];
  shouldSleep: boolean;
} {
  let shouldSleep = false;

  const responseLines = responseText
    .split(/\r?\n/)
    .map((line) => {
      const sanitizedLine = line.replace(/\/stop\//gi, () => {
        shouldSleep = true;
        return "";
      });

      return sanitizedLine.trim();
    })
    .filter((line) => line.length > 0);

  return {
    responseLines,
    shouldSleep,
  };
}

async function generateAssistantResponse(): Promise<void> {
  const channel = await client.channels.fetch(requiredTargetChannelId);

  if (!channel || !channel.isSendable()) {
    console.warn("Target channel not found or is not sendable.");
    return;
  }

  let typingInterval: ReturnType<typeof setInterval> | undefined;

  try {
    await channel.sendTyping();
    typingInterval = setInterval(() => {
      void channel.sendTyping().catch((error: unknown) => {
        console.error("Failed to send typing indicator:", error);
      });
    }, 7000);

    const systemPrompt = await loadPrompt("message.txt");
    const activeMessageQueue = getMessageQueueForResponse();
    const combinedMessageQueue = combineConsecutiveMessages(activeMessageQueue);
    const openAiInput = formatOpenAiInput(combinedMessageQueue);

    const response = await openai.responses.create({
      model: openAiModel,
      reasoning: { effort: "none" },
      max_output_tokens: openAiMaxOutputTokens,
      instructions: systemPrompt,
      input: openAiInput,
    });

    const responseText = response.output_text?.trim();

    if (!responseText) {
      throw new Error("OpenAI returned no text output");
    }

    if (!response.usage) {
      throw new Error("OpenAI response did not include token usage");
    }

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const cachedInputTokens =
      response.usage.input_tokens_details?.cached_tokens ?? 0;
    const reasoningTokens =
      response.usage.output_tokens_details?.reasoning_tokens ?? 0;

    resetDailyTotalsIfNeeded();

    const requestSpendUsd = calculateRequestSpendUsd(
      inputTokens,
      cachedInputTokens,
      outputTokens,
    );

    runningInputTokens += inputTokens;
    runningOutputTokens += outputTokens;
    runningCachedInputTokens += cachedInputTokens;
    runningReasoningTokens += reasoningTokens;
    runningDailySpendUsd += requestSpendUsd;

    const dailyUsagePercent = calculateDailyUsagePercent(runningDailySpendUsd);

    const tokenReport = formatTokenReport(
      dailyUsagePercent,
      inputTokens,
      outputTokens,
    );

    await saveUsageState().catch((error: unknown) => {
      console.error("Failed to save usage state:", error);
    });

    await channel.send(tokenReport);

    const { responseLines, shouldSleep } = parseAssistantResponse(responseText);

    for (const [index, line] of responseLines.entries()) {
      if (index > 0) {
        await sleep(responseLineDelayMs);
      }

      const discordReadyLine = convertUsernamesToMentions(line);
      await channel.send(discordReadyLine);
    }

    if (shouldSleep) {
      setSleepMode("assistant /STOP/");
    }
  } catch (error) {
    console.error("Failed to generate OpenAI response:", error);
    await channel.send("my bad, i'm lagging a bit rn. try again in a sec?");
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
  }
}

async function flushPendingResponse(): Promise<void> {
  if (!pendingResponse) {
    return;
  }

  if (conversationMode !== "listening") {
    pendingResponse = false;
    return;
  }

  if (hasActiveTypingIndicator()) {
    scheduleResponseDebounce(typingRecheckDelayMs);
    return;
  }

  if (responseInProgress) {
    scheduleResponseDebounce();
    return;
  }

  responseInProgress = true;
  pendingResponse = false;

  try {
    await generateAssistantResponse();
  } finally {
    responseInProgress = false;

    if (pendingResponse) {
      scheduleResponseDebounce();
    }
  }
}

if (!token) {
  throw new Error("Missing DISCORD_TOKEN in environment");
}

if (!targetChannelId) {
  throw new Error("Missing DISCORD_TARGET_CHANNEL_ID in environment");
}

if (!openAiApiKey) {
  throw new Error("Missing OPENAI_API_KEY in environment");
}

const requiredTargetChannelId = targetChannelId;

const openai = new OpenAI({ apiKey: openAiApiKey });

function formatOpenAiInput(messages: TrackedMessage[]): Array<{
  role: "user" | "assistant";
  content: string;
}> {
  return messages.map(({ role, speakerName, content }) => {
    if (role === "assistant") {
      return { role, content };
    }

    return {
      role,
      content: `[${speakerName}] ${content}`,
    };
  });
}

function combineConsecutiveMessages(
  messages: TrackedMessage[],
): TrackedMessage[] {
  const combinedMessages: TrackedMessage[] = [];

  for (const message of messages) {
    const previousMessage = combinedMessages.at(-1);

    if (
      previousMessage &&
      previousMessage.role === message.role &&
      previousMessage.speakerName === message.speakerName
    ) {
      previousMessage.content = `${previousMessage.content}\n${message.content}`;
      previousMessage.createdAt = message.createdAt;
      continue;
    }

    combinedMessages.push({ ...message });
  }

  return combinedMessages;
}

function formatTokenReport(
  dailyUsagePercent: number,
  inputTokens: number,
  outputTokens: number,
): string {
  return `${tokenReportPrefix}${openAiModel}: ${dailyUsagePercent.toFixed(2)}% (${inputTokens}/${outputTokens} ${runningInputTokens}/${runningOutputTokens}/${runningCachedInputTokens}/${runningReasoningTokens})`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  updatePresenceForMode();

  const channel = await readyClient.channels.fetch(requiredTargetChannelId);

  if (!channel || !channel.isSendable()) {
    console.warn("Target channel not found or is not sendable.");
    return;
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.channelId !== requiredTargetChannelId) {
    return;
  }

  if (
    message.author.id === client.user?.id &&
    message.content.startsWith(tokenReportPrefix)
  ) {
    return;
  }

  const isAssistantMessage = message.author.id === client.user?.id;
  const role = isAssistantMessage ? "assistant" : "user";
  const speakerName = isAssistantMessage ? "ben" : message.author.username;

  typingActivityByUserId.delete(message.author.id);

  trackUser(message.author.id, message.author.username);

  for (const mentionedUser of message.mentions.users.values()) {
    trackUser(mentionedUser.id, mentionedUser.username);
  }

  const trackedContent = convertMentionsToUsernames(message.content);

  messageQueue.push({
    role,
    speakerName,
    content: trackedContent,
    createdAt: message.createdAt.toISOString(),
  });

  while (messageQueue.length > queueSize) {
    messageQueue.shift();
  }

  if (isPingingBen(message)) {
    setListeningMode("mentioned");
  }

  if (conversationMode === "listening") {
    refreshListeningInactivityTimeout();
  }

  if (responseInProgress) {
    return;
  }

  if (pendingResponse && conversationMode === "listening") {
    scheduleResponseDebounce();
  }

  if (message.author.bot) {
    return;
  }

  if (conversationMode !== "listening") {
    return;
  }

  pendingResponse = true;
  scheduleResponseDebounce();
});

client.on(Events.TypingStart, (typing) => {
  if (typing.channel.id !== requiredTargetChannelId) {
    return;
  }

  if (responseInProgress) {
    return;
  }

  if (conversationMode !== "listening") {
    return;
  }

  if (typing.user.bot) {
    return;
  }

  typingActivityByUserId.set(typing.user.id, Date.now());

  if (!pendingResponse) {
    return;
  }

  scheduleResponseDebounce();
});

async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  if (responseDebounceTimeout) {
    clearTimeout(responseDebounceTimeout);
    responseDebounceTimeout = undefined;
  }

  clearListeningInactivityTimeout();

  stopDailyResetMonitor();

  await saveUsageState().catch((error: unknown) => {
    console.error("Failed to save usage state during shutdown:", error);
  });

  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

async function start(): Promise<void> {
  await loadUsageState();
  startDailyResetMonitor();
  console.log("[mode] sleeping (startup)");
  await client.login(token);
}

void start().catch((error: unknown) => {
  console.error("Failed to start Ben:", error);
  process.exit(1);
});
