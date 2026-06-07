import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logger.js";

const fallbackPrompt = [
  "You are a Discord bot participating in a group chat.",
  "Reply naturally when a response is useful.",
  "If no response is needed, return exactly N/A.",
].join("\n");

const systemPromptPath = path.join(process.cwd(), "src", "prompts", "system.txt");

export async function loadSystemPrompt(logger: Logger): Promise<string> {
  try {
    const prompt = await readFile(systemPromptPath, "utf8");
    logger.debug("prompt.loaded", { chars: prompt.length });
    return prompt;
  } catch (error) {
    logger.warn("prompt.load_failed", { path: systemPromptPath, error: String(error) });
    return fallbackPrompt;
  }
}
