import type { Logger } from "../logger.js";
import type { AutonomousTask, TaskStore } from "../storage/TaskStore.js";
import { SCHEDULE_CHECK_INTERVAL_MS } from "./ScheduledMessageScheduler.js";

export type TaskCompletion = () => Promise<void>;

export type TaskSchedulerOptions = {
  intervalMs?: number;
  now?: () => Date;
};

type SchedulerStore = Pick<TaskStore, "listDueOneTime" | "completeOneTime">;

/** Polls persisted one-time tasks and claims them until their conversations complete. */
export class TaskScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly claimed = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  /**
   * Creates an autonomous task scheduler.
   *
   * @param store - Persistent due-task and completion operations.
   * @param enqueue - Session boundary that queues a task wake and completion callback.
   * @param logger - Structured runtime logger.
   * @param options - Poll interval and clock overrides, primarily for tests.
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
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive finite number");
    }
  }

  /**
   * Starts polling and waits for the initial due-task pass.
   *
   * @returns A promise that resolves after the startup pass completes.
   */
  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.runDueTasks("interval"), this.intervalMs);
    this.logger.info("tasks.scheduler_started", { intervalMs: this.intervalMs });
    await this.runDueTasks("startup");
  }

  /** Stops polling while leaving persisted tasks available after restart. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one non-overlapping due-task pass. */
  private async runDueTasks(reason: "startup" | "interval"): Promise<void> {
    if (this.running) {
      this.logger.debug("tasks.skipped_running", { reason });
      return;
    }
    this.running = true;
    try {
      const tasks = await this.store.listDueOneTime(this.now());
      for (const task of tasks) this.claimAndEnqueue(task, reason);
    } catch (error) {
      this.logger.warn("tasks.tick_failed", { reason, error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /** Claims one due task before enqueueing it and releases the claim after completion. */
  private claimAndEnqueue(task: AutonomousTask, reason: "startup" | "interval"): void {
    if (this.claimed.has(task.id)) return;
    this.claimed.add(task.id);
    try {
      this.enqueue(task, async () => {
        try {
          const result = await this.store.completeOneTime(task.id, task.updatedAt);
          this.logger.info(
            result.deleted ? "tasks.completed" : "tasks.completion_already_handled",
            {
              id: task.id,
            },
          );
        } catch (error) {
          this.logger.warn("tasks.completion_failed", { id: task.id, error: String(error) });
        } finally {
          this.claimed.delete(task.id);
        }
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
}
