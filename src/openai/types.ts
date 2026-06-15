import type { ResponseInputItem } from "openai/resources/responses/responses";

export type ApiMemory = ResponseInputItem[];

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
