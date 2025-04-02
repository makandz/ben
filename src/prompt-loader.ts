import { promises as fs } from "fs";
import path from "path";

export async function promptLoader(): Promise<Map<string, string>> {
  // Construct the absolute path to the src/prompts directory.
  const promptsDir = path.join(process.cwd(), "src", "prompts");
  const promptMap = new Map<string, string>();

  try {
    // Read all files in the prompts directory.
    const files = await fs.readdir(promptsDir);

    // Process only .txt files.
    for (const file of files) {
      if (file.endsWith(".txt")) {
        const filePath = path.join(promptsDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        // Remove the .txt extension from the filename.
        const key = path.basename(file, ".txt");
        promptMap.set(key, content);
      }
    }
  } catch (error) {
    console.error("Error reading prompts directory:", error);
  }

  return promptMap;
}
