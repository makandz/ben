import type { AgentInputItem } from "@openai/agents";
import type { Message } from "discord.js";

const DISCORD_MESSAGE_LIMIT = 2_000;

/**
 * Converts a Discord message into the user prompt stored in the agent history.
 *
 * @param message - Discord message to convert.
 * @param botUserId - Bot user id to strip from direct mentions.
 * @returns Prompt text, or `null` when the message has no usable content.
 */
export function buildPrompt(
  message: Message,
  botUserId?: string,
): string | null {
  const content = stripBotMention(message, botUserId).trim();
  const attachmentUrls = [...message.attachments.values()].map(
    (attachment) => attachment.url,
  );

  if (!content && attachmentUrls.length === 0) {
    return null;
  }

  const displayName =
    message.member?.displayName ??
    message.author.displayName ??
    message.author.username;
  const parts = [`${displayName} says:`];

  if (content) {
    parts.push(content);
  }

  if (attachmentUrls.length > 0) {
    parts.push(`Attachments:\n${attachmentUrls.join("\n")}`);
  }

  return parts.join("\n\n");
}

/**
 * Removes a direct bot mention so prompts and thread names do not repeat it.
 *
 * @param message - Discord message whose content should be cleaned.
 * @param botUserId - Bot user id to remove from mention markup.
 * @returns Message content without direct bot mentions.
 */
export function stripBotMention(message: Message, botUserId?: string): string {
  if (!botUserId) {
    return message.content;
  }

  return message.content
    .replaceAll(`<@${botUserId}>`, "")
    .replaceAll(`<@!${botUserId}>`, "");
}

/**
 * Builds a readable thread name from the message content with a safe length cap.
 *
 * @param message - Discord message used as the thread title source.
 * @param botUserId - Bot user id to remove from mention markup.
 * @returns Thread title trimmed to Discord-safe length.
 */
export function buildThreadName(message: Message, botUserId?: string): string {
  const cleaned = stripBotMention(message, botUserId).replace(/\s+/g, " ").trim();
  const base = cleaned || `chat-with-${message.author.username}`;
  return base.slice(0, 90);
}

/**
 * Wraps a user prompt in the Agents SDK message format.
 *
 * @param prompt - User prompt text.
 * @returns Agents SDK input item for a user message.
 */
export function createUserMessage(prompt: string): AgentInputItem {
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

/**
 * Wraps assistant output in the Agents SDK message format.
 *
 * @param text - Assistant reply text.
 * @returns Agents SDK input item for an assistant message.
 */
export function createAssistantMessage(text: string): AgentInputItem {
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

/**
 * Coerces final agent output into plain trimmed text for Discord delivery.
 *
 * @param output - Final agent output value.
 * @returns Trimmed text safe to send to Discord.
 */
export function extractResponseText(output: unknown): string {
  if (typeof output === "string") {
    return output.trim();
  }

  if (output == null) {
    return "";
  }

  return String(output).trim();
}

/**
 * Splits long replies into Discord-safe chunks while preferring natural boundaries.
 *
 * @param text - Reply text to split.
 * @returns Array of Discord-sized message chunks.
 */
export function splitForDiscord(text: string): string[] {
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
