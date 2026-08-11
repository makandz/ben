import type { HumanMessage } from "../app/types.js";
import type { Logger } from "../logger.js";
import { ChannelMentionDirectory, UserMentionDirectory } from "./DiscordDirectory.js";
import type { DiscordGateway, DiscordMessageEvent, DiscordTypingEvent } from "./DiscordGateway.js";

/** Application callbacks for normalized Discord input. */
export type DiscordInputHandlers = {
  /**
   * Receives a normalized human message and direct-ping state.
   *
   * @param message - Provider-neutral human message.
   * @param pinged - Whether the message directly mentioned Ben.
   */
  handleMessage(message: HumanMessage, pinged: boolean): void;
  /**
   * Receives normalized human typing activity.
   *
   * @param channelId - Channel containing the typing activity.
   * @param userId - Typing user's Discord identifier.
   * @param username - Typing user's Discord username.
   */
  handleTyping(channelId: string, userId: string, username: string): void;
  /**
   * Receives the bot username when the Discord client becomes ready.
   *
   * @param username - Ready bot username.
   */
  handleReady?(username: string): void;
  /** Receives normalized Discord application commands. */
  handleCommand?(name: string, reply: (content: string | { content: string; ephemeral: boolean }) => Promise<void>): void;
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
    private readonly logger: Pick<Logger, "info" | "error">,
  ) {
    gateway.setHandlers({
      ready: (user) => {
        users.rememberUser(user);
        logger.info("discord.ready", { user: user.username });
        handlers.handleReady?.(user.username);
      },
      message: (message) => this.handleMessage(message),
      typing: (event) => this.handleTyping(event),
      command: (event) => handlers.handleCommand?.(event.name, event.reply),
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
