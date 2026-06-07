import OpenAI from "openai";
import type {
  ResponseInputItem,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { loadSystemPrompt } from "./systemPrompt.js";
import type { ApiMemory, ResponderResult } from "./types.js";
import { getModelPricing } from "./pricing.js";
import { OpenAIUsageStore } from "./usageStore.js";

export class OpenAIResponder {
  private readonly client: OpenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly usageStore: OpenAIUsageStore,
  ) {
    getModelPricing(config.openaiModel);
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
  }

  async respond(userPrompt: string, memory: ApiMemory): Promise<ResponderResult> {
    const userItem = createUserMessageItem(userPrompt);
    const input: ResponseInputItem[] = [...memory, userItem];
    const instructions = await loadSystemPrompt(this.logger);

    this.logger.info("openai.request", {
      inputItems: input.length,
      memoryItems: memory.length,
      promptChars: userPrompt.length,
      model: this.config.openaiModel,
    });

    if (this.config.logPrompts) {
      this.logger.debug("openai.prompt", { prompt: userPrompt, instructions });
    }

    try {
      const budget = await this.usageStore.getBudgetStatus();

      if (budget.limited) {
        this.logger.warn("openai.budget_exceeded", {
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

      const response = await this.client.responses.create({
        model: this.config.openaiModel,
        instructions,
        input,
        max_output_tokens: 512,
        reasoning: { effort: "low", summary: "concise" },
        include: ["reasoning.encrypted_content"],
        store: false,
      });

      if (response.usage !== undefined) {
        const usage = await this.usageStore.record(this.config.openaiModel, response.usage);

        this.logger.info("openai.usage", {
          day: usage.day,
          costUsd: usage.costUsd,
          totalCostUsd: usage.totalCostUsd,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        });
      } else {
        this.logger.warn("openai.usage_missing");
      }

      const text = response.output_text.trim();
      const reasoningSummary = extractReasoningSummary(response.output);

      if (text === "N/A") {
        this.logger.info("openai.response", { action: "sleep_na" });
        return { type: "sleep" };
      }

      this.logger.info("openai.response", {
        action: "message",
        chars: text.length,
        reasoningSummaryChars: reasoningSummary?.length ?? 0,
        outputItems: response.output.length,
      });

      const result: ResponderResult = {
        type: "message",
        text,
        memoryItems: [
          userItem,
          ...(stripReasoningSummaries(response.output) as ResponseInputItem[]),
        ],
      };

      if (reasoningSummary !== undefined) {
        result.reasoningSummary = reasoningSummary;
      }

      return result;
    } catch (error) {
      this.logger.warn("openai.failed", { error: String(error) });
      return { type: "failed", error };
    }
  }
}

function extractReasoningSummary(output: ResponseOutputItem[]): string | undefined {
  const text = output
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => item.summary)
    .map((summary) => summary.text.trim())
    .filter((summary) => summary.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > 0 ? text : undefined;
}

function stripReasoningSummaries(output: ResponseOutputItem[]): ResponseOutputItem[] {
  return output.map((item) => {
    if (item.type !== "reasoning") {
      return item;
    }

    return {
      ...item,
      summary: [],
    };
  });
}

function createUserMessageItem(text: string): ResponseInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}
