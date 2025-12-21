import { readFile } from "fs/promises";
import { join } from "path";

const cache = new Map<string, string>();

export async function loadPrompt(name: string): Promise<string> {
  if (cache.has(name)) {
    return cache.get(name)!;
  }

  const path = join(process.cwd(), "prompts", `${name}.txt`);
  const content = await readFile(path, "utf-8");
  cache.set(name, content);
  return content;
}

export function clearPromptCache(): void {
  cache.clear();
}
