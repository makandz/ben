import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Reads and parses a JSON file.
 *
 * @param filePath - JSON file to read.
 * @returns The parsed value, or undefined when the file does not exist.
 * @throws When the file cannot be read or contains invalid JSON.
 */
export async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Atomically replaces a JSON file through a unique sibling temporary file.
 *
 * @param filePath - Destination JSON file.
 * @param data - Serializable object to write.
 * @returns A promise that resolves after the replacement is committed.
 * @throws When the directory or file cannot be written.
 */
export async function writeJsonFileAtomic(filePath: string, data: object): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Serializes asynchronous read-modify-write operations without poisoning the queue on failure. */
export class UpdateQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Queues an operation after all earlier updates have settled.
   *
   * @param operation - Asynchronous read-modify-write operation to serialize.
   * @returns The operation result after all earlier updates have settled.
   */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Candidate value to inspect.
 * @returns Whether the value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
