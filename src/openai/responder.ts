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
import type {
  ApiMemory,
  BotToolExecutor,
  CreateScheduledMessageToolInput,
  RememberPersonToolInput,
  ResponderResult,
  SendChannelMessageToolInput,
} from "./types.js";
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

  async respond(
    userPrompt: string,
    memory: ApiMemory,
    toolExecutor: BotToolExecutor,
  ): Promise<ResponderResult> {
    const userItem = createUserMessageItem(userPrompt);
    const turnItems: ResponseInputItem[] = [userItem];
    const instructions = await loadSystemPrompt(this.logger);

    this.logger.info("openai.request", {
      inputItems: memory.length + turnItems.length,
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

      for (let toolIteration = 0; toolIteration < 5; toolIteration += 1) {
        const input: ResponseInputItem[] = [...memory, ...turnItems];
        const response = await this.client.responses.create({
          model: this.config.openaiModel,
          instructions,
          input,
          tools: botControlTools,
          tool_choice: "required",
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

        const reasoningSummary = extractReasoningSummary(response.output);
        turnItems.push(...(stripReasoningSummaries(response.output) as ResponseInputItem[]));

        const toolCalls = response.output.filter(isBotControlToolCall);

        if (toolCalls.length !== 1) {
          this.logger.warn("openai.invalid_tool_call_count", { count: toolCalls.length });
          turnItems.push(
            ...toolCalls.map((toolCall) =>
              createFunctionCallOutput(toolCall, {
                ok: false,
                error: "expected exactly one tool call",
              }),
            ),
          );
          return {
            type: "wait",
            memoryItems: turnItems,
          };
        }

        const toolCall = toolCalls[0];

        if (toolCall === undefined) {
          return {
            type: "wait",
            memoryItems: turnItems,
          };
        }

        if (toolCall.name === "remember_person") {
          const result = await executeRememberPersonTool(toolCall, toolExecutor, this.logger);
          turnItems.push(createFunctionCallOutput(toolCall, result));
          continue;
        }

        if (toolCall.name === "create_scheduled_message") {
          const result = await executeCreateScheduledMessageTool(
            toolCall,
            toolExecutor,
            this.logger,
          );
          turnItems.push(createFunctionCallOutput(toolCall, result));
          continue;
        }

        if (toolCall.name === "send_message") {
          const action = parseMessageAction(toolCall);

          if (action.channel.length > 0) {
            const result = await executeSendChannelMessageTool(
              toolCall,
              action,
              toolExecutor,
              this.logger,
            );
            turnItems.push(createFunctionCallOutput(toolCall, result));
            continue;
          }

          return createSendMessageResult(
            toolCall,
            action,
            turnItems,
            reasoningSummary,
            response.output.length,
            this.logger,
          );
        }

        if (toolCall.name === "wait_for_more_messages") {
          turnItems.push(
            createFunctionCallOutput(toolCall, {
              ok: true,
              paused_until: "new_human_message",
            }),
          );
          this.logger.info("openai.response", {
            action: "wait_command",
            memoryItems: turnItems.length,
          });
          return {
            type: "wait",
            memoryItems: turnItems,
          };
        }

        return createSleepResult(
          toolCall,
          turnItems,
          reasoningSummary,
          response.output.length,
          this.logger,
        );
      }

      this.logger.warn("openai.tool_iteration_limit");
      return {
        type: "wait",
        memoryItems: turnItems,
      };
    } catch (error) {
      this.logger.warn("openai.failed", { error: String(error) });
      return { type: "failed", error };
    }
  }
}

const botControlTools = [
  {
    type: "function",
    name: "remember_person",
    description:
      "Non-terminal action. Remember that a Discord username belongs to a real person when a human tells you or when it is clear from conversation. Use this before your final terminal action. The server will verify the username and reject duplicates.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: {
          type: "string",
          description:
            "Discord username without @. Use the server username, not a display name, when possible.",
        },
        name: {
          type: "string",
          description: "The person's real name or preferred name.",
        },
      },
      required: ["username", "name"],
    },
  },
  {
    type: "function",
    name: "send_message",
    description:
      "Terminal action. Send a Discord message and/or react to the latest new human message as Ben. After this action, execution pauses until new human messages arrive.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: ["string", "null"],
          description:
            "The Discord message to send. Keep it short, lowercase, and natural. Use null when only reacting.",
        },
        reaction: {
          type: ["string", "null"],
          description:
            "Exactly one standard Unicode emoji to react with, or null when only sending a message.",
        },
        channel: {
          type: ["string", "null"],
          description:
            "Target channel for cross-channel messages, with or without a leading #, such as #general or general. Use null for the current channel.",
        },
      },
      required: ["text", "reaction", "channel"],
    },
  },
  {
    type: "function",
    name: "create_scheduled_message",
    description:
      "Non-terminal action. Schedule Ben to send a message at a specific future bot-local date and time, optionally repeating daily or weekly. Use only when the user clearly asks Ben to remind, ask, or ping real users later. After this succeeds or fails, continue with send_message, wait_for_more_messages, or sleep_conversation.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
          description:
            "The message Ben should send later, without leading pings. Must be 1-1000 characters.",
        },
        target_usernames: {
          type: "array",
          description:
            "Discord usernames to ping when sending. Use real user names only. Do not include @everyone, @here, roles, or empty strings.",
          items: {
            type: "string",
          },
        },
        channel: {
          type: ["string", "null"],
          description:
            "Target channel name, with or without #. Use null for the current channel.",
        },
        run_date: {
          type: "string",
          description:
            "First run date in YYYY-MM-DD using the bot's current local date from the prompt.",
        },
        run_time: {
          type: "string",
          description:
            "First run time in 24-hour HH:mm using the bot's current local time from the prompt.",
        },
        repeat: {
          type: "string",
          enum: ["none", "daily", "weekly"],
          description:
            "Use none for one-time schedules, daily for every day, or weekly for every week anchored to run_date.",
        },
      },
      required: ["message", "target_usernames", "channel", "run_date", "run_time", "repeat"],
    },
  },
  {
    type: "function",
    name: "wait_for_more_messages",
    description:
      "Terminal action. Stay awake and wait for follow-up messages without sending a text response. Execution pauses until new human messages arrive.",
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
      "Terminal action. Optionally send a final Discord message and/or react to the latest new human message, then go back to sleep because Ben is no longer needed. Conversation context is cleared and execution stops until Ben is pinged again.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: ["string", "null"],
          description:
            "Optional final Discord message to send before sleeping. Keep it short, lowercase, and natural. Use null when not sending a final message.",
        },
        reaction: {
          type: ["string", "null"],
          description:
            "Optional final reaction: exactly one standard Unicode emoji to react with before sleeping, or null when not reacting.",
        },
        summary: {
          type: "string",
          description:
            "Required 1-2 sentence summary of the conversation Ben just had. This is stored for future wake-ups, so keep it factual and concise.",
        },
      },
      required: ["text", "reaction", "summary"],
    },
  },
] satisfies Tool[];

