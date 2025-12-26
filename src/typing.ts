import { TextChannel } from "discord.js";

export const BOT_WPM = 80;
export const MAX_TYPING_DURATION = 8000;
const CHARS_PER_WORD = 5;

/**
 * Calculate the typing duration for a message based on WPM.
 * @param message - The message to calculate typing duration for.
 * @returns The typing duration in milliseconds, capped at MAX_TYPING_DURATION.
 */
export const calculateTypingDuration = (message: string): number => {
  const charCount = message.length;
  const wordCount = charCount / CHARS_PER_WORD;
  const minutesToType = wordCount / BOT_WPM;
  const msToType = minutesToType * 60 * 1000;

  return Math.min(msToType, MAX_TYPING_DURATION);
};

/**
 * Sleep for a given number of milliseconds.
 * @param ms - The number of milliseconds to sleep.
 * @returns A promise that resolves after the given time.
 */
const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Simulate typing in a channel for a message.
 * Triggers the typing indicator and waits for the calculated duration.
 * @param channel - The channel to simulate typing in.
 * @param message - The message being "typed" (used to calculate duration).
 */
export const simulateTyping = async (
  channel: TextChannel,
  message: string
): Promise<void> => {
  const duration = calculateTypingDuration(message);
  await channel.sendTyping();
  await sleep(duration);
};
