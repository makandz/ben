import { randomUUID } from "node:crypto";

import type { Logger } from "../logger.js";
import type { ScheduleRepeat } from "../scheduling/scheduleTime.js";
import { isRecord, readJsonFile, UpdateQueue, writeJsonFileAtomic } from "./JsonFile.js";

export type TaskDestination = {
  kind: "current" | "named" | "own";
  channelId: string;
  channelName: string;
};

export type AutonomousTask = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  destination: TaskDestination;
  runDate: string;
  runTime: string;
  repeat: ScheduleRepeat;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskDefinitionInput = {
  name: string;
  description: string;
  instructions: string;
  destination: TaskDestination;
  runDate: string;
  runTime: string;
  repeat: ScheduleRepeat;
  nextRunAt: Date;
};

export type TaskSnapshot = {
  revision: number;
  tasks: AutonomousTask[];
};

export type TaskMutationResult =
  | { ok: true; task: AutonomousTask; revision: number }
  | { ok: false; error: string; revision: number };

export type TaskCompletionResult = {
  deleted: boolean;
  revision: number;
};

type TasksData = {
  version: number;
  revision: number;
  tasks: AutonomousTask[];
};

/** Persists Ben's self-authored autonomous tasks with optimistic revision checks. */
export class TaskStore {
  private readonly updates = new UpdateQueue();

  /**
   * Creates a task store backed by an atomic JSON file.
   *
   * @param filePath - Path to the task JSON file.
   * @param logger - Logger used when malformed individual entries are ignored.
   */
  constructor(
    private readonly filePath: string,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /**
   * Lists every task together with the revision required for a subsequent create or edit.
   *
   * @returns A snapshot of all tasks and the current monotonically increasing revision.
   */
  async list(): Promise<TaskSnapshot> {
    const data = await this.read();
    return { revision: data.revision, tasks: data.tasks };
  }

  /**
   * Creates and atomically persists a task when the caller viewed the current revision.
   *
   * @param expectedRevision - Revision returned by the immediately preceding task view.
   * @param input - Fully validated task definition and resolved destination.
   * @param now - Creation instant, replaceable for deterministic tests.
   * @returns The created task or a stale-revision/name-conflict failure.
   */
  async create(
    expectedRevision: number,
    input: TaskDefinitionInput,
    now = new Date(),
  ): Promise<TaskMutationResult> {
    return this.updates.run(async () => {
      const data = await this.read();
      const precondition = validateMutation(data, expectedRevision, input.name);
      if (precondition !== undefined) return precondition;

      const timestamp = now.toISOString();
      const task: AutonomousTask = {
        id: `task_${randomUUID().slice(0, 8)}`,
        ...input,
        nextRunAt: input.nextRunAt.toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.tasks.push(task);
      data.revision += 1;
      await writeJsonFileAtomic(this.filePath, data);
      return { ok: true, task, revision: data.revision };
    });
  }

  /**
   * Replaces an existing task when the caller viewed the current revision.
   *
   * @param id - Stable identifier of the task being replaced.
   * @param expectedRevision - Revision returned by the immediately preceding task view.
   * @param input - Complete validated replacement definition and resolved destination.
   * @param now - Update instant, replaceable for deterministic tests.
   * @returns The updated task or a stale-revision, missing-task, or name-conflict failure.
   */
  async replace(
    id: string,
    expectedRevision: number,
    input: TaskDefinitionInput,
    now = new Date(),
  ): Promise<TaskMutationResult> {
    return this.updates.run(async () => {
      const data = await this.read();
      if (expectedRevision !== data.revision) return staleRevision(data.revision);
      const index = data.tasks.findIndex((task) => task.id === id);
      if (index < 0) return failure(`task ${JSON.stringify(id)} does not exist`, data.revision);
      const duplicate = data.tasks.find(
        (task) => task.id !== id && normalizeName(task.name) === normalizeName(input.name),
      );
      if (duplicate !== undefined) {
        return failure(
          `a task named ${JSON.stringify(duplicate.name)} already exists`,
          data.revision,
        );
      }

      const existing = data.tasks[index];
      if (existing === undefined) return failure("task does not exist", data.revision);
      const task: AutonomousTask = {
        id: existing.id,
        ...input,
        nextRunAt: input.nextRunAt.toISOString(),
        createdAt: existing.createdAt,
        updatedAt: now.toISOString(),
      };
      data.tasks[index] = task;
      data.revision += 1;
      await writeJsonFileAtomic(this.filePath, data);
      return { ok: true, task, revision: data.revision };
    });
  }

  /**
   * Permanently removes a task without requiring a prior view revision.
   *
   * @param id - Stable identifier of the task to erase.
   * @returns The deleted task or a missing-task failure.
   */
  async delete(id: string): Promise<TaskMutationResult> {
    return this.updates.run(async () => {
      const data = await this.read();
      const index = data.tasks.findIndex((task) => task.id === id);
      if (index < 0) return failure(`task ${JSON.stringify(id)} does not exist`, data.revision);
      const [task] = data.tasks.splice(index, 1);
      if (task === undefined) return failure("task does not exist", data.revision);
      data.revision += 1;
      await writeJsonFileAtomic(this.filePath, data);
      return { ok: true, task, revision: data.revision };
    });
  }

  /**
   * Lists one-time tasks whose next run is due.
   *
   * @param now - Inclusive upper bound for due task timestamps.
   * @returns Due one-time tasks ordered by scheduled time and creation time.
   */
  async listDueOneTime(now: Date): Promise<AutonomousTask[]> {
    const data = await this.read();
    return data.tasks
      .filter(
        (task) => task.repeat === "none" && new Date(task.nextRunAt).getTime() <= now.getTime(),
      )
      .sort(
        (left, right) =>
          left.nextRunAt.localeCompare(right.nextRunAt) ||
          left.createdAt.localeCompare(right.createdAt),
      );
  }

  /**
   * Permanently removes a completed one-time task when it still exists.
   *
   * Missing tasks are treated as already completed so manual deletion races are harmless.
   *
   * @param id - Stable identifier of the completed task.
   * @param expectedUpdatedAt - Version timestamp captured when the occurrence was claimed.
   * @returns Whether this call deleted the task and the resulting store revision.
   */
  async completeOneTime(id: string, expectedUpdatedAt: string): Promise<TaskCompletionResult> {
    return this.updates.run(async () => {
      const data = await this.read();
      const index = data.tasks.findIndex((task) => task.id === id);
      if (index < 0) return { deleted: false, revision: data.revision };
      const task = data.tasks[index];
      if (task?.repeat !== "none" || task.updatedAt !== expectedUpdatedAt) {
        return { deleted: false, revision: data.revision };
      }
      data.tasks.splice(index, 1);
      data.revision += 1;
      await writeJsonFileAtomic(this.filePath, data);
      return { deleted: true, revision: data.revision };
    });
  }

  /** Reads the task container and ignores malformed individual entries. */
  private async read(): Promise<TasksData> {
    let parsed: unknown;
    try {
      parsed = await readJsonFile(this.filePath);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`${this.filePath} must contain valid JSON.`);
      throw error;
    }
    if (parsed === undefined) return { version: 1, revision: 0, tasks: [] };
    if (!isRecord(parsed)) throw new Error(`${this.filePath} must contain a JSON object.`);
    if (!Array.isArray(parsed.tasks)) return { version: 1, revision: 0, tasks: [] };
    const revision =
      typeof parsed.revision === "number" &&
      Number.isSafeInteger(parsed.revision) &&
      parsed.revision >= 0
        ? parsed.revision
        : 0;
    return {
      version: 1,
      revision,
      tasks: parsed.tasks
        .map((task) => parseTask(task, this.logger))
        .filter((task): task is AutonomousTask => task !== undefined),
    };
  }
}

/** Applies the revision and unique-name preconditions shared by task creation. */
function validateMutation(
  data: TasksData,
  expectedRevision: number,
  name: string,
): TaskMutationResult | undefined {
  if (expectedRevision !== data.revision) return staleRevision(data.revision);
  const duplicate = data.tasks.find((task) => normalizeName(task.name) === normalizeName(name));
  return duplicate === undefined
    ? undefined
    : failure(`a task named ${JSON.stringify(duplicate.name)} already exists`, data.revision);
}

/** Returns the actionable failure used when a task view is stale. */
function staleRevision(revision: number): TaskMutationResult {
  return failure("tasks changed since the last view; run view_tasks again", revision);
}

/** Builds a mutation failure without discarding the current revision. */
function failure(error: string, revision: number): TaskMutationResult {
  return { ok: false, error, revision };
}

/** Normalizes names for case-insensitive uniqueness checks. */
function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}

