export type DeliveredMessage = {
  id: string;
  createdAt: number;
};

export type SendMessageOptions = {
  replyTo?: string;
};

export type ChatTransport = {
  sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<DeliveredMessage>;
  sendTyping(channelId: string): Promise<void>;
  logStatus(message: string, details?: Readonly<Record<string, unknown>>): Promise<void>;
};
