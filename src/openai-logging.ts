import { createRequire } from "node:module";
import {
  isOpenAIChatCompletionsRawModelStreamEvent,
  isOpenAIResponsesRawModelStreamEvent,
  type RunStreamEvent,
} from "@openai/agents";

const OPENAI_SDK_DEBUG_NAMESPACES = "openai-agents:*";
const TOOL_LOG_PREVIEW_LIMIT = 500;
const RUN_LOG_PREVIEW_LIMIT = 800;

export type OpenAiLoggingSettings = {
  sdkDebugEnabled: boolean;
  logRawModelEvents: boolean;
};

type AgentRunStartDetails = {
  threadId: string;
  messageId: string;
  requestingUserId: string;
  historyLength: number;
  model: string;
  timeZone: string;
  prompt: string;
};

type AgentRunCompletedDetails = {
  threadId: string;
  messageId: string;
  lastResponseId?: string;
  historyLength: number;
  newItemTypes: string[];
  finalOutput: unknown;
};

type AgentRunFailedDetails = {
  threadId: string;
  messageId: string;
  historyLength: number;
  prompt: string;
  error: unknown;
};

type DebugModule = {
  enable: (namespaces: string) => void;
};

/**
 * Enables optional OpenAI SDK debug output and returns the active logging settings.
 *
 * @param env - Process environment used to read logging flags.
 * @returns Active logging settings for the current process.
 */
