import type { Logger } from "../logger.js";
import { isRecord, readJsonFile, UpdateQueue, writeJsonFileAtomic } from "./JsonFile.js";

/** Persists the rendered Discord custom status restored across bot restarts. */
export class CustomStatusStore {
  private readonly updates = new UpdateQueue();

  /**
   * Creates a store over Ben's custom-status file.
   *
   * @param filePath - JSON file containing the current rendered status.
   * @param logger - Logger used when malformed stored data is ignored.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /**
   * Gets the current custom status.
   *
   * @returns The rendered status, or `undefined` when it is reset or unavailable.
   */
  async get(): Promise<string | undefined> {
    return this.updates.run(async () => {
      try {
        const parsed = await readJsonFile(this.filePath);
        if (parsed === undefined) return undefined;
        if (!isRecord(parsed) || (parsed.status !== null && typeof parsed.status !== "string")) {
          this.logger.warn("custom_status.invalid", { path: this.filePath });
          return undefined;
        }
        const status = parsed.status?.trim();
        return status === undefined || status.length === 0 ? undefined : status;
      } catch (error) {
        this.logger.warn("custom_status.read_failed", {
          path: this.filePath,
          error: String(error),
        });
        return undefined;
      }
    });
  }

  /**
   * Atomically stores or resets the current custom status.
   *
   * @param status - Rendered status text, or `undefined` to persist a reset.
   * @returns A promise that resolves after the status is durably stored.
   */
  async set(status: string | undefined): Promise<void> {
    await this.updates.run(() =>
      writeJsonFileAtomic(this.filePath, {
        version: 1,
        status: status ?? null,
      }),
    );
  }
}
