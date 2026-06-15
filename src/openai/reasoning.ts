import type { ResponseOutputItem } from "openai/resources/responses/responses";

export function extractReasoningSummary(output: ResponseOutputItem[]): string | undefined {
  const text = output
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => item.summary)
    .map((summary) => summary.text.trim())
    .filter((summary) => summary.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > 0 ? text : undefined;
}
