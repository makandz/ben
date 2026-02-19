import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const promptCache = new Map<string, string>();

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);
const promptsDirPath = path.resolve(thisDirPath, "../../prompts");

export async function loadPrompt(promptName: string): Promise<string> {
  const cachedPrompt = promptCache.get(promptName);

  if (cachedPrompt) {
    return cachedPrompt;
  }

  const promptPath = path.join(promptsDirPath, promptName);
  const prompt = await readFile(promptPath, "utf8");

  promptCache.set(promptName, prompt);
  return prompt;
}
