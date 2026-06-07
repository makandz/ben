import type { Client, Message } from "discord.js";

import type { HumanMessage } from "../bot/types.js";

export function toHumanMessage(message: Message, client: Client): HumanMessage | null {
  if (message.author.bot || message.author.id === client.user?.id) {
    return null;
  }

  return {
    id: message.id,
    channelId: message.channelId,
    username: message.author.username,
    content: message.content,
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
