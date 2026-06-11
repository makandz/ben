import { z } from "zod";

const blockedStatusTerms = [
  "assistant",
  "available",
  "coding",
  "debugging",
  "grinding",
  "headphones",
  "helping",
  "listening",
  "online",
  "programming",
  "productivity",
  "shipping",
  "working",
];

export const internalStatusSchema = z.object({
  emoji: z.string().trim().refine(isSingleUnicodeEmoji, {
    message: "emoji must be exactly one unicode emoji",
  }),
  text: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .transform((value) => value.replace(/\s+/g, " "))
    .refine((value) => value === value.toLowerCase(), {
      message: "text must be lowercase",
    })
    .refine((value) => !blockedStatusTerms.some((term) => value.includes(term)), {
      message: "text contains a blocked status term",
    }),
});

export type InternalStatus = z.infer<typeof internalStatusSchema>;

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

function isSingleUnicodeEmoji(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];

  if (graphemes.length !== 1) {
    return false;
  }

  return (
    /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}\uFE0F\u200D]+$/u.test(
      value,
    ) || /^\p{Regional_Indicator}{2}$/u.test(value)
  );
}
