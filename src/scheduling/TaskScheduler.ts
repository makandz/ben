import type { Logger } from "../logger.js";
import type { AutonomousTask, TaskStore } from "../storage/TaskStore.js";
import { computeNextRunAt } from "./scheduleTime.js";
import { SCHEDULE_CHECK_INTERVAL_MS, SCHEDULE_TIME_ZONE } from "./ScheduledMessageScheduler.js";

export type TaskCompletion = () => Promise<void>;

export type TaskSchedulerOptions = {
  intervalMs?: number;
  now?: () => Date;
  timeZone?: string;
};

type SchedulerStore = Pick<TaskStore, "listDue" | "completeOccurrence" | "advanceRecurring">;

type SchedulerReason = "startup" | "interval";

/** Polls persisted tasks and claims each occurrence until its conversation completes durably. */
export class TaskScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly claimed = new Set<string>();
  private readonly pendingCompletions = new Map<string, AutonomousTask>();
  private readonly pendingStartupAdvances = new Map<string, AutonomousTask>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private startedAt: Date | undefined;

  /**
   * Creates an autonomous task scheduler.
   *
   * @param store - Persistent due-task, recurrence, and completion operations.
   * @param enqueue - Session boundary that queues a task wake and completion callback.
   * @param logger - Structured runtime logger.
   * @param options - Poll interval, timezone, and clock overrides, primarily for tests.
   * @throws When the polling interval is not a positive finite number.
   */
  constructor(
    private readonly store: SchedulerStore,
    private readonly enqueue: (task: AutonomousTask, complete: TaskCompletion) => void,
    private readonly logger: Pick<Logger, "debug" | "info" | "warn">,
    options: TaskSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? SCHEDULE_CHECK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? SCHEDULE_TIME_ZONE;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive finite number");
    }
  }

  /**
   * Starts polling and waits for the initial due-task pass.
   *
   * Recurrences already overdue at this process boundary advance without waking Ben. One-time
   * tasks remain eligible so an interrupted one-time task is not silently discarded.
   *
   * @returns A promise that resolves after the startup pass completes.
   */
  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.startedAt = this.now();
    this.timer = setInterval(() => void this.runDueTasks("interval"), this.intervalMs);
    this.logger.info("tasks.scheduler_started", { intervalMs: this.intervalMs });
    await this.runDueTasks("startup");
  }

  /** Stops polling while leaving persisted tasks available after restart. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one non-overlapping completion retry and due-task pass. */
  private async runDueTasks(reason: SchedulerReason): Promise<void> {
    if (this.running) {
      this.logger.debug("tasks.skipped_running", { reason });
      return;
    }
    this.running = true;
    try {
      await this.retryPendingCompletions();
      await this.retryPendingStartupAdvances();
      const now = this.now();
      const tasks = await this.store.listDue(now);
      for (const task of tasks) {
        if (this.claimed.has(task.id)) continue;
        if (reason === "startup" && task.repeat !== "none" && this.wasMissed(task)) {
          await this.skipMissedOccurrence(task, now);
        } else {
          this.claimAndEnqueue(task, reason);
        }
      }
    } catch (error) {
      this.logger.warn("tasks.tick_failed", { reason, error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /** Advances one recurrence that was already overdue when this scheduler started. */
  private async skipMissedOccurrence(task: AutonomousTask, now: Date): Promise<void> {
    if (task.repeat === "none") return;
    this.claimed.add(task.id);
    this.pendingStartupAdvances.set(task.id, task);
    await this.tryAdvanceMissedOccurrence(task, now);
  }

  /** Retries startup advancement without accidentally enqueueing a previously missed occurrence. */
  private async retryPendingStartupAdvances(): Promise<void> {
    for (const task of this.pendingStartupAdvances.values()) {
      await this.tryAdvanceMissedOccurrence(task, this.now());
    }
  }

  /** Applies one version-checked startup advance and retains its claim after persistence failure. */
  private async tryAdvanceMissedOccurrence(task: AutonomousTask, now: Date): Promise<void> {
    if (task.repeat === "none") return;
    try {
      const nextRunAt = computeNextFutureRunAt(
        new Date(task.nextRunAt),
        task.repeat,
        this.timeZone,
        now,
      );
      const result = await this.store.advanceRecurring(task.id, task.version, nextRunAt, now);
      this.logger.info(result.advanced ? "tasks.missed_advanced" : "tasks.missed_already_handled", {
        id: task.id,
        dueAt: task.nextRunAt,
        nextRunAt: nextRunAt.toISOString(),
      });
      this.pendingStartupAdvances.delete(task.id);
      this.claimed.delete(task.id);
    } catch (error) {
      this.logger.warn("tasks.missed_advance_failed", { id: task.id, error: String(error) });
    }
  }

  /** Claims one due task before enqueueing it and retains the claim until durable completion. */
  private claimAndEnqueue(task: AutonomousTask, reason: SchedulerReason): void {
    this.claimed.add(task.id);
    try {
      this.enqueue(task, async () => {
        this.pendingCompletions.set(task.id, task);
        await this.tryComplete(task);
      });
      this.logger.info("tasks.queued", {
        id: task.id,
        channelId: task.destination.channelId,
        reason,
      });
    } catch (error) {
      this.claimed.delete(task.id);
      this.logger.warn("tasks.enqueue_failed", { id: task.id, reason, error: String(error) });
    }
  }

  /** Retries durable completion without enqueueing already completed conversational work. */
  private async retryPendingCompletions(): Promise<void> {
    for (const task of this.pendingCompletions.values()) await this.tryComplete(task);
  }

  /** Applies one version-checked completion and releases its claim only after a contained result. */
  private async tryComplete(task: AutonomousTask): Promise<void> {
    try {
      const now = this.now();
      const nextRunAt =
        task.repeat === "none"
          ? undefined
          : computeNextFutureRunAt(new Date(task.nextRunAt), task.repeat, this.timeZone, now);
      const result = await this.store.completeOccurrence(
        task.id,
        task.version,
        task.repeat,
        nextRunAt,
        now,
      );
      this.logger.info(
        result.outcome === "unchanged" ? "tasks.completion_already_handled" : "tasks.completed",
        {
          id: task.id,
          outcome: result.outcome,
          ...(nextRunAt === undefined ? {} : { nextRunAt: nextRunAt.toISOString() }),
        },
      );
      this.pendingCompletions.delete(task.id);
      this.claimed.delete(task.id);
    } catch (error) {
      this.logger.warn("tasks.completion_failed", { id: task.id, error: String(error) });
    }
  }

  /** Returns whether a recurring due occurrence predates this scheduler process. */
  private wasMissed(task: AutonomousTask): boolean {
    return (
      this.startedAt !== undefined && new Date(task.nextRunAt).getTime() < this.startedAt.getTime()
    );
  }
}

/** Finds the first recurring occurrence strictly after the supplied reference instant. */
function computeNextFutureRunAt(
  dueAt: Date,
  repeat: "daily" | "weekly",
  timeZone: string,
  reference: Date,
): Date {
  let nextRunAt = computeNextRunAt(dueAt, repeat, timeZone);
  while (nextRunAt !== undefined && nextRunAt.getTime() <= reference.getTime()) {
    nextRunAt = computeNextRunAt(nextRunAt, repeat, timeZone);
  }
  if (nextRunAt === undefined) throw new Error("Recurring task did not produce a next run.");
  return nextRunAt;
}