/** Parses one stored task while containing malformed entries. */
function parseTask(value: unknown, logger: Pick<Logger, "warn">): AutonomousTask | undefined {
  if (!isRecord(value) || !isRecord(value.destination)) return invalidTask(logger);
  const destination = value.destination;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.instructions !== "string" ||
    !isDestinationKind(destination.kind) ||
    typeof destination.channelId !== "string" ||
    typeof destination.channelName !== "string" ||
    typeof value.runDate !== "string" ||
    typeof value.runTime !== "string" ||
    !isScheduleRepeat(value.repeat) ||
    typeof value.nextRunAt !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return invalidTask(logger);
  }
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    instructions: value.instructions,
    destination: {
      kind: destination.kind,
      channelId: destination.channelId,
      channelName: destination.channelName,
    },
    runDate: value.runDate,
    runTime: value.runTime,
    repeat: value.repeat,
    nextRunAt: value.nextRunAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Logs one malformed entry and returns the filter sentinel. */
function invalidTask(logger: Pick<Logger, "warn">): undefined {
  logger.warn("tasks.invalid_entry_ignored");
  return undefined;
}

/** Narrows one persisted destination kind. */
function isDestinationKind(value: unknown): value is TaskDestination["kind"] {
  return value === "current" || value === "named" || value === "own";
}

/** Narrows one persisted recurrence. */
function isScheduleRepeat(value: unknown): value is ScheduleRepeat {
  return value === "none" || value === "daily" || value === "weekly";
}
