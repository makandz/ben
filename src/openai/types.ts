import type { ResponseInputItem } from "openai/resources/responses/responses";

export type ApiMemory = ResponseInputItem[];

export interface RememberPersonToolInput {
  username: string;
  name: string;
}

export type RememberPersonToolResult =
  | {
      ok: true;
      username: string;
      name: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface SendChannelMessageToolInput {
  channel: string;
  text: string;
}

export type SendChannelMessageToolResult =
  | {
      ok: true;
      channel: string;
      channelId: string;
    }
  | {
      ok: false;
      error: string;
    };

export type ScheduledMessageRepeat = "none" | "daily" | "weekly";

export interface CreateScheduledMessageToolInput {
  message: string;
  targetUsernames: string[];
  channel: string | null;
  runDate: string;
  runTime: string;
  repeat: ScheduledMessageRepeat;
}

export type CreateScheduledMessageToolResult =
  | {
      ok: true;
      id: string;
      nextRunAt: string;
      repeat: ScheduledMessageRepeat;
      channel: string;
      targetUsernames: string[];
    }
  | {
      ok: false;
      error: string;
    };

export interface BotToolExecutor {
  rememberPerson(input: RememberPersonToolInput): Promise<RememberPersonToolResult>;
  sendChannelMessage(input: SendChannelMessageToolInput): Promise<SendChannelMessageToolResult>;
  createScheduledMessage(
    input: CreateScheduledMessageToolInput,
  ): Promise<CreateScheduledMessageToolResult>;
}

export type ResponderResult =
  | {
      type: "message";
      text: string;
      reactionEmoji?: string;
      reasoningSummary?: string;
      memoryItems: ApiMemory;
    }
  | {
      type: "reaction";
      emoji: string;
      reasoningSummary?: string;
      memoryItems: ApiMemory;
    }
  | {
      type: "wait";
      memoryItems: ApiMemory;
    }
  | {
      type: "sleep";
      summary: string;
      text?: string;
      reactionEmoji?: string;
    }
  | {
      type: "failed";
      error: unknown;
    }
  | {
      type: "budget_exceeded";
      costUsd: number;
      budgetUsd: number;
      day: string;
    };
