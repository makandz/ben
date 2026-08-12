import type { ToolCall } from "../app/types.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolResult =
  | { type: "continue"; result: unknown }
  | { type: "finish"; result: unknown; outcome: TerminalToolOutcome };

export type TerminalToolOutcome =
  { type: "reply"; text: string } | { type: "wait" } | { type: "sleep"; summary: string };

export type Tool = {
  definition: ToolDefinition;
  execute(call: ToolCall): Promise<ToolResult>;
};
