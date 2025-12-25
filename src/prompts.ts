import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/**
 * Get a prompt from the cache or from the file system.
 * @param key - The key of the prompt to get.
 * @returns The prompt.
 */
export const getPrompt = async (key: string): Promise<string> => {
  if (cache.has(key)) {
    return cache.get(key)!;
  }

  const filePath = join(__dirname, "prompts", `${key}.txt`);
  const content = await readFile(filePath, "utf-8");
  cache.set(key, content);

  return content;
};
