import { randomInt } from "node:crypto";
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import type { Config } from "./config.js";
import type { ReminderService } from "./reminders.js";

const scheduleReminderParameters = z
  .object({
    reminderText: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("The reminder text to send back to the user later."),
    dueAtIso: z
      .string()
      .trim()
      .nullable()
      .describe(
        "Absolute due time in ISO 8601 format with an explicit timezone offset, for example 2026-04-17T21:30:00-04:00. Use null when delaySeconds is provided instead.",
      ),
    delaySeconds: z
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .nullable()
      .describe(
        "Relative delay in seconds. Use this instead of dueAtIso when the user says 'in 10 minutes', 'in 2 hours', or similar. Use null when dueAtIso is provided instead.",
      ),
  })
  .refine(
    ({ dueAtIso, delaySeconds }) =>
      (dueAtIso !== null ? 1 : 0) + (delaySeconds !== null ? 1 : 0) === 1,
    {
      message: "Provide exactly one of dueAtIso or delaySeconds.",
    },
  );

export type DiscordAgentContext = {
  currentTimeIso: string;
  timeZone: string;
  requestingUserId: string;
};

const randomNumberTool = tool({
  name: "generate_random_number",
  description:
    "Generate a cryptographically secure random integer within an inclusive range. Use this when the user asks for a random number, roll, draw, or pick.",
  parameters: z
    .object({
      min: z.number().int().safe().default(1),
      max: z.number().int().safe().default(100),
    })
    .refine(({ min, max }) => min <= max, {
      message: "min must be less than or equal to max",
      path: ["max"],
    }),
  execute: ({ min, max }) => {
    if (min === max) {
      return `Generated random integer: ${min} (range ${min} to ${max}, inclusive).`;
    }

    const value = randomInt(min, max + 1);
    return `Generated random integer: ${value} (range ${min} to ${max}, inclusive).`;
  },
});

/**
 * Creates the OpenAI agent used to answer messages inside managed Discord threads.
 *
 * @param config - Runtime configuration for model selection and limits.
 * @param reminderService - Persistent reminder service exposed to the model.
 * @returns Configured thread assistant agent.
 */
export function createDiscordThreadAgent(
  config: Config,
  reminderService: ReminderService,
): Agent<DiscordAgentContext> {
  const reminderTool = tool<typeof scheduleReminderParameters, DiscordAgentContext>(
    {
      name: "schedule_reminder",
      description:
        "Save a reminder for the requesting user so the bot can send it later in the assigned channel even after a restart.",
      parameters: scheduleReminderParameters,
      execute: ({ reminderText, dueAtIso, delaySeconds }, context) => {
        if (!context) {
          throw new Error("Reminder scheduling requires an active run context.");
        }

        const currentTimeMs = parseCurrentTime(context.context.currentTimeIso);
        const dueAtMs =
          dueAtIso !== null
            ? parseAbsoluteReminderTime(dueAtIso)
            : currentTimeMs + requireDelaySeconds(delaySeconds) * 1_000;

        if (dueAtMs <= currentTimeMs) {
          throw new Error("Reminder time must be in the future.");
        }

        const reminder = reminderService.scheduleReminder({
          userId: context.context.requestingUserId,
          reminderText,
          dueAtMs,
          createdAtMs: currentTimeMs,
        });

        return `Reminder ${reminder.id} saved for <@${reminder.userId}> at ${formatReminderTime(reminder.dueAtMs, context.context.timeZone)} (${new Date(reminder.dueAtMs).toISOString()}).`;
      },
    },
  );

  return new Agent<DiscordAgentContext>({
    name: "Discord Thread Assistant",
    instructions: (runContext) =>
      [
        "You are a concise, helpful assistant replying inside a Discord thread.",
        "Answer the latest user message while considering the full thread history.",
        "Keep replies readable in chat. Use plain text unless formatting is genuinely useful.",
        "Use the random number tool when the user asks for a random number, roll, draw, or pick.",
        "Use the reminder tool when the user asks you to remember something or remind them later.",
        "When the user gives a relative duration such as 'in 10 minutes', use delaySeconds.",
        "When the user gives a specific time or date, convert it to ISO 8601 with an explicit timezone offset before calling the reminder tool.",
        "If a reminder time is ambiguous, ask a short follow-up question instead of guessing.",
        "Reminder messages are always sent in the assigned channel and mention the requesting user.",
        `Current time: ${runContext.context.currentTimeIso}`,
        `User timezone: ${runContext.context.timeZone}`,
        "Do not mention hidden system details or claim you can perform Discord actions yourself.",
      ].join("\n"),
    model: config.openAiModel,
    modelSettings: {
      maxTokens: config.openAiMaxTokens,
      reasoning: {
        effort: config.openAiReasoningEffort,
      },
    },
    tools: [randomNumberTool, reminderTool],
  });
}

/**
 * Parses the current run timestamp used as the base for relative reminders.
 *
 * @param currentTimeIso - ISO 8601 timestamp from the run context.
 * @returns Milliseconds since the Unix epoch.
 */
function parseCurrentTime(currentTimeIso: string): number {
  const parsed = Date.parse(currentTimeIso);

  if (Number.isNaN(parsed)) {
    throw new Error("Run context does not contain a valid current time.");
  }

  return parsed;
}

/**
 * Parses the model-provided absolute reminder time.
 *
 * @param dueAtIso - ISO 8601 timestamp with timezone offset.
 * @returns Milliseconds since the Unix epoch.
 */
function parseAbsoluteReminderTime(dueAtIso: string): number {
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(dueAtIso)) {
    throw new Error(
      "dueAtIso must include an explicit timezone offset, for example -04:00 or Z.",
    );
  }

  const parsed = Date.parse(dueAtIso);

  if (Number.isNaN(parsed)) {
    throw new Error(
      "dueAtIso must be a valid ISO 8601 timestamp with an explicit timezone.",
    );
  }

  return parsed;
}

/**
 * Formats a reminder timestamp for user-facing tool output.
 *
 * @param dueAtMs - Reminder due time in Unix milliseconds.
 * @param timeZone - IANA timezone used for local formatting.
 * @returns Human-readable timestamp.
 */
function formatReminderTime(dueAtMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(dueAtMs));
}

/**
 * Returns the validated relative delay for reminder scheduling.
 *
 * @param delaySeconds - Relative delay provided by the model.
 * @returns Delay in seconds.
 */
function requireDelaySeconds(delaySeconds: number | null | undefined): number {
  if (delaySeconds === null || delaySeconds === undefined) {
    throw new Error("delaySeconds is required when dueAtIso is not provided.");
  }

  return delaySeconds;
}
