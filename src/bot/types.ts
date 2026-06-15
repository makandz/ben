export interface HumanMessage {
  id: string;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  createdAt: number;
}

export type BotMode = "sleeping" | "awake" | "processing";
