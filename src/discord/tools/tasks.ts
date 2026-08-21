import type { Logger } from "../../logger.js";
import { localScheduleToDate, type ScheduleRepeat } from "../../scheduling/scheduleTime.js";
import { SCHEDULE_TIME_ZONE } from "../../scheduling/ScheduledMessageScheduler.js";
import type { AutonomousTask, TaskDefinitionInput, TaskStore } from "../../storage/TaskStore.js";
import type { Tool, ToolResult } from "../../tools/Tool.js";
import type { ChannelMentionDirectory } from "../DiscordDirectory.js";
import {
  resolveChannelDestination,
  type ResolvedChannelDestination,
} from "../ChannelDestinationResolver.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { parseArguments, sanitizeText, sendToolStatus, toolFailure } from "./toolSupport.js";

type TaskToolStore = Pick<TaskStore, "list" | "create" | "replace" | "delete">;

export type TaskToolDependencies = {
  gateway: DiscordGateway;
  channels: ChannelMentionDirectory;
  store: TaskToolStore;
  getActiveChannelId(): string | undefined;
  getOwnChannelId(): string | undefined;
  logger: Pick<Logger, "warn">;
  timeZone?: string;
  now?: () => Date;
};

/**
 * Creates the tool that views all upcoming autonomous tasks and obtains their revision.
 *
 * @param dependencies - Task persistence and active Discord channel capabilities.
 * @returns A tool that lists full task metadata privately and posts only a count publicly.
 */
export function createViewTasksTool(dependencies: TaskToolDependencies): Tool {
  return {
    definition: {
      name: "view_tasks",
      description:
        "View every task you have created for yourself. You MUST call this immediately before create_task or edit_task and pass the returned revision unchanged.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    },
    async execute() {
      try {
        const snapshot = await dependencies.store.list();
        await status(
          dependencies,
          `> Ben is viewing ${String(snapshot.tasks.length)} task${snapshot.tasks.length === 1 ? "" : "s"}.`,
        );
        return { type: "continue", result: { ok: true, ...snapshot } };
      } catch (error) {
        return fail(dependencies, "view", undefined, String(error));
      }
    },
  };
}

/**
 * Creates the tool that stores a new self-authored autonomous task.
 *
 * @param dependencies - Task persistence, scheduling, and Discord channel capabilities.
 * @returns A tool requiring a fresh view revision and a complete task definition.
 */
export function createCreateTaskTool(dependencies: TaskToolDependencies): Tool {
  return {
    definition: {
      name: "create_task",
      description:
        "Create a future task for yourself. You MUST call view_tasks immediately beforehand and pass its current revision. Write detailed, self-contained instructions that your future self can interpret without the current conversation.",
      parameters: taskParameters(false),
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const name = sanitizeText(input.name, true);
      try {
        const parsed = await parseTaskDefinition(input, dependencies);
        const revision = parseRevision(input.revision);
        const result = await dependencies.store.create(revision, parsed);
        if (!result.ok) return await fail(dependencies, "create", name, result.error);
        await status(
          dependencies,
          `> Ben created task ${quote(result.task.name)} ${formatCreatedSchedule(result.task)}.`,
        );
        return {
          type: "continue",
          result: { ok: true, task: result.task, revision: result.revision },
        };
      } catch (error) {
        return fail(dependencies, "create", name, errorMessage(error));
      }
    },
  };
}

/**
 * Creates the tool that fully replaces an existing autonomous task.
 *
 * @param dependencies - Task persistence, scheduling, and Discord channel capabilities.
 * @returns A tool requiring a fresh view revision, stable task ID, and complete replacement definition.
 */
export function createEditTaskTool(dependencies: TaskToolDependencies): Tool {
  return {
    definition: {
      name: "edit_task",
      description:
        "Replace one of your existing tasks. You MUST call view_tasks immediately beforehand, use the task ID it returns, and pass its current revision. Supply the entire replacement task, including unchanged fields.",
      parameters: taskParameters(true),
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const name = sanitizeText(input.name, true);
      try {
        const id = requireText(input.task_id, "task_id", 100);
        const revision = parseRevision(input.revision);
        const before = await dependencies.store.list();
        const oldName = before.tasks.find((task) => task.id === id)?.name;
        const parsed = await parseTaskDefinition(input, dependencies);
        const result = await dependencies.store.replace(id, revision, parsed);
        if (!result.ok) return await fail(dependencies, "update", oldName ?? name, result.error);
        const rename = oldName !== undefined && oldName !== result.task.name;
        const subject = rename
          ? `${quote(oldName)} to ${quote(result.task.name)}`
          : quote(result.task.name);
        await status(
          dependencies,
          `> Ben updated his task ${subject}. Next run: ${formatNextRun(result.task)}.`,
        );
        return {
          type: "continue",
          result: { ok: true, task: result.task, revision: result.revision },
        };
      } catch (error) {
        return fail(dependencies, "update", name, errorMessage(error));
      }
    },
  };
}

/**
 * Creates the tool that permanently deletes an autonomous task.
 *
 * @param dependencies - Task persistence and active Discord channel capabilities.
 * @returns A tool that erases one task by its stable identifier.
 */
export function createDeleteTaskTool(dependencies: TaskToolDependencies): Tool {
  return {
    definition: {
      name: "delete_task",
      description:
        "Permanently delete one of your tasks by the stable task ID returned from view_tasks. Deletion does not require a revision.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: {
            type: "string",
            minLength: 1,
            description: "Stable ID of the task to delete.",
          },
        },
        required: ["task_id"],
      },
    },
    async execute(call) {
      try {
        const id = requireText(parseArguments(call.arguments).task_id, "task_id", 100);
        const result = await dependencies.store.delete(id);
        if (!result.ok) return await fail(dependencies, "delete", undefined, result.error);
        await status(dependencies, `> Ben deleted his task ${quote(result.task.name)}.`);
        return {
          type: "continue",
          result: { ok: true, task: result.task, revision: result.revision },
        };
      } catch (error) {
        return fail(dependencies, "delete", undefined, errorMessage(error));
      }
    },
  };
}

