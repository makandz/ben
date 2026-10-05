import type { ModelRequest, ModelTurn } from "../model/Model.js";
import type { ToolResult } from "../tools/Tool.js";
import type { ConversationOutcome, ToolCall } from "./types.js";

export type ExecutionEvent =
  | { type: "model_request"; request: ModelRequest }
  | { type: "model_turn"; turn: ModelTurn }
  | { type: "model_error"; error: unknown }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; execution: ToolResult }
  | { type: "tool_error"; call: ToolCall; error: unknown }
  | { type: "turn_completed"; channelId: string | undefined; outcome: ConversationOutcome }
  | {
      type: "outcome_error";
      channelId: string | undefined;
      operation: "apply" | "delivery" | "summary" | "task_completion";
      error: unknown;
    }
  | { type: "session_wake"; channelId: string; source: "human" | "task" }
  | { type: "session_sleep"; channelId: string | undefined; reason: "model" | "idle" }
  | { type: "session_dreaming"; active: boolean }
  | { type: "session_stopped" };

// Observers receive detached snapshots. Their work is never awaited by execution.
export type ExecutionObserver = (event: ExecutionEvent) => void | Promise<void>;

/**
 * Publishes a detached event while containing snapshot and observer failures.
 * Uncloneable error values fall back to their string representation; other uncloneable events
 * are omitted. Async observers own their work and are not awaited.
 *
 * @param observer - Optional execution observer.
 * @param event - Runtime event to snapshot before invoking the observer.
 */
export function observeExecution(
  observer: ExecutionObserver | undefined,
  event: ExecutionEvent,
): void {
  if (observer === undefined) return;
  try {
    let snapshot: ExecutionEvent;
    try {
      snapshot = structuredClone(event);
    } catch {
      // Errors can contain nonportable values. Retain their message without sharing them.
      if ("error" in event) {
        snapshot = structuredClone({ ...event, error: String(event.error) });
      } else if (event.type === "turn_completed" && event.outcome.type === "failed") {
        snapshot = structuredClone({
          ...event,
          outcome: { ...event.outcome, error: String(event.outcome.error) },
        });
      } else {
        return;
      }
    }
    void Promise.resolve(observer(snapshot)).catch(() => undefined);
  } catch {
    // Optional diagnostics must never affect Ben, even for uncloneable values.
  }
}
