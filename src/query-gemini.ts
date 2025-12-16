import { GoogleGenAI, Schema } from "@google/genai";
import { GOOGLE_API_KEY } from "./config.js";
import { promptLoader } from "./prompt-loader.js";
import { tryCatch } from "./utils/trycatch.js";

type SupportedPromptKeys = "conversation" | "think-should-respond";

const prompts = await promptLoader();
const googleGenAI = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

/**
 * Get embeddings for a text using Gemini's embedding model
 * @param text The text to get embeddings for
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const { data, error } = await tryCatch(
    googleGenAI.models.embedContent({
      model: "gemini-embedding-exp-03-07",
      contents: [{ text }], // this supports multiple
    })
  );

  if (error) {
    console.error("Error getting embedding from Gemini:", error);
    throw error;
  }

  if (!data.embeddings || !data.embeddings[0].values) {
    console.error("No embeddings found in the response.");
    throw new Error("No embeddings found in the response.");
  }

  return data.embeddings[0].values;
}

/**
 * Requests a response from the Gemini model using the provided prompt.
 * @param prompt The prompt to send to the model.
 * @param promptKey Optional key to fetch a predefined prompt from the system prompts map.
 */
export async function queryGemini(
  prompt: string,
  promptKey?: SupportedPromptKeys,
  schema?: Schema,
  maxTokens?: number
): Promise<string> {
  if (promptKey && !prompts.has(promptKey)) {
    console.error(`Prompt key "${promptKey}" not found.`);
    return "I seem to have forgotten my purpose.";
  }

  const systemPrompt = promptKey ? prompts.get(promptKey) : "";

  const { data, error } = await tryCatch(
    googleGenAI.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", text: prompt }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens || 500,
        temperature: 1.35,
        ...(schema
          ? { responseMimeType: "application/json", responseSchema: schema }
          : {}),
      },
    })
  );

  if (error) {
    console.error("Error getting response from Gemini:", error);
    return "Something went wrong.";
  }

  if (!data.text) {
    console.error("No text found in the response.");
    return "Something went wrong.";
  }

  return data.text;
}
