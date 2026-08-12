import type { Tool, ToolResult } from "./Tool.js";

/** Creates the standard object schema used by conversation controls. */
function createObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

/** Narrows unknown arguments to a plain argument map. */
function parseArguments(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

/** Reads a trimmed string argument, or returns the empty string. */
function parseValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Returns a non-terminal validation failure for model-visible history. */
function validationFailure(error: string): ToolResult {
  return { type: "continue", result: { ok: false, error } };
}

/** Terminal tool that keeps conversation state while awaiting another message. */
export const waitTool: Tool = {
  definition: {
    name: "wait",
    description:
      "Use when you have nothing to say or do right now, but expect the current conversation to continue and want to retain its context for the next human message.",
    parameters: createObjectSchema({}, []),
  },
  async execute() {
    return {
      type: "finish",
      result: { ok: true, pausedUntil: "new_human_message" },
      outcome: { type: "wait" },
    };
  },
};

/** Terminal tool that clears conversation state after saving a summary. */
export const sleepTool: Tool = {
  definition: {
    name: "sleep",
    description:
      "Use when the current conversation is finished or its active context is no longer useful. Save a brief factual summary before ending the conversation context.",
    parameters: createObjectSchema(
      {
        summary: {
          type: "string",
          description:
            "A factual 1-2 sentence summary of the conversation and any important outcome or unresolved context that may be useful later. Do not include internal tool details.",
        },
      },
      ["summary"],
    ),
  },
  async execute(call) {
    const input = parseArguments(call.arguments);
    const summary = parseValue(input.summary);

    if (summary.length === 0) {
      return validationFailure("summary is required");
    }

    return {
      type: "finish",
      result: { ok: true, pausedUntil: "ping_after_sleep" },
      outcome: {
        type: "sleep",
        summary,
      },
    };
  },
};
