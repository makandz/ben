import type { Client, Message } from "discord.js";

import type { HumanMessage } from "../bot/types.js";
import type { ChannelMentionDirectory, UserMentionDirectory } from "./mentions.js";

export function toHumanMessage(
  message: Message,
  client: Client,
  mentionDirectory: UserMentionDirectory,
  channelDirectory: ChannelMentionDirectory,
): HumanMessage | null {
  if (message.author.bot || message.author.id === client.user?.id) {
    return null;
  }

  mentionDirectory.rememberMessageUsers(message);
  channelDirectory.rememberMessageChannels(message);
  const contentWithUsernames = mentionDirectory.convertMentionsToUsernames(message.content);

  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.author.id,
    username: message.author.username,
    content: channelDirectory.convertMentionsToNames(contentWithUsernames),
    createdAt: message.createdTimestamp,
  };
}

export function isPing(message: Message, client: Client): boolean {
  const botUser = client.user;

  if (!botUser) {
    return false;
  }

  return message.mentions.users.has(botUser.id);
}
