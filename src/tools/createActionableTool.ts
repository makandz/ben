import type { ToolCall } from "../app/types.js";
import type { Tool, ToolDefinition, ToolResult } from "./Tool.js";

export type NextAction = "continue" | "wait" | "sleep";

export type ActionableExecution = { ok: true; result: unknown } | { ok: false; result: unknown };

export type ActionableToolOptions = {
  definition: ToolDefinition;
  execute(call: ToolCall): Promise<ActionableExecution>;
};

const nextActionProperties = {
  next_action: {
    type: ["string", "null"],
    enum: ["continue", "wait", "sleep", null],
    description:
      "What to do after the tool succeeds. Use continue if more tool calls or actions are needed now, wait to pause until another human message arrives while preserving the active conversation context, or sleep to end the active conversation and clear its context. Null defaults to continue.",
  },
  sleep_summary: {
    type: ["string", "null"],
    description:
      "A factual 1-2 sentence summary of the conversation to preserve when next_action is sleep. Use null for other next actions.",
  },
} as const;

/**
 * Adds reusable conversation-lifecycle inputs and behavior to a capability tool.
 *
 * @param options - Base definition and executor for the tool's primary operation.
 * @returns A tool that applies its requested next action only after successful execution.
 * @throws When the base definition is not a strict object schema.
 */
export function createActionableTool(options: ActionableToolOptions): Tool {
  const parameters = options.definition.parameters;
  const properties = parameters.properties;
  const required = parameters.required;
  if (
    parameters.type !== "object" ||
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    !isStringArray(required)
  ) {
    throw new Error(
      "Actionable tools require an object schema with properties and required fields",
    );
  }

  return {
    definition: {
      ...options.definition,
      parameters: {
        ...parameters,
        properties: { ...properties, ...nextActionProperties },
        required: [...required, "next_action", "sleep_summary"],
      },
    },
    async execute(call) {
      const action = parseNextAction(call.arguments);
      if (!action.ok) return continueFailure(action.error);

      const execution = await options.execute(call);
      if (!execution.ok) return { type: "continue", result: execution.result };

      return applyNextAction(action.nextAction, action.sleepSummary, execution.result);
    },
  };
}

type ParsedNextAction =
  { ok: true; nextAction: NextAction; sleepSummary?: string } | { ok: false; error: string };

/** Parses lifecycle fields without trusting provider-side schema enforcement. */
function parseNextAction(value: unknown): ParsedNextAction {
  const input =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rawAction = input.next_action;
  const nextAction = rawAction ?? "continue";
  if (nextAction !== "continue" && nextAction !== "wait" && nextAction !== "sleep") {
    return { ok: false, error: "next_action must be continue, wait, or sleep" };
  }

  if (nextAction !== "sleep") return { ok: true, nextAction };
  const sleepSummary = typeof input.sleep_summary === "string" ? input.sleep_summary.trim() : "";
  if (sleepSummary.length === 0) {
    return { ok: false, error: "sleep_summary is required when next_action is sleep" };
  }
  return { ok: true, nextAction, sleepSummary };
}

/** Converts a successful capability result into its requested lifecycle result. */
function applyNextAction(
  nextAction: NextAction,
  sleepSummary: string | undefined,
  result: unknown,
): ToolResult {
  if (nextAction === "continue") return { type: "continue", result };
  if (nextAction === "wait") return { type: "finish", result, outcome: { type: "wait" } };
  return {
    type: "finish",
    result,
    outcome: { type: "sleep", summary: sleepSummary ?? "" },
  };
}

/** Creates a recoverable, model-readable action validation failure. */
function continueFailure(error: string): ToolResult {
  return { type: "continue", result: { ok: false, error } };
}

/** Narrows a schema required-field list to strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
