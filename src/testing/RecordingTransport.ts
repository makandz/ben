import type { ChatTransport } from "../app/ChatTransport.js";

export type RecordedMessage = { channelId: string; text: string };

export type RecordedReaction = { channelId: string; messageId: string; emoji: string };

export type RecordedStatus = {
  message: string;
  details: Readonly<Record<string, unknown>> | undefined;
};

/** Records provider-neutral chat output for application behavior tests. */
export class RecordingTransport implements ChatTransport {
  readonly messages: RecordedMessage[] = [];
  readonly reactions: RecordedReaction[] = [];
  readonly typing: string[] = [];
  readonly statuses: RecordedStatus[] = [];

  /**
   * Records one sent message.
   *
   * @param channelId - Destination channel identifier.
   * @param text - Message content.
   * @returns A promise that resolves after recording.
   */
  async sendMessage(channelId: string, text: string): Promise<void> {
    this.messages.push({ channelId, text });
  }

  /**
   * Records one reaction.
   *
   * @param channelId - Destination channel identifier.
   * @param messageId - Reaction target identifier.
   * @param emoji - Reaction emoji.
   * @returns A promise that resolves after recording.
   */
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji });
  }

  /**
   * Records one typing refresh.
   *
   * @param channelId - Active channel identifier.
   * @returns A promise that resolves after recording.
   */
  async sendTyping(channelId: string): Promise<void> {
    this.typing.push(channelId);
  }

  /**
   * Records one operational status.
   *
   * @param message - Status label.
   * @param details - Optional structured status details.
   * @returns A promise that resolves after recording.
   */
  async logStatus(message: string, details?: Readonly<Record<string, unknown>>): Promise<void> {
    this.statuses.push({ message, details });
  }
}
