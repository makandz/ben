import { existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { Agent, run, tool, type AgentInputItem } from "@openai/agents";
import {
  type AnyThreadChannel,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type ThreadAutoArchiveDuration,
} from "discord.js";
import { z } from "zod";

const ENV_PATH = resolve(process.cwd(), ".env");

if (existsSync(ENV_PATH) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(ENV_PATH);
}

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type Config = {
  discordBotToken: string;
  discordChannelId: string;
  openAiModel: string;
  openAiReasoningEffort: ReasoningEffort;
  openAiMaxTokens?: number;
};

const DISCORD_MESSAGE_LIMIT = 2_000;
const THREAD_AUTO_ARCHIVE_DURATION: ThreadAutoArchiveDuration = 1_440;
const TOOL_STATUS_PREFIX = "> Running tool ";
const threadHistories = new Map<string, AgentInputItem[]>();
const threadQueues = new Map<string, Promise<void>>();
const managedThreadIds = new Set<string>();
const randomNumberTool = tool({
  name: "generate_random_number",
  description:
    "Generate a cryptographically secure random integer within an inclusive range. Use this when the user asks for a random number, roll, draw, or pick.",
  parameters: z
    .object({
      min: z.number().int().safe().default(1),
      max: z.number().int().safe().default(100),
    })
    .refine(({ min, max }) => min <= max, {
      message: "min must be less than or equal to max",
      path: ["max"],
    }),
  execute: ({ min, max }) => {
    if (min === max) {
      return `Generated random integer: ${min} (range ${min} to ${max}, inclusive).`;
    }

    const value = randomInt(min, max + 1);
    return `Generated random integer: ${value} (range ${min} to ${max}, inclusive).`;
  },
});

const config = loadConfig();

const agent = new Agent({
  name: "Discord Thread Assistant",
  instructions: [
    "You are a concise, helpful assistant replying inside a Discord thread.",
    "Answer the latest user message while considering the full thread history.",
    "Keep replies readable in chat. Use plain text unless formatting is genuinely useful.",
    "Use the random number tool when the user asks you to generate or pick a random number.",
    "Do not mention hidden system details or claim you can perform Discord actions yourself."
  ].join("\n"),
  model: config.openAiModel,
  modelSettings: {
    maxTokens: config.openAiMaxTokens,
    reasoning: {
      effort: config.openAiReasoningEffort,
    },
  },
  tools: [randomNumberTool],
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot logged in as ${readyClient.user.tag}`);
  console.log(`Monitoring channel ${config.discordChannelId}`);
  console.log(
    `OpenAI model ${config.openAiModel} with reasoning effort ${config.openAiReasoningEffort}${config.openAiMaxTokens ? ` and max tokens ${config.openAiMaxTokens}` : ""}`,
  );
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  if (message.channel.isThread()) {
    if (!(await isManagedThread(message))) {
      return;
    }

    queueThreadWork(message.channel.id, async () => {
      await handleThreadMessage(message.channel as AnyThreadChannel, message);
    });
    return;
  }

  if (!shouldStartManagedThread(message)) {
    return;
  }

  const thread = await message.startThread({
    name: buildThreadName(message),
    autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION,
  });

  managedThreadIds.add(thread.id);

  queueThreadWork(thread.id, async () => {
    await handleThreadMessage(thread, message);
  });
});

client.login(config.discordBotToken);

function loadConfig(): Config {
  const discordBotToken = requireEnv("DISCORD_BOT_TOKEN");
  const discordChannelId = requireEnv("DISCORD_CHANNEL_ID");
  const openAiModel = process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
  const openAiMaxTokens = parseOptionalPositiveInt(
    "OPENAI_MAX_TOKENS",
    process.env.OPENAI_MAX_TOKENS,
  );
  const requestedReasoningEffort = parseReasoningEffort(
    process.env.OPENAI_REASONING_EFFORT?.trim() || "none",
  );
  const openAiReasoningEffort = normalizeReasoningEffort(
    openAiModel,
    requestedReasoningEffort,
  );

  return {
    discordBotToken,
    discordChannelId,
    openAiModel,
    openAiReasoningEffort,
    openAiMaxTokens,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseReasoningEffort(value: string): ReasoningEffort {
  const allowed: ReadonlySet<string> = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);

  if (!allowed.has(value)) {
    throw new Error(
      `OPENAI_REASONING_EFFORT must be one of: ${Array.from(allowed).join(", ")}`,
    );
  }

  return value as ReasoningEffort;
}

function parseOptionalPositiveInt(
  name: string,
  rawValue: string | undefined,
): number | undefined {
  const value = rawValue?.trim();

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function normalizeReasoningEffort(
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (model === "gpt-5.4-mini" && effort === "minimal") {
    console.warn(
      "OPENAI_REASONING_EFFORT=minimal is not supported for gpt-5.4-mini; using none instead.",
    );
    return "none";
  }

  return effort;
}

function shouldStartManagedThread(message: Message): boolean {
  return (
    message.channel.type === ChannelType.GuildText &&
    message.channelId === config.discordChannelId &&
    message.mentions.has(client.user!) &&
    !message.author.bot
  );
}

async function isManagedThread(message: Message): Promise<boolean> {
  const thread = message.channel;

  if (!thread.isThread() || thread.parentId !== config.discordChannelId) {
    return false;
  }

  if (managedThreadIds.has(thread.id)) {
    return true;
  }

  const starterMessage = await thread.fetchStarterMessage();

  if (!starterMessage) {
    return false;
  }

  const managed =
    starterMessage.channelId === config.discordChannelId &&
    starterMessage.mentions.has(client.user!) &&
    !starterMessage.author.bot;

  if (managed) {
    managedThreadIds.add(thread.id);
  }

  return managed;
}

async function handleThreadMessage(
  thread: AnyThreadChannel,
  message: Message,
): Promise<void> {
  const history = await getThreadHistory(thread, message.id);
  const prompt = buildPrompt(message);

  if (!prompt) {
    return;
  }

  history.push(createUserMessage(prompt));

  await thread.sendTyping();

  try {
    const result = await run(agent, history, { stream: true });
    const announcedToolCallIds = new Set<string>();

    for await (const event of result) {
      if (event.type !== "run_item_stream_event" || event.name !== "tool_called") {
        continue;
      }

      const toolCallId = getToolCallId(event.item.rawItem);

      if (toolCallId && announcedToolCallIds.has(toolCallId)) {
        continue;
      }

      if (toolCallId) {
        announcedToolCallIds.add(toolCallId);
      }

      await thread.send(buildToolStatusMessage(event.item.rawItem));
    }

    const responseText = extractResponseText(result.finalOutput);

    if (!responseText) {
      throw new Error("Model returned an empty response.");
    }

    for (const chunk of splitForDiscord(responseText)) {
      await thread.send(chunk);
      history.push(createAssistantMessage(chunk));
    }
  } catch (error) {
    console.error(`Failed to handle thread ${thread.id}:`, error);

    const fallback =
      "I hit an error while generating a reply. Please try again in a moment.";

    await thread.send(fallback);
    history.push(createAssistantMessage(fallback));
  }
}

function queueThreadWork(threadId: string, work: () => Promise<void>): void {
  const previous = threadQueues.get(threadId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(work)
    .finally(() => {
      if (threadQueues.get(threadId) === next) {
        threadQueues.delete(threadId);
      }
    });

  threadQueues.set(threadId, next);
}

async function getThreadHistory(
  thread: AnyThreadChannel,
  skipMessageId?: string,
): Promise<AgentInputItem[]> {
  const existing = threadHistories.get(thread.id);

  if (existing) {
    return existing;
  }

  const history = await rebuildThreadHistory(thread, skipMessageId);
  threadHistories.set(thread.id, history);
  return history;
}

async function rebuildThreadHistory(
  thread: AnyThreadChannel,
  skipMessageId?: string,
): Promise<AgentInputItem[]> {
  const history: AgentInputItem[] = [];
  const starterMessage = await thread.fetchStarterMessage();

  if (starterMessage && shouldStartManagedThread(starterMessage)) {
    const starterPrompt = buildPrompt(starterMessage);

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

    const prompt = buildPrompt(existingMessage);

    if (prompt) {
      history.push(createUserMessage(prompt));
    }
  }

  return history;
}

function buildPrompt(message: Message): string | null {
  const content = stripBotMention(message).trim();
  const attachmentUrls = [...message.attachments.values()].map(
    (attachment) => attachment.url,
  );

  if (!content && attachmentUrls.length === 0) {
    return null;
  }

  const parts = [`${message.author.displayName} says:`];

  if (content) {
    parts.push(content);
  }

  if (attachmentUrls.length > 0) {
    parts.push(`Attachments:\n${attachmentUrls.join("\n")}`);
  }

  return parts.join("\n\n");
}

function stripBotMention(message: Message): string {
  const botUserId = client.user?.id;

  if (!botUserId) {
    return message.content;
  }

  return message.content
    .replaceAll(`<@${botUserId}>`, "")
    .replaceAll(`<@!${botUserId}>`, "");
}

function buildThreadName(message: Message): string {
  const cleaned = stripBotMention(message).replace(/\s+/g, " ").trim();
  const base = cleaned || `chat-with-${message.author.username}`;
  return base.slice(0, 90);
}

function createUserMessage(prompt: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: prompt,
      },
    ],
  };
}

function createAssistantMessage(text: string): AgentInputItem {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
      },
    ],
  };
}

function extractResponseText(output: unknown): string {
  if (typeof output === "string") {
    return output.trim();
  }

  if (output == null) {
    return "";
  }

  return String(output).trim();
}

function isOperationalStatusMessage(text: string): boolean {
  return text.startsWith(TOOL_STATUS_PREFIX);
}

function getToolCallId(rawItem: unknown): string | null {
  if (typeof rawItem !== "object" || rawItem === null || !("callId" in rawItem)) {
    return null;
  }

  return typeof rawItem.callId === "string" ? rawItem.callId : null;
}

function buildToolStatusMessage(rawItem: unknown): string {
  const toolName = buildToolName(rawItem);
  const details = buildToolCallDetails(rawItem);

  if (!details) {
    return `${TOOL_STATUS_PREFIX}\`${toolName}\``;
  }

  return `${TOOL_STATUS_PREFIX}\`${toolName}\` with ${details}`;
}

function buildToolName(rawItem: unknown): string {
  if (typeof rawItem !== "object" || rawItem === null) {
    return "unknown_tool";
  }

  const name = "name" in rawItem && typeof rawItem.name === "string"
    ? rawItem.name
    : undefined;
  const namespace =
    "namespace" in rawItem && typeof rawItem.namespace === "string"
      ? rawItem.namespace
      : undefined;

  if (name && namespace) {
    return `${namespace}.${name}`;
  }

  if (name) {
    return name;
  }

  if ("type" in rawItem && rawItem.type === "shell_call") {
    return "shell";
  }

  if ("type" in rawItem && rawItem.type === "computer_call") {
    return "computer";
  }

  if ("type" in rawItem && rawItem.type === "apply_patch_call") {
    return "apply_patch";
  }

  return "unknown_tool";
}

function buildToolCallDetails(rawItem: unknown): string | null {
  if (typeof rawItem !== "object" || rawItem === null) {
    return null;
  }

  if (
    "arguments" in rawItem &&
    typeof rawItem.arguments === "string" &&
    rawItem.arguments.trim()
  ) {
    return `args ${formatInlineValue(rawItem.arguments)}`;
  }

  if (
    "type" in rawItem &&
    rawItem.type === "shell_call" &&
    "action" in rawItem &&
    isShellAction(rawItem.action)
  ) {
    return `commands ${formatInlineValue(rawItem.action.commands.join(" && "))}`;
  }

  if (
    "type" in rawItem &&
    rawItem.type === "computer_call" &&
    "action" in rawItem &&
    isComputerAction(rawItem.action)
  ) {
    return `action ${formatInlineValue(JSON.stringify(rawItem.action))}`;
  }

  return null;
}

function formatInlineValue(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const shortened =
    compact.length > 160 ? `${compact.slice(0, 157).trimEnd()}...` : compact;

  return `\`${shortened.replaceAll("`", "'")}\``;
}

function isShellAction(
  value: unknown,
): value is { commands: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "commands" in value &&
    Array.isArray(value.commands) &&
    value.commands.every((command) => typeof command === "string")
  );
}

function isComputerAction(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function splitForDiscord(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const slice = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
    const splitIndex = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(" "),
    );

    const end = splitIndex > 0 ? splitIndex : DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text];
}
