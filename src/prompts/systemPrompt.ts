import { readFile } from "node:fs/promises";

const fallbackPrompt = [
  "You are a Discord bot participating in a group chat.",
  "Reply naturally when a response is useful.",
  "If no response is needed, return exactly N/A.",
].join("\n");

/**
 * Loads the system prompt asset with a safe fallback.
 *
 * @param path - Prompt file location, defaulting to the local source asset.
 * @returns File content or the fallback prompt when the file cannot be read.
 */
export async function loadSystemPrompt(
  path = new URL("./system.txt", import.meta.url),
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallbackPrompt;
  }
}
