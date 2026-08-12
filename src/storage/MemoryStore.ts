import type { Logger } from "../logger.js";
import { isRecord, readJsonFile, UpdateQueue, writeJsonFileAtomic } from "./JsonFile.js";

const MAX_ACTIVE_MEMORIES = 25;
const MAX_MEMORY_LENGTH = 500;

type MemoryData = { version: 1; memories: (string | null)[] };

export type MemoryItem = { id: number; memory: string };
export type RememberMemoryInput =
  | { action: "add"; memory: string }
  | { action: "update"; id: number; memory: string }
  | { action: "delete"; id: number };
export type RememberMemoryResult =
  | { ok: true; action: "added" | "updated" | "deleted"; id: number; memory: string }
  | { ok: false; error: string };

/** Persists Ben's durable, model-managed memories with stable numeric positions. */
export class MemoryStore {
  private readonly updates = new UpdateQueue();

  /**
   * Creates a memory store over a versioned JSON file.
   *
   * @param filePath - JSON file containing the stable memory array.
   * @param logger - Logger used when malformed entries are replaced with tombstones.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /**
   * Lists active memories with their stable array-position IDs.
   *
   * @returns Non-deleted memories in array order.
   */
  async list(): Promise<MemoryItem[]> {
    return (await this.read()).memories.flatMap((memory, id) =>
      memory === null ? [] : [{ id, memory }],
    );
  }

  /**
   * Adds, updates, or tombstones one durable memory.
   *
   * @param input - Explicit memory mutation requested by the model.
   * @returns The completed mutation or a model-readable validation failure.
   */
  async remember(input: RememberMemoryInput): Promise<RememberMemoryResult> {
    return this.updates.run<RememberMemoryResult>(async () => {
      const data = await this.read();

      if (input.action === "add") {
        const memory = validateMemory(input.memory);
        if (!memory.ok) return memory;
        if (activeMemoryCount(data.memories) >= MAX_ACTIVE_MEMORIES) {
          return {
            ok: false,
            error: `memory limit of ${String(MAX_ACTIVE_MEMORIES)} reached; delete an existing memory before adding another`,
          };
        }

        const id = data.memories.length;
        data.memories.push(memory.value);
        await writeJsonFileAtomic(this.filePath, data);
        return { ok: true, action: "added", id, memory: memory.value };
      }

      if (!isActiveMemoryId(data.memories, input.id)) {
        return { ok: false, error: `memory ${String(input.id)} does not exist` };
      }

      if (input.action === "delete") {
        const memory = data.memories[input.id];
        if (memory === null || memory === undefined) {
          return { ok: false, error: `memory ${String(input.id)} does not exist` };
        }
        data.memories[input.id] = null;
        await writeJsonFileAtomic(this.filePath, data);
        return { ok: true, action: "deleted", id: input.id, memory };
      }

      const memory = validateMemory(input.memory);
      if (!memory.ok) return memory;
      data.memories[input.id] = memory.value;
      await writeJsonFileAtomic(this.filePath, data);
      return { ok: true, action: "updated", id: input.id, memory: memory.value };
    });
  }

  /** Clears all short-term memories after successful long-term consolidation. */
  async clear(): Promise<void> {
    await this.updates.run(() => writeJsonFileAtomic(this.filePath, { version: 1, memories: [] }));
  }

  /** Reads and validates the storage shape without collapsing stable positions. */
  private async read(): Promise<MemoryData> {
    let parsed: unknown;
    try {
      parsed = await readJsonFile(this.filePath);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`${this.filePath} must contain valid JSON.`);
      throw error;
    }

    if (parsed === undefined) return { version: 1, memories: [] };
    if (!isRecord(parsed)) throw new Error(`${this.filePath} must contain a JSON object.`);
    if (!Array.isArray(parsed.memories)) {
      throw new Error(`${this.filePath} memories must be a JSON array.`);
    }

    return {
      version: 1,
      memories: parsed.memories.map((value, id) => {
        if (value === null) return null;
        if (typeof value !== "string") {
          this.logger.warn("memories.invalid_entry_ignored", { id });
          return null;
        }
        const memory = value.trim();
        if (memory.length === 0 || memory.length > MAX_MEMORY_LENGTH) {
          this.logger.warn("memories.invalid_entry_ignored", { id });
          return null;
        }
        return memory;
      }),
    };
  }
}

/** Validates and normalizes model-supplied memory text. */
function validateMemory(
  memory: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = memory.trim();
  if (value.length === 0) return { ok: false, error: "memory must be non-empty" };
  if (value.length > MAX_MEMORY_LENGTH) {
    return {
      ok: false,
      error: `memory must be at most ${String(MAX_MEMORY_LENGTH)} characters`,
    };
  }
  return { ok: true, value };
}

/** Counts prompt-visible entries without including deleted positions. */
function activeMemoryCount(memories: readonly (string | null)[]): number {
  return memories.reduce((count, memory) => count + (memory === null ? 0 : 1), 0);
}

/** Checks that an integer position currently contains an active memory. */
function isActiveMemoryId(memories: readonly (string | null)[], id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < memories.length && memories[id] !== null;
}
