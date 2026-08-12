import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

import type {
  DiscordChannel,
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordInteractionResponse,
  DiscordMember,
  DiscordSendOptions,
  DiscordSentMessage,
  DiscordUser,
} from "./DiscordGateway.js";

const requiredIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageTyping,
  GatewayIntentBits.GuildMembers,
];

/** Adapts discord.js to Ben's small, provider-owned gateway contract. */
export class DiscordJsGateway implements DiscordGateway {
  private handlers: DiscordGatewayHandlers | undefined;

  /**
   * Creates the gateway and attaches discord.js event translation.
   *
   * @param client - Discord client to wrap; defaults to a client with Ben's required intents.
   */
  constructor(private readonly client = new Client({ intents: requiredIntents })) {
    client.once(Events.ClientReady, (readyClient) => {
      this.handlers?.ready(toUser(readyClient.user));
    });
    client.on(Events.MessageCreate, (message) => {
      this.handlers?.message({
        id: message.id,
        channel: toChannel(message.channel),
        author: toUser(message.author),
        content: message.content,
        createdAt: message.createdTimestamp,
        mentionedUsers: [...message.mentions.users.values()].map(toUser),
        mentionedChannels: [...message.mentions.channels.values()].map(toChannel),
      });
    });
    client.on(Events.TypingStart, (typing) => {
      if (typing.user.username === null) return;
      this.handlers?.typing({ channel: toChannel(typing.channel), user: toUser(typing.user) });
    });
    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      this.handlers?.command({
        name: interaction.commandName,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        reply: async (content) => {
          await interaction.reply(toInteractionResponse(content));
        },
        followUp: async (content) => {
          await interaction.followUp(toInteractionResponse(content));
        },
        defer: async (ephemeral) => {
          await interaction.deferReply({
            ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          });
        },
        deleteReply: async () => {
          await interaction.deleteReply();
        },
      });
    });
    client.on(Events.Error, (error) => {
      this.handlers?.error(error);
    });
  }

  /**
   * Registers the single set of application event handlers.
   *
   * @param handlers - Callbacks that receive normalized Discord events.
   */
  setHandlers(handlers: DiscordGatewayHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Logs the Discord client in.
   *
   * @param token - Discord bot token.
   * @returns A promise that resolves when login completes.
   */
  async login(token: string): Promise<void> {
    await this.client.login(token);
  }

  /**
   * Closes the Discord client.
   *
   * @returns A promise that resolves after the client is destroyed.
   */
  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  /**
   * Returns the current bot user after readiness.
   *
   * @returns Normalized bot user data, or `undefined` before readiness.
   */
  getBotUser(): DiscordUser | undefined {
    return this.client.user === null ? undefined : toUser(this.client.user);
  }

  /**
   * Fetches a channel without exposing discord.js channel types.
   *
   * @param channelId - Discord channel identifier.
   * @returns The normalized channel, or `undefined` when Discord returns no channel.
   */
  async fetchChannel(channelId: string): Promise<DiscordChannel | undefined> {
    const channel = await this.client.channels.fetch(channelId);
    return channel === null ? undefined : toChannel(channel);
  }

  /**
   * Searches members in one guild.
   *
   * @param guildId - Discord server identifier.
   * @param query - Username or display-name search text.
   * @returns Normalized candidate members returned by Discord.
   */
  async searchGuildMembers(guildId: string, query: string): Promise<readonly DiscordMember[]> {
    const guild = await this.client.guilds.fetch(guildId);
    const members = await guild.members.search({ query, limit: 10 });
    return [...members.values()].map((member) => ({
      ...toUser(member.user),
      displayName: member.displayName,
    }));
  }

  /**
   * Fetches the guild's named channels.
   *
   * @param guildId - Discord server identifier.
   * @returns Normalized channels currently visible to the bot.
   */
  async fetchGuildChannels(guildId: string): Promise<readonly DiscordChannel[]> {
    const guild = await this.client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    return [...channels.values()].flatMap((channel) =>
      channel === null ? [] : [toChannel(channel)],
    );
  }

  /**
   * Sends a message with an explicit allowed-mentions policy.
   *
   * @param channelId - Destination Discord channel identifier.
   * @param content - Final message content.
   * @param options - Whether verified user mention tags may notify users.
   * @returns A promise that resolves after delivery.
   * @throws When the destination channel is not sendable.
   */
  async sendMessage(
    channelId: string,
    content: string,
    options: DiscordSendOptions,
  ): Promise<DiscordSentMessage> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      throw new Error("Discord channel is not sendable.");
    }
    const message = await channel.send({
      content,
      allowedMentions: {
        parse: options.allowUserMentions ? ["users"] : [],
        repliedUser: false,
      },
      ...(options.replyToMessageId === undefined
        ? {}
        : {
            reply: {
              messageReference: options.replyToMessageId,
              failIfNotExists: false,
            },
          }),
    });
    return { id: message.id, createdAt: message.createdTimestamp };
  }

  /**
   * Adds a reaction to a message in a text-based channel.
   *
   * @param channelId - Channel containing the target message.
   * @param messageId - Discord identifier of the target message.
   * @param emoji - Unicode or custom Discord emoji identifier to add.
   * @returns A promise that resolves after Discord accepts the reaction.
   * @throws When the channel is unavailable or does not contain messages.
   */
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error("Discord reaction channel is not text-based.");
    }
    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
  }

  /**
   * Sends a typing indicator to a sendable channel.
   *
   * @param channelId - Destination Discord channel identifier.
   * @returns A promise that resolves after the indicator is sent.
   * @throws When the destination channel is not sendable.
   */
  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      throw new Error("Discord typing channel is not sendable.");
    }
    await channel.sendTyping();
  }

  /**
   * Applies Ben's online/idle state.
   *
   * @param status - Discord availability state.
   */
  setPresence(status: "idle" | "online"): void {
    this.client.user?.setPresence({ status });
  }

  /**
   * Sets or clears Ben's custom status activity without changing availability.
   *
   * @param content - Custom status text, or `undefined` to clear the activity.
   */
  setCustomStatus(content: string | undefined): void {
    this.client.user?.setPresence({
      activities: content === undefined ? [] : [{ name: content, type: ActivityType.Custom }],
    });
  }

  /**
   * Creates or refreshes one global application command.
   *
   * @param command - Global command name and description.
   * @returns Whether the command was newly registered or updated.
   */
  async registerCommand(command: {
    name: string;
    description: string;
  }): Promise<"registered" | "updated"> {
    const commands = await this.client.application?.commands.fetch();
    const existing = commands?.find((candidate) => candidate.name === command.name);
    if (existing === undefined) {
      await this.client.application?.commands.create(command);
      return "registered";
    }
    await existing.edit(command);
    return "updated";
  }
}

/** Translates provider-neutral visibility into current discord.js response flags. */
function toInteractionResponse(
  response: DiscordInteractionResponse,
): string | { content: string; flags?: MessageFlags.Ephemeral } {
  if (typeof response === "string") return response;
  return {
    content: response.content,
    ...(response.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

/** Converts the subset of a discord.js user needed by the application. */
function toUser(user: { id: string; username: string; bot: boolean }): DiscordUser {
  return { id: user.id, username: user.username, bot: user.bot };
}

/** Converts the subset of a discord.js channel needed by the application. */
function toChannel(channel: {
  id: string;
  isDMBased(): boolean;
  isSendable(): boolean;
  name?: string | null;
  guildId?: string;
}): DiscordChannel {
  const name =
    typeof channel.name === "string" && channel.name.length > 0 ? channel.name : undefined;
  const guildId = channel.isDMBased() ? undefined : channel.guildId;
  return {
    id: channel.id,
    sendable: channel.isSendable(),
    ...(name === undefined ? {} : { name }),
    ...(guildId === undefined ? {} : { guildId }),
  };
}
