import {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import dedent from "dedent";
import { config } from "../config.js";
import { getHistory, type HistoryMessage } from "../messageHistory.js";
import { getPrompt } from "../prompts.js";
import { trackTokenUsage, type TokenTrackingResult } from "./tokens.js";

const GEMINI_MODELS = ["gemini-2.5-flash"] as const;
export type GeminiModel = (typeof GEMINI_MODELS)[number];

const ai = new GoogleGenAI({ apiKey: config.googleApiKey });

type GenerateContentResult = {
  response: GenerateContentResponse;
  tokenUsage: TokenTrackingResult;
};

export type GenerateReplyResult = {
  messages: string[];
  tokenUsage: TokenTrackingResult;
  model: GeminiModel;
};

/**
 * Wrapper for generateContent that tracks token usage
 * @param params - The parameters for the generateContent call (with model constrained to GeminiModel).
 * @returns The response and token usage from the generateContent call.
 */
const generateContentWithTracking = async (
  params: Omit<GenerateContentParameters, "model"> & { model: GeminiModel }
): Promise<GenerateContentResult> => {
  const response = await ai.models.generateContent(params);

  // We can only process input if it's a string
  if (typeof params.contents !== "string") {
    throw new Error("Contents must be a string, got " + typeof params.contents);
  }

  const tokenUsage = trackTokenUsage(
    params.model,
    params.contents + (params.config?.systemInstruction ?? ""),
    response.text ?? ""
  );

  return { response, tokenUsage };
};

/**
 * Build a conversation prompt for the given channel and history.
 * @param channel - The channel to build a prompt for.
 * @param history - The history of the conversation.
 * @returns The built prompt.
 */
const buildConversationPrompt = (
  channel: string,
  history: HistoryMessage[]
): string => {
  const historyText = history
    .map((m) => `${m.username}: ${m.content}`)
    .join("\n");

  return dedent`
    Context:
    - Platform: Discord
    - Channel: #${channel}
    - Tone: casual, joking, conversational

    Recent conversation:
    ${historyText}

    Instruction:
    Ben is about to speak next.
    Write Ben's next message.
  `;
};

/**
 * Generate a reply for the given channel.
 * @param channel - The channel to generate a reply for.
 * @returns An object containing the messages and token usage.
 */
export const generateReply = async (
  channel: string
): Promise<GenerateReplyResult> => {
  const model = "gemini-2.5-flash";

  const systemPrompt = await getPrompt("conversation");
  const history = getHistory();
  const userPrompt = buildConversationPrompt(channel, history);

  const { response, tokenUsage } = await generateContentWithTracking({
    model,
    contents: userPrompt,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 100,
      thinkingConfig: {
        // thinkingLevel: ThinkingLevel.MINIMAL, // Gemini 3 only
        thinkingBudget: 0, // Gemini 2 only
      },
    },
  });

  let messages: string[];

  if (!response.text) {
    console.error("[ERROR] No response from Gemini");
    messages = ["sorry, I'm having trouble thinking of a reply"];
  } else {
    messages = response.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (messages.length === 0) {
      messages = ["sorry, I'm having trouble thinking of a reply"];
    }
  }

  return {
    messages,
    tokenUsage,
    model,
  };
};