type BotControlToolName =
  | "remember_person"
  | "create_scheduled_message"
  | "send_message"
  | "wait_for_more_messages"
  | "sleep_conversation";

function isBotControlToolCall(item: ResponseOutputItem): item is ResponseFunctionToolCall & {
  name: BotControlToolName;
} {
  return item.type === "function_call" && isBotControlToolName(item.name);
}

function isBotControlToolName(name: string): name is BotControlToolName {
  return (
    name === "send_message" ||
    name === "remember_person" ||
    name === "create_scheduled_message" ||
    name === "wait_for_more_messages" ||
    name === "sleep_conversation"
  );
}

async function executeRememberPersonTool(
  toolCall: ResponseFunctionToolCall,
  toolExecutor: BotToolExecutor,
  logger: Logger,
): Promise<Record<string, unknown>> {
  const input = parseRememberPersonAction(toolCall);

  if (input.username.length === 0 || input.name.length === 0) {
    logger.warn("openai.invalid_remember_person_args", {
      usernameChars: input.username.length,
      nameChars: input.name.length,
    });
    return {
      ok: false,
      error: "remember_person requires non-empty username and name",
    };
  }

  const result = await toolExecutor.rememberPerson(input);
  logger.info("openai.remember_person_result", result);

  return result;
}

