import type { MemoryStore, RememberMemoryInput } from "../storage/MemoryStore.js";
import type { Tool } from "./Tool.js";

export type RememberToolDependencies = {
  store: Pick<MemoryStore, "remember">;
  sendStatus(message: string): Promise<void>;
};

/**
 * Creates the non-terminal tool used to add, update, and delete durable memories.
 *
 * @param dependencies - Durable memory persistence capability.
 * @returns A model-facing memory mutation tool.
 */
export function createRememberTool(dependencies: RememberToolDependencies): Tool {
  return {
    definition: {
      name: "remember",
      description: "Add, update, or delete one durable memory, then continue the turn.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "update", "delete"] },
          id: {
            anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
            description: "The displayed memory ID for update or delete; null when adding.",
          },
          memory: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The complete memory text for add or update; null when deleting.",
          },
        },
        required: ["action", "id", "memory"],
      },
    },
    async execute(call) {
      const input = parseRememberInput(call.arguments);
      if (!input.ok) {
        await dependencies.sendStatus(`> ⚠️ Failed to change memory: ${input.error}`);
        return { type: "continue", result: input };
      }

      try {
        const result = await dependencies.store.remember(input.value);
        await dependencies.sendStatus(formatRememberStatus(input.value.action, result));
        return { type: "continue", result };
      } catch (error) {
        const result = { ok: false as const, error: String(error) };
        await dependencies.sendStatus(formatRememberStatus(input.value.action, result));
        return { type: "continue", result };
      }
    },
  };
}

/** Formats a server-managed memory status without exposing internal IDs. */
function formatRememberStatus(
  action: RememberMemoryInput["action"],
  result: Awaited<ReturnType<MemoryStore["remember"]>>,
): string {
  if (!result.ok) return `> ⚠️ Failed to ${action} memory: ${result.error}`;
  const memory = JSON.stringify(result.memory);
  if (result.action === "added") return `> Remembered ${memory}`;
  if (result.action === "updated") return `> Updated memory to ${memory}`;
  return `> Forgot ${memory}`;
}

/** Narrows untrusted tool arguments into one explicit memory mutation. */
function parseRememberInput(
  value: unknown,
): { ok: true; value: RememberMemoryInput } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "arguments must be an object" };
  }

  const input = value as Record<string, unknown>;
  if (input.action === "add") {
    return typeof input.memory === "string" && input.id === null
      ? { ok: true, value: { action: "add", memory: input.memory } }
      : { ok: false, error: "add requires memory and id must be null" };
  }
  if (input.action === "update") {
    return typeof input.memory === "string" && isMemoryId(input.id)
      ? { ok: true, value: { action: "update", id: input.id, memory: input.memory } }
      : { ok: false, error: "update requires a non-negative integer id and memory" };
  }
  if (input.action === "delete") {
    return isMemoryId(input.id) && input.memory === null
      ? { ok: true, value: { action: "delete", id: input.id } }
      : { ok: false, error: "delete requires a non-negative integer id and memory must be null" };
  }
  return { ok: false, error: "action must be add, update, or delete" };
}

/** Checks whether an untrusted value is a valid array-position ID. */
function isMemoryId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
