export type DiscordUser = {
  id: string;
  username: string;
  bot: boolean;
};

export type DiscordMember = DiscordUser & {
  displayName: string;
};

export type DiscordChannel = {
  id: string;
  name?: string;
  guildId?: string;
  sendable?: boolean;
};

export type DiscordMessageEvent = {
  id: string;
  channel: DiscordChannel;
  author: DiscordUser;
  content: string;
  createdAt: number;
  mentionedUsers: readonly DiscordUser[];
  mentionedChannels: readonly DiscordChannel[];
};

export type DiscordTypingEvent = {
  channel: DiscordChannel;
  user: DiscordUser;
};

export type DiscordInteractionResponse = string | { content: string; ephemeral: boolean };

export type DiscordCommandEvent = {
  name: string;
  userId: string;
  channelId: string;
  reply(content: DiscordInteractionResponse): Promise<void>;
  followUp(content: DiscordInteractionResponse): Promise<void>;
  defer(ephemeral: boolean): Promise<void>;
  deleteReply(): Promise<void>;
};

export type DiscordCommandDefinition = {
  name: string;
  description: string;
};

export type DiscordSendOptions = {
  allowUserMentions: boolean;
  replyToMessageId?: string;
};

export type DiscordSentMessage = {
  id: string;
  createdAt: number;
};

export type DiscordGatewayHandlers = {
  ready(user: DiscordUser): void;
  message(message: DiscordMessageEvent): void;
  typing(event: DiscordTypingEvent): void;
  command(event: DiscordCommandEvent): void;
  error(error: unknown): void;
};

export type DiscordGateway = {
  setHandlers(handlers: DiscordGatewayHandlers): void;
  login(token: string): Promise<void>;
  destroy(): Promise<void>;
  getBotUser(): DiscordUser | undefined;
  fetchChannel(channelId: string): Promise<DiscordChannel | undefined>;
  searchGuildMembers(guildId: string, query: string): Promise<readonly DiscordMember[]>;
  fetchGuildChannels(guildId: string): Promise<readonly DiscordChannel[]>;
  sendMessage(
    channelId: string,
    content: string,
    options: DiscordSendOptions,
  ): Promise<DiscordSentMessage>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  setPresence(status: "idle" | "online"): void;
  setCustomStatus(content: string | undefined): void;
  registerCommand(command: DiscordCommandDefinition): Promise<"registered" | "updated">;
};
