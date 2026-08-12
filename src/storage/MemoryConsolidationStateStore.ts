import type { Logger } from "../logger.js";
import { isRecord, readJsonFile, writeJsonFileAtomic } from "./JsonFile.js";

/** Persists when Ben should next check for memory consolidation. */
export class MemoryConsolidationStateStore {
  /**
   * Creates a consolidation state store.
   *
   * @param filePath - JSON file containing the next due time.
   * @param logger - Logger used when stored state is malformed.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /**
   * Reads the next consolidation check time.
   *
   * @returns The stored due time, or undefined when no valid state exists.
   */
  async getNextRunAt(): Promise<Date | undefined> {
    try {
      const parsed = await readJsonFile(this.filePath);
      if (parsed === undefined) return undefined;
      if (!isRecord(parsed) || typeof parsed.nextRunAt !== "string") {
        this.logger.warn("memory_consolidation.state_invalid", { path: this.filePath });
        return undefined;
      }
      const nextRunAt = new Date(parsed.nextRunAt);
      if (Number.isNaN(nextRunAt.getTime())) {
        this.logger.warn("memory_consolidation.state_invalid", { path: this.filePath });
        return undefined;
      }
      return nextRunAt;
    } catch (error) {
      this.logger.warn("memory_consolidation.state_read_failed", {
        path: this.filePath,
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * Atomically records the next consolidation check time.
   *
   * @param nextRunAt - Instant when another check becomes due.
   * @returns A promise that resolves after the state is committed.
   */
  async setNextRunAt(nextRunAt: Date): Promise<void> {
    await writeJsonFileAtomic(this.filePath, {
      version: 1,
      nextRunAt: nextRunAt.toISOString(),
    });
  }
}
