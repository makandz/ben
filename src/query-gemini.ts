import { GoogleGenerativeAI } from "@google/generative-ai";
import { GOOGLE_API_KEY } from "./config.js";
import { promptLoader } from "./prompt-loader.js";
import { tryCatch } from "./utils/trycatch.js";

type SupportedPromptKeys = "conversation" | "think-should-respond";

const prompts = await promptLoader();

const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const embeddingModel = genAI.getGenerativeModel({
  model: "gemini-embedding-exp-03-07",
});

/**
 * Get embeddings for a text using Gemini's embedding model
 * @param text The text to get embeddings for
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const { data: result, error } = await tryCatch(
    embeddingModel.embedContent(text)
  );

  if (error) {
    console.error("Error getting embedding from Gemini:", error);
    throw error;
  }

  return result.embedding.values;
}

/**
 * Requests a response from the Gemini model using the provided prompt.
 * @param prompt The prompt to send to the model.
 * @param promptKey Optional key to fetch a predefined prompt from the system prompts map.
 */
export async function queryGemini(
  prompt: string,
  promptKey?: SupportedPromptKeys
): Promise<string> {
  if (promptKey && !prompts.has(promptKey)) {
    console.error(`Prompt key "${promptKey}" not found.`);
    return "I seem to have forgotten my purpose.";
  }

  const systemPrompt = promptKey ? prompts.get(promptKey) : "";

  const chat = geminiModel.startChat({
    history: [{ role: "user", parts: [{ text: "System: " + systemPrompt }] }],
  });

  const { data, error } = await tryCatch(chat.sendMessage(prompt));

  if (error) {
    console.error("Error getting response from Gemini:", error);
    return "Something went wrong.";
  }

  return data.response.text();
}
