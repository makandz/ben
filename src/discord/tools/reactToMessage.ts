import type { Tool } from "../../tools/Tool.js";
import { createActionableTool } from "../../tools/createActionableTool.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { parseArguments, sanitizeText } from "./toolSupport.js";

const MAX_EMOJI_LENGTH = 100;

export type ReactToMessageToolDependencies = {
  gateway: Pick<DiscordGateway, "addReaction">;
  getActiveChannelId(): string | undefined;
  isMessageInActiveConversation(messageId: string): boolean;
};

/**
 * Creates the current-conversation Discord reaction tool.
 *
 * @param dependencies - Reaction delivery and active-transcript validation capabilities.
 * @returns An actionable tool that reacts only to messages exposed in the active transcript.
 */
export function createReactToMessageTool(dependencies: ReactToMessageToolDependencies): Tool {
  return createActionableTool({
    definition: {
      name: "react",
      description:
        "Add one emoji reaction to a message from the active conversation using its exact message_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: {
            type: "string",
            minLength: 1,
            description: "Exact message_id shown in the transcript or returned after sending.",
          },
          emoji: {
            type: "string",
            minLength: 1,
            maxLength: MAX_EMOJI_LENGTH,
            description: "One Unicode emoji or Discord custom emoji identifier.",
          },
        },
        required: ["message_id", "emoji"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const messageId = sanitizeText(input.message_id);
      const emoji = sanitizeText(input.emoji);

      if (messageId.length === 0) {
        return { ok: false, result: { ok: false, error: "message_id must be non-empty" } };
      }
      if (emoji.length === 0 || emoji.length > MAX_EMOJI_LENGTH) {
        return {
          ok: false,
          result: {
            ok: false,
            error: `emoji must contain 1-${String(MAX_EMOJI_LENGTH)} characters`,
          },
        };
      }
      if (!dependencies.isMessageInActiveConversation(messageId)) {
        return {
          ok: false,
          result: { ok: false, error: "message_id is not in the active conversation" },
        };
      }

      const channelId = dependencies.getActiveChannelId();
      if (channelId === undefined) {
        return { ok: false, result: { ok: false, error: "no active Discord channel" } };
      }

      try {
        await dependencies.gateway.addReaction(channelId, messageId, emoji);
        return { ok: true, result: { ok: true, messageId, emoji } };
      } catch (error) {
        return { ok: false, result: { ok: false, error: String(error) } };
      }
    },
  });
}
