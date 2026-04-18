import { randomInt } from "node:crypto";
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  logToolInvocationFailure,
  logToolInvocationStart,
  logToolInvocationSuccess,
} from "./openai-logging.js";
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
  announceToolExecution: (toolName: string) => Promise<void>;
  sendStatusUpdate: (message: string) => Promise<void>;
};

const randomNumberTool = tool<
  z.ZodObject<{
    min: z.ZodDefault<z.ZodNumber>;
    max: z.ZodDefault<z.ZodNumber>;
  }>,
  DiscordAgentContext
>({
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
  execute: async ({ min, max }, context) => {
    const payload = { min, max };

    try {
      await beginToolInvocation(
        "generate_random_number",
        payload,
        context,
      );

      const result =
        min === max
          ? `Generated random integer: ${min} (range ${min} to ${max}, inclusive).`
          : `Generated random integer: ${randomInt(min, max + 1)} (range ${min} to ${max}, inclusive).`;

      logToolInvocationSuccess("generate_random_number", result);
      return result;
    } catch (error) {
      logToolInvocationFailure("generate_random_number", payload, error);
      throw error;
    }
  },
});

/**
 * Creates the OpenAI agent used to answer messages inside managed Discord threads.
 *
 * @param config - Runtime configuration for model selection and limits.
 * @param reminderService - Persistent reminder service exposed to the model.
 * @param systemPrompt - Base instructions loaded from the startup prompt text file.
 * @returns Configured thread assistant agent.
 */
export function createDiscordThreadAgent(
  config: Config,
  reminderService: ReminderService,
  systemPrompt: string,
): Agent<DiscordAgentContext> {
  const statusUpdateTool = tool<
    z.ZodObject<{
      message: z.ZodString;
    }>,
    DiscordAgentContext
  >({
    name: "send_status_update",
    description:
      "Send a short progress update into the current Discord thread as a normal chat message while you work. Use this before starting a multi-step tool chain and between dependent tool calls when the user would benefit from seeing what you are doing next.",
    parameters: z.object({
      message: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          "A concise natural-language progress update for the user. Summarize the last result and the next step when chaining tools.",
        ),
    }),
    execute: async ({ message }, context) => {
      const payload = { message };

      try {
        logToolInvocationStart("send_status_update", payload);

        if (!context) {
          throw new Error("Status updates require an active run context.");
        }

        await context.context.sendStatusUpdate(message);
        const result = "Status update sent.";
        logToolInvocationSuccess("send_status_update", result);
        return result;
      } catch (error) {
        logToolInvocationFailure("send_status_update", payload, error);
        throw error;
      }
    },
  });

  const reminderTool = tool<typeof scheduleReminderParameters, DiscordAgentContext>(
    {
      name: "schedule_reminder",
      description:
        "Save a reminder for the requesting user so the bot can send it later in the assigned channel even after a restart.",
      parameters: scheduleReminderParameters,
      execute: async ({ reminderText, dueAtIso, delaySeconds }, context) => {
        const payload = {
          reminderText,
          dueAtIso,
          delaySeconds,
        };

        try {
          const activeContext = await beginToolInvocation(
            "schedule_reminder",
            payload,
            context,
          );

          const currentTimeMs = parseCurrentTime(
            activeContext.context.currentTimeIso,
          );
          const dueAtMs =
            dueAtIso !== null
              ? parseAbsoluteReminderTime(dueAtIso)
              : currentTimeMs + requireDelaySeconds(delaySeconds) * 1_000;

          if (dueAtMs <= currentTimeMs) {
            throw new Error("Reminder time must be in the future.");
          }

          const reminder = reminderService.scheduleReminder({
            userId: activeContext.context.requestingUserId,
            reminderText,
            dueAtMs,
            createdAtMs: currentTimeMs,
          });

          const result = `Reminder ${reminder.id} saved for <@${reminder.userId}> at ${formatReminderTime(reminder.dueAtMs, activeContext.context.timeZone)} (${new Date(reminder.dueAtMs).toISOString()}).`;
          logToolInvocationSuccess("schedule_reminder", result);
          return result;
        } catch (error) {
          logToolInvocationFailure("schedule_reminder", payload, error);
          throw error;
        }
      },
    },
  );

  return new Agent<DiscordAgentContext>({
    name: "Discord Thread Assistant",
    instructions: (runContext) =>
      [
        systemPrompt,
        `Current time: ${runContext.context.currentTimeIso}`,
        `User timezone: ${runContext.context.timeZone}`,
      ].join("\n"),
    model: config.openAiModel,
    modelSettings: {
      maxTokens: config.openAiMaxTokens,
      parallelToolCalls: false,
      reasoning: {
        effort: config.openAiReasoningEffort,
      },
    },
    tools: [statusUpdateTool, randomNumberTool, reminderTool],
  });
}

/**
 * Logs the start of a tool invocation and posts the Discord tool-status message immediately.
 *
 * @param toolName - Tool that has just started executing.
 * @param payload - Parsed tool arguments for logging.
 * @param context - Active tool execution context.
 * @returns Active tool execution context.
 */
async function beginToolInvocation(
  toolName: string,
  payload: Record<string, unknown>,
  context: { context: DiscordAgentContext } | undefined,
): Promise<{ context: DiscordAgentContext }> {
  logToolInvocationStart(toolName, payload);

  if (!context) {
    throw new Error(`${toolName} requires an active run context.`);
  }

  await context.context.announceToolExecution(toolName);
  return context;
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
