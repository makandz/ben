import OpenAI from "openai";

import type {
  GenerateResponseInput,
  GenerateResponseOutput,
  LanguageModelClient,
} from "../language-model-client.js";
import { loadSystemPrompt } from "../system-prompt.js";

const MAX_OUTPUT_TOKENS = 256;

export type OpenAILanguageModelClientConfig = {
  apiKey: string;
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

/**
 * Creates an OpenAI-backed language model client with its system prompt cached in memory.
 *
 * @param config - The credentials and model used for OpenAI requests.
 * @returns A provider-neutral language model client.
 */
export async function createOpenAILanguageModelClient(
  config: OpenAILanguageModelClientConfig,
): Promise<LanguageModelClient> {
  const client = new OpenAI({ apiKey: config.apiKey });
  const instructions = await loadSystemPrompt("ben");

  return {
    /**
     * Generates a response through the OpenAI Responses API.
     *
     * @param input - The provider-neutral response request.
     * @returns The generated response in the application's format.
     */
    async generateResponse(input: GenerateResponseInput): Promise<GenerateResponseOutput> {
      try {
        const response = await client.responses.create({
          model: config.model,
          instructions,
          input: input.message,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          reasoning: { effort: config.reasoningEffort },
          store: false,
        });
        const text = response.output_text.trim();

        if (!text) {
          throw new Error("OpenAI returned an empty response");
        }

        return { text };
      } catch (error: unknown) {
        throw new Error("Failed to generate a response", { cause: error });
      }
    },
  };
}
