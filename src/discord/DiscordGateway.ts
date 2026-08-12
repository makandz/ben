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

export type DiscordCommandEvent = {
  name: string;
  reply(content: string | { content: string; ephemeral: boolean }): Promise<void>;
};

export type DiscordCommandDefinition = {
  name: string;
  description: string;
};

export type DiscordSendOptions = {
  allowUserMentions: boolean;
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
  sendMessage(channelId: string, content: string, options: DiscordSendOptions): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  setPresence(status: "idle" | "online"): void;
  registerCommand(command: DiscordCommandDefinition): Promise<"registered" | "updated">;
};
