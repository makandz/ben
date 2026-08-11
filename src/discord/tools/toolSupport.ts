import type { Logger } from "../../logger.js";
import type { ToolResult } from "../../tools/Tool.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { escapeBroadcastMentions } from "../mentions.js";

/**
 * Narrows unknown model arguments to a plain argument map.
 *
 * @param value - Untrusted tool arguments.
 * @returns The argument map, or an empty map for a non-object value.
 */
export function parseArguments(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reads and trims a model string argument.
 *
 * @param value - Untrusted argument value.
 * @param collapseWhitespace - Whether to replace internal whitespace runs with one space.
 * @returns Sanitized text, or an empty string for a non-string value.
 */
export function sanitizeText(value: unknown, collapseWhitespace = false): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return collapseWhitespace ? text.replace(/\s+/g, " ") : text;
}

/**
 * Normalizes an optional channel name for exact lookup.
 *
 * @param value - Untrusted channel-name argument.
 * @returns A lowercase channel name without leading hash marks.
 */
export function sanitizeChannelName(value: unknown): string {
  return sanitizeText(value).replace(/^#+/, "").trim().toLowerCase();
}

/**
 * Creates a continuing model-readable failure.
 *
 * @param error - Failure description returned to the model.
 * @returns A non-terminal tool result.
 */
export function toolFailure(error: string): ToolResult {
  return { type: "continue", result: { ok: false, error } };
}

/**
 * Sends a user-visible tool status while containing delivery failures.
 *
 * @param gateway - Discord message-delivery boundary.
 * @param logger - Warning logger for contained failures.
 * @param logEvent - Structured event name for delivery failures.
 * @param channelId - Active channel receiving the status.
 * @param text - User-visible status text.
 * @returns A promise that resolves after delivery or contained failure.
 */
export async function sendToolStatus(
  gateway: Pick<DiscordGateway, "sendMessage">,
  logger: Pick<Logger, "warn">,
  logEvent: string,
  channelId: string | undefined,
  text: string,
): Promise<void> {
  if (channelId === undefined) {
    logger.warn(logEvent, { error: "Missing channel ID" });
    return;
  }
  await gateway
    .sendMessage(channelId, escapeBroadcastMentions(text), { allowUserMentions: false })
    .catch((error: unknown) => logger.warn(logEvent, { error: String(error) }));
}
