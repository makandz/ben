import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";

import type { ConversationItem, TokenUsage } from "../../app/types.js";
import type { ModelRequest, ModelTurn } from "../Model.js";

/** Translates between application conversation data and OpenAI Responses API data. */
export class OpenAIMapper {
  private readonly reasoningContinuations = new WeakMap<object, ResponseReasoningItem>();

  /**
   * Translates a provider-neutral model request into Responses API input.
   *
   * @param request - Portable request containing conversation history.
   * @returns Provider input items in their original history order.
   */
  toInput(request: ModelRequest): ResponseInputItem[] {
    return request.history.flatMap((item) => this.toInputItem(item));
  }

  /**
   * Translates provider-neutral tool definitions into Responses API functions.
   *
   * @param request - Portable request containing available tool definitions.
   * @returns Strict OpenAI function definitions without tool-specific knowledge.
   */
  toTools(request: ModelRequest): FunctionTool[] {
    return request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.parameters },
      strict: true,
    }));
  }

  /**
   * Translates a Responses API response into one portable model turn.
   *
   * @param response - Completed provider response.
   * @returns Portable output items and token usage.
   */
  toTurn(response: Response): ModelTurn {
    const items = response.output.flatMap((item) => this.toConversationItems(item));
    const usage = response.usage === undefined ? undefined : mapUsage(response.usage);

    return {
      items,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /** Translates one portable history item into zero or one provider inputs. */
  private toInputItem(item: ConversationItem): ResponseInputItem[] {
    if (item.type === "message") {
      return [{ type: "message", role: item.role, content: item.text }];
    }

    if (item.type === "tool_call") {
      return [
        {
          type: "function_call",
          call_id: item.callId,
          name: item.name,
          arguments: stringifyJson(item.arguments),
        },
      ];
    }

    if (item.type === "tool_result") {
      return [
        {
          type: "function_call_output",
          call_id: item.callId,
          output: stringifyJson(item.result),
        },
      ];
    }

    const continuation = this.reasoningContinuations.get(item);

    if (continuation === undefined) {
      return [];
    }

    return [{ ...continuation, summary: [] }];
  }

  /** Translates one provider output item into portable conversation items. */
  private toConversationItems(item: ResponseOutputItem): ConversationItem[] {
    if (item.type === "message") {
      const text = item.content
        .map((content) => (content.type === "output_text" ? content.text : content.refusal))
        .join("\n")
        .trim();

      return text.length === 0 ? [] : [{ type: "message", role: "assistant", text }];
    }

    if (item.type === "function_call") {
      return [
        {
          type: "tool_call",
          callId: item.call_id,
          name: item.name,
          arguments: parseArguments(item.arguments),
        },
      ];
    }

    if (item.type === "reasoning") {
      const reasoning: ConversationItem = { type: "reasoning" };
      this.reasoningContinuations.set(reasoning, item);
      return [reasoning];
    }

    return [];
  }
}

/** Converts provider token fields into the application usage contract. */
function mapUsage(usage: NonNullable<Response["usage"]>): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

/** Parses JSON function arguments while preserving malformed provider output. */
function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Serializes any application value into a valid JSON string. */
function stringifyJson(value: unknown): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol")
    return "null";
  return JSON.stringify(value);
}
