import { ChannelType, TextChannel } from "discord.js";

/**
 * Utility function to check if a channel is a text channel.
 * @param channel - The channel to check.
 */
export const isTextChannel = (channel: any): channel is TextChannel =>
  channel && channel.isTextBased() && channel.type !== ChannelType.GroupDM;
