import type { Tool, ToolResult } from "./Tool.js";
import { isSingleUnicodeEmoji } from "../util/emoji.js";

const nullableString = { type: ["string", "null"] };

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
    name: "wait_for_more_messages",
    description: "Wait without replying.",
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
    name: "sleep_conversation",
    description: "Optionally reply or react, save a summary, and sleep.",
    parameters: createObjectSchema(
      {
        text: nullableString,
        reaction: nullableString,
        summary: { type: "string" },
      },
      ["text", "reaction", "summary"],
    ),
  },
  async execute(call) {
    const input = parseArguments(call.arguments);
    const message = parseValue(input.text);
    const reaction = parseValue(input.reaction);
    const summary = parseValue(input.summary);

    if (summary.length === 0) {
      return validationFailure("summary is required");
    }

    if (reaction.length > 0 && !isSingleUnicodeEmoji(reaction)) {
      return validationFailure("reaction must be exactly one standard Unicode emoji");
    }

    return {
      type: "finish",
      result: { ok: true, pausedUntil: "ping_after_sleep" },
      outcome: {
        type: "sleep",
        summary,
        ...(message.length > 0 ? { text: message } : {}),
        ...(reaction.length > 0 ? { reaction } : {}),
      },
    };
  },
};
