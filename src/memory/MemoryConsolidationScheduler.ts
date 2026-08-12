import type { Logger } from "../logger.js";
import type { MemoryConsolidationResult, MemoryConsolidator } from "./MemoryConsolidator.js";

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

export type ConsolidationReporter = {
  started(): Promise<void>;
  completed(result: MemoryConsolidationResult): Promise<void>;
  failed(error: unknown): Promise<void>;
};

export type ManualConsolidationOutcome = "consolidated" | "empty" | "active" | "running";

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
   * @param scheduledReporter - Discord log-channel notifications for scheduled dreams.
   * @param logger - Structured scheduler diagnostics.
   * @param options - Timing and clock overrides, primarily for tests.
   * @throws When either configured interval is not positive and finite.
   */
  constructor(
    private readonly consolidator: Pick<MemoryConsolidator, "hasPendingMemory" | "consolidate">,
    private readonly state: ConsolidationState,
    private readonly lifecycle: DreamingLifecycle,
    private readonly scheduledReporter: ConsolidationReporter,
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

  /**
   * Requests consolidation immediately, independent of the persisted due time.
   *
   * @param reporter - Discord-facing lifecycle notifications for this request.
   * @returns The completed result or the reason consolidation could not begin.
   * @throws When consolidation or persistence fails after reporting the failure.
   */
  async consolidateNow(reporter: ConsolidationReporter): Promise<ManualConsolidationOutcome> {
    if (this.running) return "running";
    this.running = true;
    try {
      if (!(await this.consolidator.hasPendingMemory())) return "empty";
      if (!this.lifecycle.beginDreaming()) return "active";
      await this.performConsolidation(reporter, this.now());
      return "consolidated";
    } finally {
      this.running = false;
    }
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
      await this.performConsolidation(this.scheduledReporter, now);
      this.logger.info("memory_consolidation.consolidated", { reason });
    } catch (error) {
      this.logger.warn("memory_consolidation.failed", { reason, error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /** Runs one acquired dreaming phase and reports its Discord-visible lifecycle. */
  private async performConsolidation(reporter: ConsolidationReporter, now: Date): Promise<void> {
    let result: MemoryConsolidationResult | undefined;
    try {
      await reporter.started();
      const outcome = await this.consolidator.consolidate();
      if (outcome === "skipped") throw new Error("Memory consolidation unexpectedly had no input.");
      result = outcome;
      await this.scheduleNext(now);
    } catch (error) {
      await reporter.failed(error);
      throw error;
    } finally {
      this.lifecycle.finishDreaming();
    }
    await reporter.completed(result);
  }

  /** Records a full interval after a completed or empty due check. */
  private async scheduleNext(now: Date): Promise<void> {
    await this.state.setNextRunAt(new Date(now.getTime() + this.consolidationIntervalMs));
  }
}
