import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_SYSTEM_PROMPT_PATH = resolve(process.cwd(), "system-prompt.txt");

/**
 * Loads the base system prompt text used to initialize the Discord agent.
 *
 * @param promptPath - Absolute or relative path to the prompt text file.
 * @returns Trimmed prompt text loaded from disk.
 */
export function loadSystemPrompt(
  promptPath = DEFAULT_SYSTEM_PROMPT_PATH,
): string {
  const prompt = readFileSync(promptPath, "utf8").trim();

  if (!prompt) {
    throw new Error(`System prompt file is empty: ${promptPath}`);
  }

  return prompt;
}
