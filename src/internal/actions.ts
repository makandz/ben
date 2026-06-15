import { readFile } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { extractReasoningSummary } from "../openai/reasoning.js";
import { OpenAIUsageStore } from "../openai/usageStore.js";
import { parseInternalStatusPayload, type InternalStatus } from "./statusSchema.js";

export type InternalActionResult =
  | {
      type: "status";
      status: InternalStatus;
      reasoningSummary?: string;
    }
  | {
      type: "failed";
      error: unknown;
    }
  | {
      type: "budget_exceeded";
      day: string;
      costUsd: number;
      budgetUsd: number;
    };

interface InternalActionDefinition {
  id: "status";
  promptPath: string;
  maxOutputTokens: number;
}

const statusAction: InternalActionDefinition = {
  id: "status",
  promptPath: path.join(process.cwd(), "src", "prompts", "internal", "status.txt"),
  maxOutputTokens: 96,
};

export class InternalActionRunner {
  private readonly client: OpenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly usageStore: OpenAIUsageStore,
  ) {
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
  }

  async runStatusAction(): Promise<InternalActionResult> {
    return this.runAction(statusAction);
  }

  private async runAction(action: InternalActionDefinition): Promise<InternalActionResult> {
    try {
      const budget = await this.usageStore.getBudgetStatus();

      if (budget.limited) {
        this.logger.warn("internal.budget_exceeded", {
          action: action.id,
          day: budget.day,
          costUsd: budget.costUsd,
          budgetUsd: budget.budgetUsd,
        });
        return {
          type: "budget_exceeded",
          day: budget.day,
          costUsd: budget.costUsd,
          budgetUsd: budget.budgetUsd,
        };
      }

      const instructions = await loadInternalPrompt(action.promptPath, this.logger);

      if (this.config.logPrompts) {
        this.logger.debug("internal.prompt", { action: action.id, instructions });
      }

      this.logger.info("internal.request", {
        action: action.id,
        model: this.config.openaiInternalModel,
        promptChars: instructions.length,
      });

      const response = await this.client.responses.create({
        model: this.config.openaiInternalModel,
        instructions,
        input: "Run the internal action now.",
        max_output_tokens: action.maxOutputTokens,
        reasoning: { effort: "low", summary: "concise" },
        store: false,
      });

      if (response.usage !== undefined) {
        const usage = await this.usageStore.record(this.config.openaiInternalModel, response.usage);

        this.logger.info("internal.usage", {
          action: action.id,
          day: usage.day,
          costUsd: usage.costUsd,
          totalCostUsd: usage.totalCostUsd,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        });
      } else {
        this.logger.warn("internal.usage_missing", { action: action.id });
      }

      const text = response.output_text.trim();
      const reasoningSummary = extractReasoningSummary(response.output);
      this.logger.info("internal.raw_response", { action: action.id, text });

      const result: InternalActionResult = {
        type: "status",
        status: parseInternalStatusPayload(text),
      };

      if (reasoningSummary !== undefined) {
        result.reasoningSummary = reasoningSummary;
      }

      return result;
    } catch (error) {
      this.logger.warn("internal.failed", { action: action.id, error: String(error) });
      return { type: "failed", error };
    }
  }
}

async function loadInternalPrompt(promptPath: string, logger: Logger): Promise<string> {
  try {
    const prompt = await readFile(promptPath, "utf8");
    logger.debug("internal.prompt_loaded", { path: promptPath, chars: prompt.length });
    return prompt;
  } catch (error) {
    logger.warn("internal.prompt_load_failed", { path: promptPath, error: String(error) });
    throw error;
  }
}
