import type { ConversationItem, TokenUsage } from "../app/types.js";
import type { ToolDefinition } from "../tools/Tool.js";

export type ModelRequest = {
  instructions: string;
  history: readonly ConversationItem[];
  tools: readonly ToolDefinition[];
};

export type ModelTurn = {
  items: ConversationItem[];
  reasoningSummary?: string;
  usage?: TokenUsage;
};

export type Model = {
  invoke(request: ModelRequest): Promise<ModelTurn>;
};

/** Provider-neutral error raised when a configured daily model budget is exhausted. */
export class ModelBudgetExceededError extends Error {
  readonly name = "ModelBudgetExceededError";

  /**
   * Creates an error containing the budget state needed by application callers.
   *
   * @param day - Local usage day whose limit was reached.
   * @param costUsd - Cost already recorded for the day.
   * @param budgetUsd - Configured daily cost limit.
   */
  constructor(
    readonly day: string,
    readonly costUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`Daily model budget reached (${String(costUsd)} / ${String(budgetUsd)}) on ${day}`);
  }
}
