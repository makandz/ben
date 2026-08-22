export type HumanMessage = {
  id: string;
  channelId: string;
  channelName?: string;
  userId: string;
  username: string;
  content: string;
  createdAt: number;
};

export type ConversationItem =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | { type: "reasoning" }
  | { type: "tool_call"; callId: string; name: string; arguments: unknown }
  | { type: "tool_result"; callId: string; result: unknown };

export type ToolCall = Extract<ConversationItem, { type: "tool_call" }>;

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ConversationOutcome =
  | {
      type: "reply";
      text: string;
      history: ConversationItem[];
    }
  | { type: "wait"; history: ConversationItem[] }
  | { type: "sleep"; summary: string }
  | { type: "failed"; error: unknown };
