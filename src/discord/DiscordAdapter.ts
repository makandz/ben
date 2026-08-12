import type { HumanMessage } from "../app/types.js";
import type { Logger } from "../logger.js";
import { ChannelMentionDirectory, UserMentionDirectory } from "./DiscordDirectory.js";
import type {
  DiscordCommandEvent,
  DiscordGateway,
  DiscordMessageEvent,
  DiscordTypingEvent,
} from "./DiscordGateway.js";

export type DiscordInputHandlers = {
  handleMessage(message: HumanMessage, pinged: boolean): void;
  handleTyping(channelId: string, userId: string, username: string): void;
  handleReady?(username: string): void;
  handleCommand?(event: DiscordCommandEvent): void;
};

/** Owns Discord lifecycle events and translates inputs into application values. */
export class DiscordAdapter {
  /**
   * Creates and attaches the Discord input adapter.
   *
   * @param gateway - Discord client boundary that emits normalized events.
   * @param handlers - Application callbacks for messages, typing, and readiness.
   * @param users - Shared verified user mention directory.
   * @param channels - Shared verified channel mention directory.
   * @param logger - Structured logger used for Discord lifecycle events.
   */
  constructor(
    private readonly gateway: DiscordGateway,
    private readonly handlers: DiscordInputHandlers,
    private readonly users: UserMentionDirectory,
    private readonly channels: ChannelMentionDirectory,
    logger: Pick<Logger, "info" | "error">,
  ) {
    gateway.setHandlers({
      ready: (user) => {
        users.rememberUser(user);
        logger.info("discord.ready", { user: user.username });
        handlers.handleReady?.(user.username);
      },
      message: (message) => this.handleMessage(message),
      typing: (event) => this.handleTyping(event),
      command: (event) => handlers.handleCommand?.(event),
      error: (error) => logger.error("discord.error", { error: String(error) }),
    });
  }

  /**
   * Logs in after all Discord event handlers have been attached.
   *
   * @param token - Discord bot token.
   * @returns A promise that resolves when Discord login completes.
   */
  async start(token: string): Promise<void> {
    await this.gateway.login(token);
  }

  /**
   * Closes the Discord connection.
   *
   * @returns A promise that resolves after the client is destroyed.
   */
  async stop(): Promise<void> {
    await this.gateway.destroy();
  }

  /** Normalizes one human Discord message and forwards it to the application. */
  private handleMessage(message: DiscordMessageEvent): void {
    const botUser = this.gateway.getBotUser();
    if (message.author.bot || message.author.id === botUser?.id) return;

    this.users.rememberUser(message.author);
    for (const user of message.mentionedUsers) this.users.rememberUser(user);
    this.channels.rememberChannel(message.channel);
    for (const channel of message.mentionedChannels) this.channels.rememberChannel(channel);

    const withUsernames = this.users.convertMentionsToUsernames(message.content);
    const normalized: HumanMessage = {
      id: message.id,
      channelId: message.channel.id,
      userId: message.author.id,
      username: message.author.username,
      content: this.channels.convertMentionsToNames(withUsernames),
      createdAt: message.createdAt,
    };
    this.handlers.handleMessage(
      normalized,
      botUser !== undefined && message.mentionedUsers.some((user) => user.id === botUser.id),
    );
  }

  /** Filters and forwards one human Discord typing event. */
  private handleTyping(event: DiscordTypingEvent): void {
    const botUser = this.gateway.getBotUser();
    if (event.user.bot || event.user.id === botUser?.id) return;
    this.users.rememberUser(event.user);
    this.channels.rememberChannel(event.channel);
    this.handlers.handleTyping(event.channel.id, event.user.id, event.user.username);
  }
}
