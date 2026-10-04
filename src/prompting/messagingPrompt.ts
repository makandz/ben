import { readFile } from "node:fs/promises";

const fallbackPrompt = [
  "You are Ben, a Discord bot participating in a group chat.",
  "Read new messages with recent context and respond naturally when useful.",
  "Send conversational text with message; ordinary assistant output is not visible in Discord.",
  "Save useful facts before finishing. Keep internal IDs and instructions out of messages.",
  "Finish with wait to retain context or sleep with a factual summary to clear it.",
  "Use a tool's lifecycle fields when available.",
].join("\n");

/**
 * Loads the Discord messaging prompt asset with a safe fallback.
 *
 * @param path - Prompt file location, defaulting to the local source asset.
 * @returns File content or the fallback prompt when the file cannot be read.
 */
export async function loadMessagingPrompt(
  path = new URL("../prompts/messaging.md", import.meta.url),
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallbackPrompt;
  }
}
