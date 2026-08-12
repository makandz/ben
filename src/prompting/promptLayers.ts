import { readFile } from "node:fs/promises";

/**
 * Loads the general-purpose prompt shared by every model workflow.
 *
 * @param path - Prompt file location, defaulting to the bundled base prompt asset.
 * @returns File content or an empty layer when the file cannot be read.
 */
export async function loadBasePrompt(
  path = new URL("../prompts/base.md", import.meta.url),
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Layers general-purpose instructions before instructions for a specific workflow.
 *
 * @param basePrompt - Instructions shared by every model workflow.
 * @param taskPrompt - Instructions specific to the current model workflow.
 * @returns The non-empty prompt layers joined in precedence order.
 */
export function composeInstructions(basePrompt: string, taskPrompt: string): string {
  return [basePrompt.trim(), taskPrompt.trim()].filter((prompt) => prompt.length > 0).join("\n\n");
}
