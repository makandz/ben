import { z } from "zod";

const message = z
  .object({
    user: z.string().optional(),
    channel: z.string().optional(),
    content: z.string().min(1),
    ping: z.boolean().optional(),
  })
  .strict();
const command = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("start"),
      fresh: z.boolean().optional(),
      users: z.array(z.string().min(1)).min(1).optional(),
      channels: z.array(z.string().min(1)).min(1).optional(),
      dailyBudgetUsd: z.number().nonnegative().optional(),
      seed: z
        .partialRecord(
          z.enum([
            "conversation-summaries.json",
            "known-people.json",
            "tasks.json",
            "custom-status.json",
            "memories.json",
            "long-term-memory.txt",
          ]),
          z.unknown(),
        )
        .optional(),
    })
    .strict(),
  message.extend({ op: z.literal("message") }),
  z.object({ op: z.literal("batch"), messages: z.array(message).min(1).max(100) }).strict(),
  z.object({ op: z.literal("inspect") }).strict(),
  z.object({ op: z.literal("stop") }).strict(),
]);
export type Command = z.infer<typeof command>;

/**
 * Validates one JSONL command, rejecting unknown fields and invalid values.
 * @param line - One complete input line.
 * @returns Validated command.
 * @throws When JSON or command values are invalid.
 */
export function parseCommand(line: string): Command {
  return command.parse(JSON.parse(line));
}
