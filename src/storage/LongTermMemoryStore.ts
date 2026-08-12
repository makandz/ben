import { readFile } from "node:fs/promises";

import { isRecord, writeFileAtomic } from "./JsonFile.js";

/** Persists Ben's consolidated long-term memory as plain text. */
export class LongTermMemoryStore {
  /**
   * Creates a store over a UTF-8 long-term memory file.
   *
   * @param filePath - Text file containing the complete consolidated memory.
   */
  constructor(private readonly filePath: string) {}

  /**
   * Reads the consolidated memory.
   *
   * @returns Trimmed memory text, or undefined when no memory exists.
   * @throws When an existing file cannot be read.
   */
  async get(): Promise<string | undefined> {
    try {
      const memory = (await readFile(this.filePath, "utf8")).trim();
      return memory.length === 0 ? undefined : memory;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Atomically replaces the consolidated memory.
   *
   * @param memory - Complete model-authored replacement text.
   * @returns A promise that resolves after the replacement is committed.
   * @throws When the memory is empty or cannot be written.
   */
  async set(memory: string): Promise<void> {
    const trimmed = memory.trim();
    if (trimmed.length === 0) throw new Error("Long-term memory must be non-empty.");
    await writeFileAtomic(this.filePath, `${trimmed}\n`);
  }
}