/** Returns the shared complete-definition schema for create and edit. */
function taskParameters(includeId: boolean): Readonly<Record<string, unknown>> {
  const properties: Record<string, unknown> = {
    revision: {
      type: "integer",
      minimum: 0,
      description: "Exact revision returned by the immediately preceding view_tasks call.",
    },
    name: { type: "string", minLength: 1, maxLength: 100, description: "Unique task title." },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Short summary shown when viewing tasks.",
    },
    instructions: {
      type: "string",
      minLength: 1,
      maxLength: 4_000,
      description:
        "Detailed, self-contained instructions you are writing for your future self, including relevant people, context, desired actions, and outcome.",
    },
    channel: {
      type: ["string", "null"],
      description:
        'Where the task should wake you. Use "current" for this exact channel, a readable channel name such as "#general" for another channel, or null for your own channel.',
    },
    run_date: {
      type: "string",
      description: "Exact next local run date in YYYY-MM-DD format.",
    },
    run_time: {
      type: "string",
      description: "Exact next local run time in 24-hour HH:mm format.",
    },
    repeat: {
      type: "string",
      enum: ["none"],
      description: "One-time execution. Recurring tasks are not available yet.",
    },
  };
  if (includeId) {
    properties.task_id = {
      type: "string",
      minLength: 1,
      description: "Stable ID returned by view_tasks for the task being replaced.",
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: [
      ...(includeId ? ["task_id"] : []),
      "revision",
      "name",
      "description",
      "instructions",
      "channel",
      "run_date",
      "run_time",
      "repeat",
    ],
  };
}

/** Validates a complete model task definition and resolves its Discord destination. */
async function parseTaskDefinition(
  input: Record<string, unknown>,
  dependencies: TaskToolDependencies,
): Promise<TaskDefinitionInput> {
  const name = requireText(input.name, "name", 100, true);
  const description = requireText(input.description, "description", 300, true);
  const instructions = requireText(input.instructions, "instructions", 4_000);
  const runDate = requireText(input.run_date, "run_date", 10);
  const runTime = requireText(input.run_time, "run_time", 5);
  const repeat = parseRepeat(input.repeat);
  if (repeat !== "none")
    throw new Error("repeat must be none; recurring tasks are not available yet");
  if (input.channel !== null && typeof input.channel !== "string") {
    throw new Error('channel must be "current", a channel name, or null');
  }

  const nextRunAt = localScheduleToDate({
    runDate,
    runTime,
    timeZone: dependencies.timeZone ?? SCHEDULE_TIME_ZONE,
  });
  if (nextRunAt.getTime() <= (dependencies.now ?? (() => new Date()))().getTime()) {
    throw new Error("run_date and run_time must be in the future");
  }
  const resolved = await resolveChannelDestination(input.channel, {
    gateway: dependencies.gateway,
    channels: dependencies.channels,
    currentChannelId: dependencies.getActiveChannelId(),
    ownChannelId: dependencies.getOwnChannelId(),
  });
  return {
    name,
    description,
    instructions,
    destination: toStoredDestination(resolved),
    runDate,
    runTime,
    repeat,
    nextRunAt,
  };
}

