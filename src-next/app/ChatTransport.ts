export type ChatTransport = {
  /**
   * Sends a text message to a channel.
   *
   * @param channelId - Destination channel identifier.
   * @param text - Message content to send.
   * @returns A promise that resolves after delivery.
   */
  sendMessage(channelId: string, text: string): Promise<void>;

  /**
   * Adds a reaction to a message.
   *
   * @param channelId - Instigating message's channel identifier.
   * @param messageId - Message identifier.
   * @param emoji - Standard Unicode emoji to apply.
   * @returns A promise that resolves after the reaction is applied.
   */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * Refreshes the bot's typing indicator in a channel.
   *
   * @param channelId - Identifier of the active conversation channel.
   * @returns A promise that resolves after the indicator is sent.
   */
  sendTyping(channelId: string): Promise<void>;

  /**
   * Writes an operational status message to the configured destination.
   *
   * @param message - Short instruction or status text from the application.
   * @param details - Additional structured diagnostic data.
   * @returns A promise that resolves after the status is written.
   */
  logStatus(message: string, details?: Readonly<Record<string, unknown>>): Promise<void>;
};
