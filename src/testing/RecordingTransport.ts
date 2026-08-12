import type { ChatTransport, DeliveredMessage } from "../app/ChatTransport.js";

export type RecordedMessage = { channelId: string; text: string };

export type RecordedStatus = {
  message: string;
  details: Readonly<Record<string, unknown>> | undefined;
};

/** Records provider-neutral chat output for application behavior tests. */
export class RecordingTransport implements ChatTransport {
  readonly messages: RecordedMessage[] = [];
  readonly typing: string[] = [];
  readonly statuses: RecordedStatus[] = [];
  private messageSequence = 0;

  /**
   * Records one sent message.
   *
   * @param channelId - Destination channel identifier.
   * @param text - Message content.
   * @returns A deterministic delivered-message identity for later assertions.
   */
  async sendMessage(channelId: string, text: string): Promise<DeliveredMessage> {
    this.messageSequence += 1;
    this.messages.push({ channelId, text });
    return { id: `sent-${String(this.messageSequence)}`, createdAt: this.messageSequence };
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
