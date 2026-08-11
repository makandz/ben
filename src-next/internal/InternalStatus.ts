import { z } from "zod";

import { isSingleUnicodeEmoji } from "../util/emoji.js";

const blockedTerms = [
  "assistant", "available", "coding", "debugging", "grinding", "headphones", "helping",
  "listening", "online", "programming", "productivity", "shipping", "working",
];

export const internalStatusSchema = z.object({
  emoji: z.string().trim().refine(isSingleUnicodeEmoji, {
    message: "emoji must be exactly one unicode emoji",
  }),
  text: z.string().trim().min(2).max(48)
    .transform((value) => value.replace(/\s+/g, " "))
    .refine((value) => value === value.toLowerCase(), { message: "text must be lowercase" })
    .refine((value) => !blockedTerms.some((term) => value.includes(term)), {
      message: "text contains a blocked status term",
    }),
});

export type InternalStatus = z.infer<typeof internalStatusSchema>;

/**
 * Parses and validates the status action's JSON-only model response.
 *
 * @param text - Raw assistant response text.
 * @returns A normalized valid status.
 */
export function parseInternalStatusPayload(text: string): InternalStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Internal status action returned invalid JSON.");
  }
  const result = internalStatusSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Internal status action returned invalid status: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Formats a safe custom activity string.
 *
 * @param status - Valid status emoji and text.
 * @returns Discord custom activity text with quotes neutralized.
 */
export function formatActivityStatus(status: InternalStatus): string {
  return `${status.emoji} ${status.text}`.replace(/"/g, "'");
}
