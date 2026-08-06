import { readFile } from "node:fs/promises";

const systemPromptUrls = {
  ben: new URL("../../prompts/ben.txt", import.meta.url),
} as const;

export type SystemPromptName = keyof typeof systemPromptUrls;

/**
 * Loads a named system prompt from the repository's prompt directory.
 *
 * @param name - The registered system prompt to load.
 * @returns The trimmed contents of the system prompt.
 */
export async function loadSystemPrompt(name: SystemPromptName): Promise<string> {
  const prompt = (await readFile(systemPromptUrls[name], "utf8")).trim();

  if (!prompt) {
    throw new Error(`System prompt is empty: ${name}`);
  }

  return prompt;
}