/** Converts a verified destination into its stable persisted representation. */
function toStoredDestination(
  resolved: ResolvedChannelDestination,
): TaskDefinitionInput["destination"] {
  return {
    kind: resolved.kind,
    channelId: resolved.channel.id,
    channelName: resolved.channel.name ?? resolved.channel.id,
  };
}

/** Reads a bounded required text argument. */
function requireText(
  value: unknown,
  field: string,
  maximum: number,
  collapseWhitespace = false,
): string {
  const text = sanitizeText(value, collapseWhitespace);
  if (text.length === 0 || text.length > maximum) {
    throw new Error(`${field} must be 1-${String(maximum)} characters`);
  }
  return text;
}

/** Narrows a required non-negative integer task revision. */
function parseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("revision must be the non-negative integer returned by view_tasks");
  }
  return value;
}

/** Narrows one model recurrence argument. */
function parseRepeat(value: unknown): ScheduleRepeat | undefined {
  return value === "none" || value === "daily" || value === "weekly" ? value : undefined;
}

/** Formats a newly created task's recurrence, start, and destination. */
function formatCreatedSchedule(task: AutonomousTask): string {
  const time = formatClockTime(task.runTime);
  const schedule =
    task.repeat === "none"
      ? `to run ${formatWeekday(task.runDate)} at ${time}`
      : task.repeat === "daily"
        ? `to run every day at ${time}`
        : `to run every ${formatWeekday(task.runDate)} at ${time}`;
  return `${schedule} ${formatDestination(task)}`;
}

/** Formats the next run and destination in an edit confirmation. */
function formatNextRun(task: AutonomousTask): string {
  return `${formatWeekday(task.runDate)} at ${formatClockTime(task.runTime)} ${formatDestination(task)}`;
}

/** Formats the validated local date as a weekday for lightweight Discord status copy. */
function formatWeekday(runDate: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    new Date(`${runDate}T00:00:00.000Z`),
  );
}

/** Formats validated 24-hour local time with a compact 12-hour clock. */
function formatClockTime(runTime: string): string {
  const [hourText, minuteText] = runTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const suffix = hour >= 12 ? "PM" : "AM";
  const clockHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(clockHour)}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** Formats either a readable Discord channel or Ben's private own-channel destination. */
function formatDestination(task: AutonomousTask): string {
  return task.destination.kind === "own"
    ? "in his own channel"
    : `in #${task.destination.channelName}`;
}

/** Quotes a task name using straight double quotes with safe escaping. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** Sends one lightweight task activity message to the active channel. */
async function status(dependencies: TaskToolDependencies, text: string): Promise<void> {
  await sendToolStatus(
    dependencies.gateway,
    dependencies.logger,
    "discord.task_status_failed",
    dependencies.getActiveChannelId(),
    text,
  );
}

/** Sends a visible failure and returns the same failure to the model. */
async function fail(
  dependencies: TaskToolDependencies,
  action: "view" | "create" | "update" | "delete",
  name: string | undefined,
  error: string,
): Promise<ToolResult> {
  const possessive = action === "update" || action === "delete" ? " his task" : " task";
  const subject = name === undefined || name.length === 0 ? "" : ` ${quote(name)}`;
  const phrase = action === "view" ? "view his tasks" : `${action}${possessive}${subject}`;
  await status(dependencies, `> ⚠️ Ben couldn't ${phrase}: ${stripFinalPeriod(error)}.`);
  return toolFailure(error);
}

/** Converts thrown values to concise messages. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Avoids doubled punctuation in visible failures. */
function stripFinalPeriod(value: string): string {
  return value.replace(/\.+$/, "");
}
