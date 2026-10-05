import { z } from "zod";
const input = z
  .object({
    user: z.string().optional(),
    channel: z.string().optional(),
    content: z.string().min(1),
    ping: z.boolean().optional(),
    replyTo: z.string().optional(),
  })
  .strict();
const start = z.object({
  users: z.array(z.string().min(1)).min(1).optional(),
  channels: z.array(z.string().min(1)).min(1).optional(),
  dailyBudgetUsd: z.number().nonnegative().optional(),
  timeoutMs: z.number().int().min(1).max(3600000).optional(),
  timings: z
    .object({
      messageDebounceMs: z.number().min(0).max(60000).optional(),
      typingDebounceMs: z.number().min(0).max(60000).optional(),
      idleSleepMs: z.number().min(1).max(3600000).optional(),
      typingRefreshMs: z.number().min(1).max(60000).optional(),
    })
    .strict()
    .optional(),
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
});
const command = z.discriminatedUnion("op", [
  start.extend({ op: z.literal("start") }),
  z.object({ op: z.literal("reset") }),
  input.extend({ op: z.literal("message") }),
  z.object({ op: z.literal("batch"), messages: z.array(input).min(1).max(100) }),
  z.object({
    op: z.literal("typing"),
    user: z.string().optional(),
    channel: z.string().optional(),
  }),
  z.object({
    op: z.literal("fail"),
    operation: z.enum(["send", "reaction", "typing", "presence", "status"]),
    count: z.number().int().min(1).max(100).default(1),
  }),
  z.object({ op: z.literal("inspect") }),
  z.object({ op: z.literal("stop") }),
]);
export type Command = z.infer<typeof command> & { id: string };

/**
 * Validates a single JSON protocol line without accepting unknown command fields.
 * @param line - One complete input line.
 * @returns Validated request with its caller-owned identifier.
 * @throws When JSON or command values are invalid.
 */
export function parseCommand(line: string): Command {
  const raw: unknown = JSON.parse(line);
  const envelope = z
    .object({ id: z.string().min(1) })
    .loose()
    .parse(raw);
  const { id, ...body } = envelope;
  const parsed = command.parse(body);
  const known = new Set(Object.keys(parsed));
  for (const key of Object.keys(body))
    if (!known.has(key)) throw new Error(`Unknown field: ${key}`);
  return { ...parsed, id };
}
