export type ChatTransport = {
  sendMessage(channelId: string, text: string): Promise<void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  logStatus(message: string, details?: Readonly<Record<string, unknown>>): Promise<void>;
};
