import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { loadPrompt } from "../utils/promptLoader.js";

const MODEL = "gemini-2.5-flash-lite";

class AIService {
  private client: GoogleGenAI;
  private busy = false;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }

  isBusy(): boolean {
    return this.busy;
  }

  async generateResponse(
    userMessage: string,
    promptName = "system"
  ): Promise<string> {
    this.busy = true;
    try {
      const systemInstruction = await loadPrompt(promptName);

      const response = await this.client.models.generateContent({
        model: MODEL,
        contents: userMessage,
        config: { systemInstruction },
      });

      return response.text ?? "I could not generate a response.";
    } finally {
      this.busy = false;
    }
  }
}

export const aiService = new AIService();
