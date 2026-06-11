import OpenAI from "openai";
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  Tool,
} from "openai/resources/responses/responses";

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { extractReasoningSummary } from "./reasoning.js";
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
        tools: botControlTools,
        tool_choice: "auto",
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

      this.logger.info("openai.raw_response", { text: response.output_text });

      const text = response.output_text.trim();
      const command = parseToolCommand(response.output);
      const reasoningSummary = extractReasoningSummary(response.output);
      const memoryItems = [
        userItem,
        ...createMemoryItems(response.output, command.toolCalls),
      ];

      if (text === "N/A") {
        this.logger.info("openai.response", { action: "sleep_na" });
        return { type: "sleep" };
      }

      if (command.reactionEmoji !== undefined && text.length === 0) {
        this.logger.info("openai.response", {
          action: command.sleep ? "reaction_sleep_command" : "reaction",
          emoji: command.reactionEmoji,
          memoryItems: memoryItems.length,
        });

        const result: ResponderResult = {
          type: "reaction",
          emoji: command.reactionEmoji,
          memoryItems,
        };

        if (command.sleep) {
          result.sleepAfter = true;
        }

        return result;
      }

      if (command.invalidReaction && text.length === 0 && !command.sleep) {
        this.logger.warn("openai.invalid_reaction_ignored", {
          memoryItems: memoryItems.length,
        });
        return {
          type: "wait",
          memoryItems,
        };
      }

      if (command.sleep && text.length === 0) {
        this.logger.info("openai.response", { action: "sleep_command" });
        return { type: "sleep" };
      }

      if (command.wait && text.length === 0) {
        this.logger.info("openai.response", {
          action: "wait_command",
          memoryItems: memoryItems.length,
        });
        return {
          type: "wait",
          memoryItems,
        };
      }

      this.logger.info("openai.response", {
        action: command.sleep ? "message_sleep_command" : "message",
        chars: text.length,
        reasoningSummaryChars: reasoningSummary?.length ?? 0,
        outputItems: response.output.length,
      });

      const result: ResponderResult = {
        type: "message",
        text,
        memoryItems,
      };

      if (command.sleep) {
        result.sleepAfter = true;
      }

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

const botControlTools = [
  {
    type: "function",
    name: "react_to_message",
    description:
      "React to the latest new human message with exactly one standard Unicode emoji instead of sending a text response.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        emoji: {
          type: "string",
          description: "Exactly one standard Unicode emoji.",
        },
      },
      required: ["emoji"],
    },
  },
  {
    type: "function",
    name: "wait_for_more_messages",
    description:
      "Stay awake and wait for follow-up messages without sending a text response.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "sleep_conversation",
    description:
      "Go back to sleep because the bot is no longer needed in the current conversation.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
] satisfies Tool[];

function parseToolCommand(output: ResponseOutputItem[]): {
  sleep: boolean;
  wait: boolean;
  reactionEmoji?: string;
  invalidReaction: boolean;
  toolCalls: ResponseFunctionToolCall[];
} {
  let sleep = false;
  let wait = false;
  let reactionEmoji: string | undefined;
  let invalidReaction = false;
  const toolCalls: ResponseFunctionToolCall[] = [];

  for (const item of output) {
    if (item.type !== "function_call") {
      continue;
    }

    if (!isBotControlToolName(item.name)) {
      continue;
    }

    toolCalls.push(item);

    if (item.name === "sleep_conversation") {
      sleep = true;
      continue;
    }

    if (item.name === "wait_for_more_messages") {
      wait = true;
      continue;
    }

    const args = parseFunctionArguments(item.arguments);
    const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";

    if (reactionEmoji === undefined && isSingleUnicodeEmoji(emoji)) {
      reactionEmoji = emoji;
    } else {
      invalidReaction = true;
    }
  }

  const command = { sleep, wait, invalidReaction, toolCalls };

  if (reactionEmoji === undefined) {
    return command;
  }

  return { ...command, reactionEmoji };
}

function isBotControlToolName(
  name: string,
): name is "react_to_message" | "wait_for_more_messages" | "sleep_conversation" {
  return (
    name === "react_to_message" ||
    name === "wait_for_more_messages" ||
    name === "sleep_conversation"
  );
}

function parseFunctionArguments(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args);

    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

function isSingleUnicodeEmoji(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];

  if (graphemes.length !== 1) {
    return false;
  }

  return (
    /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}\uFE0F\u200D]+$/u.test(
      value,
    ) || /^\p{Regional_Indicator}{2}$/u.test(value)
  );
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

function createMemoryItems(
  output: ResponseOutputItem[],
  toolCalls: readonly ResponseFunctionToolCall[],
): ResponseInputItem[] {
  const strippedOutput = stripReasoningSummaries(output) as ResponseInputItem[];

  return [
    ...strippedOutput,
    ...toolCalls.map((toolCall) => ({
      type: "function_call_output" as const,
      call_id: toolCall.call_id,
      output: JSON.stringify({ ok: true }),
    })),
  ];
}

function createUserMessageItem(text: string): ResponseInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}
