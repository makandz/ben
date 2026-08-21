import type { ChatTransport } from "../../app/ChatTransport.js";
import type { Tool } from "../../tools/Tool.js";
import { parseArguments, sanitizeText } from "./toolSupport.js";

const THOUGHT_PREFIX = "> 💭 ";
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_THOUGHT_LENGTH = MAX_MESSAGE_LENGTH - THOUGHT_PREFIX.length;

export type ThinkToolDependencies = {
  transport: Pick<ChatTransport, "sendMessage">;
  getActiveChannelId(): string | undefined;
};

/**
 * Creates Ben's non-terminal inner-thought tool.
 *
 * @param dependencies - Active-channel lookup and thought delivery.
 * @returns A tool that expresses one thought and always continues the conversation.
 */
export function createThinkTool(dependencies: ThinkToolDependencies): Tool {
  return {
    definition: {
      name: "think",
      description:
        "Express a brief thought in your inner voice. Use it when you want to pause, wonder, reconsider, notice something, or react to yourself before continuing. Keep it natural and concise.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_THOUGHT_LENGTH,
            description: "The thought to express in your inner voice.",
          },
        },
        required: ["text"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const thought = sanitizeText(input.text, true);
      if (thought.length === 0 || thought.length > MAX_THOUGHT_LENGTH) {
        return {
          type: "continue",
          result: {
            ok: false,
            error: `text must contain 1-${String(MAX_THOUGHT_LENGTH)} characters`,
          },
        };
      }

      const channelId = dependencies.getActiveChannelId();
      if (channelId === undefined) {
        return {
          type: "continue",
          result: { ok: false, error: "no active Discord channel" },
        };
      }

      try {
        const delivery = await dependencies.transport.sendMessage(
          channelId,
          `${THOUGHT_PREFIX}${thought}`,
        );
        return { type: "continue", result: { ok: true, messageId: delivery.id } };
      } catch (error) {
        return { type: "continue", result: { ok: false, error: String(error) } };
      }
    },
  };
}