async function executeSendChannelMessageTool(
  toolCall: ResponseFunctionToolCall,
  action: MessageAction,
  toolExecutor: BotToolExecutor,
  logger: Logger,
): Promise<Record<string, unknown>> {
  if (action.text.length === 0) {
    logger.warn("openai.empty_cross_channel_send_message", { channel: action.channel });
    return {
      ok: false,
      error: "cross-channel send_message requires non-empty text",
    };
  }

  if (action.reaction.length > 0) {
    logger.warn("openai.invalid_cross_channel_send_message_reaction", {
      channel: action.channel,
      reaction: action.reaction,
    });
    return {
      ok: false,
      error: "cross-channel send_message cannot include a reaction",
    };
  }

  const input: SendChannelMessageToolInput = {
    channel: action.channel,
    text: action.text,
  };
  const result = await toolExecutor.sendChannelMessage(input);
  logger.info("openai.cross_channel_send_message_result", result);

  if (result.ok) {
    return {
      ok: true,
      channel: result.channel,
    };
  }

  return result;
}

async function executeCreateScheduledMessageTool(
  toolCall: ResponseFunctionToolCall,
  toolExecutor: BotToolExecutor,
  logger: Logger,
): Promise<Record<string, unknown>> {
  const input = parseCreateScheduledMessageAction(toolCall);

  if (input.message.length === 0 || input.message.length > 1_000) {
    logger.warn("openai.invalid_create_scheduled_message_text", {
      chars: input.message.length,
    });
    return {
      ok: false,
      error: "scheduled message must be 1-1000 characters",
    };
  }

  if (input.targetUsernames.length === 0) {
    logger.warn("openai.create_scheduled_message_missing_targets");
    return {
      ok: false,
      error: "scheduled message requires at least one real target username",
    };
  }

  const result = await toolExecutor.createScheduledMessage(input);
  logger.info("openai.create_scheduled_message_result", result);

  return result;
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

function createSendMessageResult(
  toolCall: ResponseFunctionToolCall,
  action: MessageAction,
  turnItems: ResponseInputItem[],
  reasoningSummary: string | undefined,
  outputItemCount: number,
  logger: Logger,
): ResponderResult {
  if (action.reaction.length > 0 && !isSingleUnicodeEmoji(action.reaction)) {
    logger.warn("openai.invalid_send_message_reaction", { reaction: action.reaction });
    turnItems.push(
      createFunctionCallOutput(toolCall, {
        ok: false,
        error: "send_message reaction must be null or exactly one standard Unicode emoji",
      }),
    );
    return {
      type: "wait",
      memoryItems: turnItems,
    };
  }

  if (action.text.length === 0 && action.reaction.length === 0) {
    logger.warn("openai.empty_send_message");
    turnItems.push(
      createFunctionCallOutput(toolCall, {
        ok: false,
        error: "send_message requires text, reaction, or both",
      }),
    );
    return {
      type: "wait",
      memoryItems: turnItems,
    };
  }

  turnItems.push(
    createFunctionCallOutput(toolCall, {
      ok: true,
      paused_until: "new_human_message",
    }),
  );

  logger.info("openai.response", {
    action: action.text.length > 0 ? "message" : "reaction",
    chars: action.text.length,
    reaction: action.reaction.length > 0 ? action.reaction : undefined,
    reasoningSummaryChars: reasoningSummary?.length ?? 0,
    outputItems: outputItemCount,
  });

  if (action.text.length === 0) {
    const result: ResponderResult = {
      type: "reaction",
      emoji: action.reaction,
      memoryItems: turnItems,
    };

    if (reasoningSummary !== undefined) {
      result.reasoningSummary = reasoningSummary;
    }

    return result;
  }

  const result: ResponderResult = {
    type: "message",
    text: action.text,
    memoryItems: turnItems,
  };

  if (action.reaction.length > 0) {
    result.reactionEmoji = action.reaction;
  }

  if (reasoningSummary !== undefined) {
    result.reasoningSummary = reasoningSummary;
  }

  return result;
}

function createSleepResult(
  toolCall: ResponseFunctionToolCall,
  turnItems: ResponseInputItem[],
  reasoningSummary: string | undefined,
  outputItemCount: number,
  logger: Logger,
): ResponderResult {
  const action = parseMessageAction(toolCall);
  const summary = parseSleepSummary(toolCall);

  if (summary.length === 0) {
    logger.warn("openai.empty_sleep_summary");
    turnItems.push(
      createFunctionCallOutput(toolCall, {
        ok: false,
        error: "sleep_conversation requires a non-empty 1-2 sentence summary",
      }),
    );
    return {
      type: "wait",
      memoryItems: turnItems,
    };
  }

  if (action.reaction.length > 0 && !isSingleUnicodeEmoji(action.reaction)) {
    logger.warn("openai.invalid_sleep_reaction", { reaction: action.reaction });
    turnItems.push(
      createFunctionCallOutput(toolCall, {
        ok: false,
        error: "sleep_conversation reaction must be null or exactly one standard Unicode emoji",
      }),
    );
    return {
      type: "wait",
      memoryItems: turnItems,
    };
  }

  turnItems.push(
    createFunctionCallOutput(toolCall, {
      ok: true,
      paused_until: "ping_after_sleep",
    }),
  );

  logger.info("openai.response", {
    action: "sleep_command",
    chars: action.text.length,
    reaction: action.reaction.length > 0 ? action.reaction : undefined,
    reasoningSummaryChars: reasoningSummary?.length ?? 0,
    outputItems: outputItemCount,
  });

  const result: ResponderResult = { type: "sleep", summary };

  if (action.text.length > 0) {
    result.text = action.text;
  }

  if (action.reaction.length > 0) {
    result.reactionEmoji = action.reaction;
  }

  return result;
}

interface MessageAction {
  text: string;
  reaction: string;
  channel: string;
}

function parseMessageAction(toolCall: ResponseFunctionToolCall): MessageAction {
  const args = parseFunctionArguments(toolCall.arguments);
  const rawChannel = typeof args.channel === "string" ? args.channel.trim() : "";

  return {
    text: typeof args.text === "string" ? args.text.trim() : "",
    reaction: typeof args.reaction === "string" ? args.reaction.trim() : "",
    channel: rawChannel.replace(/^#+/, "").trim(),
  };
}

function parseSleepSummary(toolCall: ResponseFunctionToolCall): string {
  const args = parseFunctionArguments(toolCall.arguments);

  return typeof args.summary === "string" ? args.summary.trim() : "";
}

function parseRememberPersonAction(toolCall: ResponseFunctionToolCall): RememberPersonToolInput {
  const args = parseFunctionArguments(toolCall.arguments);

  return {
    username: typeof args.username === "string" ? trimUsername(args.username) : "",
    name: typeof args.name === "string" ? args.name.trim() : "",
  };
}

function parseCreateScheduledMessageAction(
  toolCall: ResponseFunctionToolCall,
): CreateScheduledMessageToolInput {
  const args = parseFunctionArguments(toolCall.arguments);

  return {
    message: typeof args.message === "string" ? args.message.trim() : "",
    targetUsernames: parseTargetUsernames(args.target_usernames),
    channel:
      typeof args.channel === "string" && args.channel.trim().length > 0
        ? args.channel.trim().replace(/^#+/, "")
        : null,
    runDate: typeof args.run_date === "string" ? args.run_date.trim() : "",
    runTime: typeof args.run_time === "string" ? args.run_time.trim() : "",
    repeat: parseScheduleRepeat(args.repeat),
  };
}

function parseTargetUsernames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const usernames = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const username = trimUsername(item);

    if (username.length === 0) {
      continue;
    }

    usernames.add(username);
  }

  return [...usernames];
}

function parseScheduleRepeat(value: unknown): CreateScheduledMessageToolInput["repeat"] {
  if (value === "daily" || value === "weekly") {
    return value;
  }

  return "none";
}

function trimUsername(username: string): string {
  return username.trim().replace(/^@+/, "");
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

function createFunctionCallOutput(
  toolCall: ResponseFunctionToolCall,
  output: Record<string, unknown>,
): ResponseInputItem {
  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: JSON.stringify(output),
  };
}

function createUserMessageItem(text: string): ResponseInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}
