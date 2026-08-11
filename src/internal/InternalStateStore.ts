import type { Logger } from "../logger.js";
import { isRecord, readJsonFile, UpdateQueue, writeJsonFileAtomic } from "../storage/JsonFile.js";
import { internalStatusSchema, type InternalStatus } from "./InternalStatus.js";

export type InternalStatusState = { action: "status"; status: InternalStatus; setAt: string };
type InternalStateFile = { statuses?: { current?: InternalStatusState } };

/** Reads and atomically writes the production-compatible internal status file. */
export class InternalStateStore {
  private readonly updates = new UpdateQueue();

  /**
   * @param filePath - Production-compatible internal-state JSON path.
   * @param logger - Logger for contained read and validation failures.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /** @returns The valid current status, or undefined for missing/malformed state. */
  async readCurrentStatus(): Promise<InternalStatusState | undefined> {
    const current = (await this.read()).statuses?.current;
    return current === undefined ? undefined : parseState(current);
  }

  /**
   * Persists a newly timestamped current status.
   *
   * @param status - Valid status to make current.
   * @param now - Status timestamp, replaceable for tests.
   * @returns The persisted current-state record.
   */
  async writeCurrentStatus(status: InternalStatus, now = new Date()): Promise<InternalStatusState> {
    const current: InternalStatusState = { action: "status", status, setAt: now.toISOString() };
    return this.updates.run(async () => {
      const state = await this.read();
      state.statuses = { ...state.statuses, current };
      await writeJsonFileAtomic(this.filePath, state);
      return current;
    });
  }

  private async read(): Promise<InternalStateFile> {
    try {
      const parsed = await readJsonFile(this.filePath);
      if (parsed === undefined) return {};
      if (isRecord(parsed)) return parsed;
      this.logger.warn("internal.state_invalid", { path: this.filePath });
    } catch (error) {
      this.logger.warn("internal.state_read_failed", { path: this.filePath, error: String(error) });
    }
    return {};
  }
}

/**
 * Reports whether saved status state remains inside its refresh interval.
 *
 * @param state - Persisted current status record.
 * @param intervalMs - Status refresh interval.
 * @param now - Comparison time, replaceable for tests.
 * @returns Whether the saved status remains fresh.
 */
export function isFreshStatusState(
  state: InternalStatusState,
  intervalMs: number,
  now = new Date(),
): boolean {
  const setAt = Date.parse(state.setAt);
  return Number.isFinite(setAt) && now.getTime() - setAt < intervalMs;
}

function parseState(value: unknown): InternalStatusState | undefined {
  if (!isRecord(value) || value.action !== "status" || typeof value.setAt !== "string")
    return undefined;
  const result = internalStatusSchema.safeParse(value.status);
  return result.success ? { action: "status", status: result.data, setAt: value.setAt } : undefined;
}
