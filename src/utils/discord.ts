import { TextChannel, type Channel } from "discord.js";

/**
 * Check if a channel is a guild text channel.
 * @param channel - The channel to check.
 * @returns True if the channel is a guild text channel, false otherwise.
 */
export const isGuildTextChannel = (
  channel: Channel | null
): channel is TextChannel => {
  return channel instanceof TextChannel;
};
