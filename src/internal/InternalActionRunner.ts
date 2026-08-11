import { readFile } from "node:fs/promises";

import type { Logger } from "../logger.js";
import { ModelBudgetExceededError, type Model } from "../model/Model.js";
import { parseInternalStatusPayload, type InternalStatus } from "./InternalStatus.js";

export type InternalActionResult =
  | { type: "status"; status: InternalStatus; reasoningSummary?: string }
  | { type: "failed"; error: unknown }
  | { type: "budget_exceeded"; day: string; costUsd: number; budgetUsd: number };

/** Runs status generation through the shared provider-neutral model boundary. */
export class InternalActionRunner {
  /**
   * @param model - Shared provider-neutral model boundary.
   * @param logger - Structured internal-action logger.
   * @param logPrompts - Whether full internal instructions may be logged.
   * @param promptPath - Status prompt asset, replaceable for tests.
   */
  constructor(
    private readonly model: Model,
    private readonly logger: Pick<Logger, "debug" | "info" | "warn">,
    private readonly logPrompts: boolean,
    private readonly promptPath: URL = new URL("../prompts/internal/status.txt", import.meta.url),
  ) {}

  /** @returns A validated status or a controlled budget/failure result. */
  async runStatusAction(): Promise<InternalActionResult> {
    try {
      const instructions = await readFile(this.promptPath, "utf8");
      if (this.logPrompts) this.logger.debug("internal.prompt", { action: "status", instructions });
      this.logger.info("internal.request", { action: "status", promptChars: instructions.length });
      const turn = await this.model.invoke({
        instructions,
        history: [{ type: "message", role: "user", text: "Run the internal action now." }],
        tools: [],
      });
      const text = turn.items
        .filter((item): item is Extract<typeof item, { type: "message" }> =>
          item.type === "message" && item.role === "assistant")
        .map((item) => item.text)
        .join("\n")
        .trim();
      this.logger.info("internal.raw_response", { action: "status", text });
      const result: InternalActionResult = {
        type: "status",
        status: parseInternalStatusPayload(text),
        ...(turn.reasoningSummary === undefined ? {} : { reasoningSummary: turn.reasoningSummary }),
      };
      return result;
    } catch (error) {
      if (error instanceof ModelBudgetExceededError) {
        this.logger.warn("internal.budget_exceeded", {
          action: "status", day: error.day, costUsd: error.costUsd, budgetUsd: error.budgetUsd,
        });
        return {
          type: "budget_exceeded",
          day: error.day,
          costUsd: error.costUsd,
          budgetUsd: error.budgetUsd,
        };
      }
      this.logger.warn("internal.failed", { action: "status", error: String(error) });
      return { type: "failed", error };
    }
  }
}
