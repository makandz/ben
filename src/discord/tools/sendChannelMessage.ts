import type { Tool, ToolResult } from "../../tools/Tool.js";
import { parseArguments, sanitizeText, toolFailure } from "./toolSupport.js";

/**
 * Creates the terminal, current-channel `message` tool.
 *
 * @returns A tool supporting text replies in the current channel.
 */
export function createSendMessageTool(): Tool {
  return {
    definition: {
      name: "message",
      description: "Send a text reply in the current channel and finish.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1 },
        },
        required: ["text"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      return executeCurrentChannel(input);
    },
  };
}

/** Validates the generic terminal current-channel action. */
function executeCurrentChannel(input: Record<string, unknown>): ToolResult {
  const text = sanitizeText(input.text);
  if (text.length === 0) return toolFailure("text is required");

  return {
    type: "finish",
    result: { ok: true, pausedUntil: "new_human_message" },
    outcome: { type: "reply", text },
  };
}
