import type { ChatTransport } from "../app/ChatTransport.js";
import type { Logger } from "../logger.js";
import {
  ChannelMentionDirectory,
  resolveUnknownMentions,
  UserMentionDirectory,
} from "./DiscordDirectory.js";
import type { DiscordGateway } from "./DiscordGateway.js";
import { escapeBroadcastMentions } from "./mentions.js";

/** Sends application output through Discord with safe mention handling. */
export class DiscordTransport implements ChatTransport {
  /**
   * Creates a Discord chat transport.
   *
   * @param gateway - Discord output and lookup boundary.
   * @param users - Shared verified user mention directory.
   * @param channels - Shared verified channel mention directory.
   * @param logChannelId - Optional Discord destination for operational status.
   * @param logger - Logger used when optional status delivery is unavailable.
   */
  constructor(
    private readonly gateway: DiscordGateway,
    private readonly users: UserMentionDirectory,
    private readonly channels: ChannelMentionDirectory,
    private readonly logChannelId: string | undefined,
    private readonly logger: Pick<Logger, "debug">,
  ) {}

  /**
   * Sends a message after resolving verified user and channel names.
   *
   * @param channelId - Destination Discord channel identifier.
   * @param text - Message text to send.
   * @returns A promise that resolves after delivery.
   * @throws When the destination channel cannot be found or is not sendable.
   */
  async sendMessage(channelId: string, text: string): Promise<void> {
    const channel = await this.gateway.fetchChannel(channelId);
    if (channel === undefined) throw new Error("Discord response channel was not found.");

    this.channels.rememberChannel(channel);
    const safeText = escapeBroadcastMentions(text);
    await resolveUnknownMentions(this.gateway, channel, safeText, this.users, this.channels);
    const withChannels = this.channels.convertNamesToMentions(safeText);
    const withUsers = this.users.convertUsernamesToMentions(withChannels);
    await this.gateway.sendMessage(channelId, escapeBroadcastMentions(withUsers), {
      allowUserMentions: true,
    });
  }

  /**
   * Refreshes Discord's typing indicator.
   *
   * @param channelId - Channel where Ben is composing a response.
   * @returns A promise that resolves after the indicator is sent.
   */
  async sendTyping(channelId: string): Promise<void> {
    await this.gateway.sendTyping(channelId);
  }

  /**
   * Sends operational status without allowing any mentions.
   *
   * @param message - Operational status text.
   * @param details - Optional structured data logged when no status channel is configured.
   * @returns A promise that resolves after delivery or an intentional skip.
   */
  async logStatus(message: string, details?: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.logChannelId === undefined) {
      this.logger.debug("discord.status_skipped", { reason: "missing_channel", ...details });
      return;
    }
    await this.gateway.sendMessage(this.logChannelId, escapeBroadcastMentions(message), {
      allowUserMentions: false,
    });
  }
}
