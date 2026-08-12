import type { Logger } from "../logger.js";
import type { MemoryConsolidator } from "./MemoryConsolidator.js";

export const MEMORY_CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_CONSOLIDATION_CHECK_MS = 30_000;

type ConsolidationState = {
  getNextRunAt(): Promise<Date | undefined>;
  setNextRunAt(nextRunAt: Date): Promise<void>;
};

type DreamingLifecycle = {
  beginDreaming(): boolean;
  finishDreaming(): void;
};

export type MemoryConsolidationSchedulerOptions = {
  consolidationIntervalMs?: number;
  checkIntervalMs?: number;
  now?: () => Date;
};

/** Runs due memory consolidation without overlapping active conversations. */
export class MemoryConsolidationScheduler {
  private readonly consolidationIntervalMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  /**
   * Creates the periodic dreaming scheduler.
   *
   * @param consolidator - Tool-free long-term memory consolidation service.
   * @param state - Persistent next-run state.
   * @param lifecycle - Session boundary used to acquire the dreaming state.
   * @param logger - Structured scheduler diagnostics.
   * @param options - Timing and clock overrides, primarily for tests.
   * @throws When either configured interval is not positive and finite.
   */
  constructor(
    private readonly consolidator: Pick<MemoryConsolidator, "hasPendingMemory" | "consolidate">,
    private readonly state: ConsolidationState,
    private readonly lifecycle: DreamingLifecycle,
    private readonly logger: Pick<Logger, "debug" | "info" | "warn">,
    options: MemoryConsolidationSchedulerOptions = {},
  ) {
    this.consolidationIntervalMs =
      options.consolidationIntervalMs ?? MEMORY_CONSOLIDATION_INTERVAL_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? MEMORY_CONSOLIDATION_CHECK_MS;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.consolidationIntervalMs) || this.consolidationIntervalMs <= 0) {
      throw new Error("consolidationIntervalMs must be a positive finite number");
    }
    if (!Number.isFinite(this.checkIntervalMs) || this.checkIntervalMs <= 0) {
      throw new Error("checkIntervalMs must be a positive finite number");
    }
  }

  /**
   * Starts polling and waits for the initial due check.
   *
   * @returns A promise that resolves after startup scheduling or consolidation completes.
   */
  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.runDue("interval");
    }, this.checkIntervalMs);
    this.logger.info("memory_consolidation.scheduler_started", {
      checkIntervalMs: this.checkIntervalMs,
      consolidationIntervalMs: this.consolidationIntervalMs,
    });
    await this.runDue("startup");
  }

  /** Stops polling without changing persisted consolidation state. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Performs one non-overlapping due check. */
  private async runDue(reason: "startup" | "interval"): Promise<void> {
    if (this.running) {
      this.logger.debug("memory_consolidation.skipped_running", { reason });
      return;
    }
    this.running = true;
    try {
      const now = this.now();
      const nextRunAt = await this.state.getNextRunAt();
      if (nextRunAt === undefined) {
        await this.scheduleNext(now);
        return;
      }
      if (nextRunAt.getTime() > now.getTime()) return;

      if (!(await this.consolidator.hasPendingMemory())) {
        await this.scheduleNext(now);
        this.logger.info("memory_consolidation.skipped_empty", { reason });
        return;
      }
      if (!this.lifecycle.beginDreaming()) {
        this.logger.debug("memory_consolidation.deferred_active", { reason });
        return;
      }

      try {
        const outcome = await this.consolidator.consolidate();
        await this.scheduleNext(now);
        this.logger.info(`memory_consolidation.${outcome}`, { reason });
      } finally {
        this.lifecycle.finishDreaming();
      }
    } catch (error) {
      this.logger.warn("memory_consolidation.failed", { reason, error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /** Records a full interval after a completed or empty due check. */
  private async scheduleNext(now: Date): Promise<void> {
    await this.state.setNextRunAt(new Date(now.getTime() + this.consolidationIntervalMs));
  }
}
