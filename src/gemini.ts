import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dedent from "dedent";
import { config } from "./config.js";
import { getHistory, type HistoryMessage } from "./messageHistory.js";
import { getPrompt } from "./prompts.js";

const ai = new GoogleGenAI({ apiKey: config.googleApiKey });

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
 * @returns An array of messages (split by newlines from the response).
 */
export const generateReply = async (channel: string): Promise<string[]> => {
  const systemPrompt = await getPrompt("conversation");
  const history = getHistory();
  const userPrompt = buildConversationPrompt(channel, history);

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: userPrompt,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 100,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
      },
    },
  });

  if (!response.text) {
    console.error("[ERROR] No response from Gemini");
    return ["sorry, I'm having trouble thinking of a reply"];
  }

  const messages = response.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return messages.length > 0
    ? messages
    : ["sorry, I'm having trouble thinking of a reply"];
};