export function initializeOpenAiLogging(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiLoggingSettings {
  const sdkDebugEnabled =
    readBooleanFlag(env.OPENAI_SDK_DEBUG) ||
    readBooleanFlag(env.OPENAI_AGENTS_SDK_DEBUG);
  const logRawModelEvents = readBooleanFlag(env.OPENAI_LOG_RAW_EVENTS);

  if (sdkDebugEnabled) {
    const require = createRequire(import.meta.url);
    const debug = require("debug") as DebugModule;
    debug.enable(
      mergeDebugNamespaces(env.DEBUG, OPENAI_SDK_DEBUG_NAMESPACES),
    );
    console.log("[openai] SDK debug logging enabled", {
      namespaces: OPENAI_SDK_DEBUG_NAMESPACES,
    });
  }

  return {
    sdkDebugEnabled,
    logRawModelEvents,
  };
}

/**
 * Logs the start of an OpenAI agent run for a Discord thread message.
 *
 * @param details - Run metadata and a preview of the current prompt.
 * @returns Nothing.
 */
export function logAgentRunStarted(details: AgentRunStartDetails): void {
  console.log("[openai] run started", {
    ...details,
    prompt: previewValue(details.prompt, RUN_LOG_PREVIEW_LIMIT),
  });
}

/**
 * Logs a single streamed event emitted by the Agents SDK during a run.
 *
 * @param event - Stream event emitted by the SDK.
 * @param settings - Active logging settings controlling verbosity.
 * @returns Nothing.
 */
export function logAgentStreamEvent(
  event: RunStreamEvent,
  settings: OpenAiLoggingSettings,
): void {
  if (event.type === "agent_updated_stream_event") {
    console.log("[openai] stream agent updated", {
      agentName: event.agent.name,
    });
    return;
  }

  if (event.type === "run_item_stream_event") {
    console.log("[openai] stream item", summarizeRunItemEvent(event));
    return;
  }

  if (!settings.logRawModelEvents) {
    return;
  }

  console.log("[openai] raw model event", summarizeRawModelEvent(event));
}

/**
 * Logs a successful agent run after the final output has been assembled.
 *
 * @param details - Completion metadata and output preview.
 * @returns Nothing.
 */
export function logAgentRunCompleted(
  details: AgentRunCompletedDetails,
): void {
  console.log("[openai] run completed", {
    ...details,
    finalOutput: previewValue(details.finalOutput, RUN_LOG_PREVIEW_LIMIT),
  });
}

/**
 * Logs a failed agent run with serialized error details.
 *
 * @param details - Failure metadata and the thrown error.
 * @returns Nothing.
 */
export function logAgentRunFailed(details: AgentRunFailedDetails): void {
  console.error("[openai] run failed", {
    ...details,
    prompt: previewValue(details.prompt, RUN_LOG_PREVIEW_LIMIT),
    error: serializeError(details.error),
  });
}

/**
 * Logs a tool invocation attempt before any tool-specific validation runs.
 *
 * @param toolName - Tool being invoked.
 * @param payload - Parsed tool input payload.
 * @returns Nothing.
 */
export function logToolInvocationStart(
  toolName: string,
  payload: Record<string, unknown>,
): void {
  console.log("[tool] invocation started", {
    toolName,
    payload: previewValue(payload, TOOL_LOG_PREVIEW_LIMIT),
  });
}

/**
 * Logs a successful tool invocation with a preview of the returned value.
 *
 * @param toolName - Tool that completed.
 * @param result - Tool return value.
 * @returns Nothing.
 */
export function logToolInvocationSuccess(
  toolName: string,
  result: unknown,
): void {
  console.log("[tool] invocation completed", {
    toolName,
    result: previewValue(result, TOOL_LOG_PREVIEW_LIMIT),
  });
}

/**
 * Logs a failed tool invocation, including the parsed payload and serialized error.
 *
 * @param toolName - Tool that failed.
 * @param payload - Parsed tool input payload.
 * @param error - Error thrown while executing the tool.
 * @returns Nothing.
 */
export function logToolInvocationFailure(
  toolName: string,
  payload: Record<string, unknown>,
  error: unknown,
): void {
  console.error("[tool] invocation failed", {
    toolName,
    payload: previewValue(payload, TOOL_LOG_PREVIEW_LIMIT),
    error: serializeError(error),
  });
}

function summarizeRunItemEvent(event: Extract<RunStreamEvent, { type: "run_item_stream_event" }>): Record<string, unknown> {
  const rawItem = toRecord(event.item.rawItem);
  const summary: Record<string, unknown> = {
    name: event.name,
    itemType: readString(rawItem.type) ?? event.item.type,
  };

  const toolName = readString(rawItem.name);
  const callId = readString(rawItem.callId) ?? readString(rawItem.call_id);
  const status = readString(rawItem.status);
  const role = readString(rawItem.role);

  if (toolName) {
    summary.toolName = toolName;
  }

  if (callId) {
    summary.callId = callId;
  }

  if (status) {
    summary.status = status;
  }

  if (role) {
    summary.role = role;
  }

  if ("arguments" in rawItem) {
    summary.arguments = previewValue(rawItem.arguments, TOOL_LOG_PREVIEW_LIMIT);
  }

  if ("output" in rawItem) {
    summary.output = previewValue(rawItem.output, TOOL_LOG_PREVIEW_LIMIT);
  }

  if ("content" in rawItem) {
    summary.content = previewValue(rawItem.content, TOOL_LOG_PREVIEW_LIMIT);
  }

  return summary;
}

function summarizeRawModelEvent(
  event: Extract<RunStreamEvent, { type: "raw_model_stream_event" }>,
): Record<string, unknown> {
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    const payload = toRecord(event.data.event);
    return {
      source: event.source,
      eventType: readString(payload.type) ?? "unknown",
      event: previewValue(payload, TOOL_LOG_PREVIEW_LIMIT),
    };
  }

  if (isOpenAIChatCompletionsRawModelStreamEvent(event)) {
    const payload = toRecord(event.data.event);
    return {
      source: event.source,
      object: readString(payload.object) ?? "unknown",
      event: previewValue(payload, TOOL_LOG_PREVIEW_LIMIT),
    };
  }

  return {
    source: event.source,
    event: previewValue(event.data, TOOL_LOG_PREVIEW_LIMIT),
  };
}

function readBooleanFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function mergeDebugNamespaces(
  existingNamespaces: string | undefined,
  namespaceToAdd: string,
): string {
  const namespaces = new Set(
    (existingNamespaces ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

  namespaces.add(namespaceToAdd);
  return [...namespaces].join(",");
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    const errorWithMetadata = error as Error & {
      cause?: unknown;
      code?: unknown;
      status?: unknown;
    };

    if (typeof errorWithMetadata.code !== "undefined") {
      serialized.code = errorWithMetadata.code;
    }

    if (typeof errorWithMetadata.status !== "undefined") {
      serialized.status = errorWithMetadata.status;
    }

    if (typeof errorWithMetadata.cause !== "undefined") {
      serialized.cause = serializeUnknown(errorWithMetadata.cause);
    }

    return serialized;
  }

  return {
    value: serializeUnknown(error),
  };
}

function serializeUnknown(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (typeof value === "object" && value !== null) {
    return previewValue(value, TOOL_LOG_PREVIEW_LIMIT);
  }

  return value;
}

function previewValue(value: unknown, limit: number): string {
  const text = safeStringify(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
