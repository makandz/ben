import type { ResponseInputItem } from "openai/resources/responses/responses";

export type ApiMemory = ResponseInputItem[];

export type ResponderResult =
  | {
      type: "message";
      text: string;
      reasoningSummary?: string;
      memoryItems: ApiMemory;
      sleepAfter?: boolean;
    }
  | {
      type: "wait";
      memoryItems: ApiMemory;
    }
  | {
      type: "sleep";
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
