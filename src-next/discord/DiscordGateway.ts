/** Normalized Discord user data used outside the discord.js adapter. */
export type DiscordUser = {
  id: string;
  username: string;
  bot: boolean;
};

/** Normalized server member data used for name resolution. */
export type DiscordMember = DiscordUser & {
  displayName: string;
};

/** Normalized Discord channel data used by input, output, and lookup code. */
export type DiscordChannel = {
  id: string;
  name?: string;
  guildId?: string;
  sendable?: boolean;
};

/** Normalized Discord message event delivered to the input adapter. */
export type DiscordMessageEvent = {
  id: string;
  channel: DiscordChannel;
  author: DiscordUser;
  content: string;
  createdAt: number;
  mentionedUsers: readonly DiscordUser[];
  mentionedChannels: readonly DiscordChannel[];
};

/** Normalized Discord typing event delivered to the input adapter. */
export type DiscordTypingEvent = {
  channel: DiscordChannel;
  user: DiscordUser;
};

/** Normalized application-command interaction delivered by Discord. */
export type DiscordCommandEvent = {
  name: string;
  reply(content: string | { content: string; ephemeral: boolean }): Promise<void>;
};

/** Global application-command definition owned by the application. */
export type DiscordCommandDefinition = {
  name: string;
  description: string;
};

/** Allowed-mention policy for one Discord message. */
export type DiscordSendOptions = {
  allowUserMentions: boolean;
};

/** Event callbacks registered with the Discord client boundary. */
export type DiscordGatewayHandlers = {
  ready(user: DiscordUser): void;
  message(message: DiscordMessageEvent): void;
  typing(event: DiscordTypingEvent): void;
  command(event: DiscordCommandEvent): void;
  error(error: unknown): void;
};

/** Small Discord client boundary owned by the application. */
export type DiscordGateway = {
  setHandlers(handlers: DiscordGatewayHandlers): void;
  login(token: string): Promise<void>;
  destroy(): Promise<void>;
  getBotUser(): DiscordUser | undefined;
  fetchChannel(channelId: string): Promise<DiscordChannel | undefined>;
  searchGuildMembers(
    guildId: string,
    query: string,
  ): Promise<readonly DiscordMember[]>;
  fetchGuildChannels(guildId: string): Promise<readonly DiscordChannel[]>;
  sendMessage(
    channelId: string,
    content: string,
    options: DiscordSendOptions,
  ): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  setPresence(status: "idle" | "online", activity?: string): void;
  registerCommand(command: DiscordCommandDefinition): Promise<"registered" | "updated">;
};
