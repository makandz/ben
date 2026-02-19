import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import { loadPrompt } from "./prompts/load-prompt.js";

const token = process.env.DISCORD_TOKEN;
const targetChannelId = process.env.DISCORD_TARGET_CHANNEL_ID;
const queueSizeRaw = process.env.DISCORD_MESSAGE_QUEUE_SIZE;
const openAiApiKey = process.env.OPENAI_API_KEY;
const tokenReportPrefix = "> 🤖 ";

type TrackedMessage = {
  userName: string;
  content: string;
  createdAt: string;
};

const messageQueue: TrackedMessage[] = [];
let runningInputTokens = 0;
let runningOutputTokens = 0;

if (!token) {
  throw new Error("Missing DISCORD_TOKEN in environment");
}

if (!targetChannelId) {
  throw new Error("Missing DISCORD_TARGET_CHANNEL_ID in environment");
}

if (!queueSizeRaw) {
  throw new Error("Missing DISCORD_MESSAGE_QUEUE_SIZE in environment");
}

if (!openAiApiKey) {
  throw new Error("Missing OPENAI_API_KEY in environment");
}

const queueSize = Number.parseInt(queueSizeRaw, 10);

if (!Number.isInteger(queueSize) || queueSize <= 0) {
  throw new Error("DISCORD_MESSAGE_QUEUE_SIZE must be a positive integer");
}

const openai = new OpenAI({ apiKey: openAiApiKey });

function formatMessageLog(messages: TrackedMessage[]): string {
  return messages
    .map(({ userName, content }) => `${userName}: ${content.replaceAll("\n", " ")}`)
    .join("\n");
}

function formatTokenReport(
  inputTokens: number,
  outputTokens: number,
  runningInput: number,
  runningOutput: number,
): string {
  return `${tokenReportPrefix}msg in:${inputTokens.toLocaleString()} out:${outputTokens.toLocaleString()} | session in:${runningInput.toLocaleString()} out:${runningOutput.toLocaleString()}`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ben is online as ${readyClient.user.tag}`);

  const channel = await readyClient.channels.fetch(targetChannelId);

  if (!channel || !channel.isSendable()) {
    console.warn("Target channel not found or is not sendable.");
    return;
  }

  await channel.send("Hey! I'm online.");
});

client.on(Events.MessageCreate, async (message) => {
  if (message.channelId !== targetChannelId) {
    return;
  }

  if (
    message.author.id === client.user?.id &&
    message.content.startsWith(tokenReportPrefix)
  ) {
    return;
  }

  const userName =
    message.author.id === client.user?.id
      ? "ben"
      : message.author.username;

  messageQueue.push({
    userName,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  });

  while (messageQueue.length > queueSize) {
    messageQueue.shift();
  }

  console.log("Tracked messages:", JSON.stringify(messageQueue, null, 2));

  if (message.author.bot) {
    return;
  }

  let typingInterval: ReturnType<typeof setInterval> | undefined;

  try {
    await message.channel.sendTyping();
    typingInterval = setInterval(() => {
      void message.channel.sendTyping().catch((error: unknown) => {
        console.error("Failed to send typing indicator:", error);
      });
    }, 7000);

    const systemPrompt = await loadPrompt("message.txt");
    const messageLog = formatMessageLog(messageQueue);

    const response = await openai.responses.create({
      model: "gpt-5-mini",
      reasoning: { effort: "minimal" },
      instructions: systemPrompt,
      input: messageLog,
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

    runningInputTokens += inputTokens;
    runningOutputTokens += outputTokens;

    const tokenReport = formatTokenReport(
      inputTokens,
      outputTokens,
      runningInputTokens,
      runningOutputTokens,
    );

    await message.channel.send(tokenReport);

    const responseLines = responseText
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    for (const line of responseLines) {
      await message.channel.send(line);
    }
  } catch (error) {
    console.error("Failed to generate OpenAI response:", error);
    await message.channel.send("my bad, i'm lagging a bit rn. try again in a sec?");
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
  }
});

client.login(token);
