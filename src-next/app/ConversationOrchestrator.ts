import type { ConversationItem, ConversationOutcome, ToolCall } from "./types.js";
import type { Model } from "../model/Model.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 5;

export class ConversationOrchestrator {
  /**
   * Creates an orchestrator over one model and the available tools.
   *
   * @param model - Provider-neutral model implementation.
   * @param tools - Registry of conversation controls and capabilities.
   * @param maxToolIterations - Maximum model requests during one application turn.
   */
  constructor(
    private readonly model: Model,
    private readonly tools: ToolRegistry,
    private readonly maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  ) {
    if (!Number.isInteger(maxToolIterations) || maxToolIterations < 1) {
      throw new Error("maxToolIterations must be a positive integer");
    }
  }

  /**
   * Runs a provider-neutral conversation turn through terminal tool execution.
   *
   * @param instructions - System instruction matched to the current conversation.
   * @param history - Portable model input and tool result history retained from prior turns.
   * @param userText - The user's model-ready message for this turn.
   * @returns A conversation outcome for the session to apply.
   */
  async run(
    instructions: string,
    history: readonly ConversationItem[],
    userText: string,
  ): Promise<ConversationOutcome> {
    const memory: ConversationItem[] = [
      ...history,
      { type: "message", role: "user", text: userText },
    ];

    try {
      for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
        const turn = await this.model.invoke({
          instructions,
          history: [...memory],
          tools: this.tools.definitions(),
        });

        memory.push(...turn.items);
        const calls = turn.items.filter((item): item is ToolCall => item.type === "tool_call");

        if (calls.length !== 1) {
          for (const call of calls) {
            memory.push({
              type: "tool_result",
              callId: call.callId,
              result: { ok: false, error: "expected exactly one tool call" },
            });
          }

          return { type: "wait", history: memory };
        }

        const call = calls[0];

        if (call === undefined) {
          return { type: "wait", history: memory };
        }

        const tool = this.tools.get(call.name);
        const execution = tool === undefined
          ? { type: "continue" as const, result: { ok: false, error: `unknown tool: ${call.name}` } }
          : await tool.execute(call);

        memory.push({ type: "tool_result", callId: call.callId, result: execution.result });

        if (execution.type === "finish") {
          if (execution.outcome.type === "sleep") {
            return execution.outcome;
          }

          if (execution.outcome.type === "reply" || execution.outcome.type === "react") {
            return {
              ...execution.outcome,
              ...(turn.reasoningSummary === undefined
                ? {}
                : { reasoningSummary: turn.reasoningSummary }),
              history: memory,
            };
          }

          return { type: "wait", history: memory };
        }
      }

      return { type: "wait", history: memory };
    } catch (error) {
      return { type: "failed", error };
    }
  }
}
