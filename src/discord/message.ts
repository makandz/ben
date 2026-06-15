import type { Client, Message } from "discord.js";

import type { HumanMessage } from "../bot/types.js";
import type { UserMentionDirectory } from "./mentions.js";

export function toHumanMessage(
  message: Message,
  client: Client,
  mentionDirectory: UserMentionDirectory,
): HumanMessage | null {
  if (message.author.bot || message.author.id === client.user?.id) {
    return null;
  }

  mentionDirectory.rememberMessageUsers(message);

  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.author.id,
    username: message.author.username,
    content: mentionDirectory.convertMentionsToUsernames(message.content),
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
