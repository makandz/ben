import type { Logger } from "../../logger.js";
import type { Tool, ToolResult } from "../../tools/Tool.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { parseArguments, sanitizeText, sendToolStatus, toolFailure } from "./toolSupport.js";

const MAX_EMOJI_LENGTH = 32;
const MAX_STATUS_LENGTH = 128;

export type UpdateCustomStatusToolDependencies = {
  gateway: Pick<DiscordGateway, "sendMessage" | "setCustomStatus">;
  store: { set(status: string | undefined): Promise<void> };
  getActiveChannelId(): string | undefined;
  logger: Pick<Logger, "warn">;
};

/**
 * Creates the Discord-backed, non-terminal custom-status capability tool.
 *
 * @param dependencies - Presence delivery, active-session, and status-reporting capabilities.
 * @returns A tool that sets or clears Ben's custom status and reports the result in-channel.
 */
export function createUpdateCustomStatusTool(
  dependencies: UpdateCustomStatusToolDependencies,
): Tool {
  return {
    definition: {
      name: "update_status",
      description:
        "Set Ben's global Discord custom status using an optional Unicode emoji and content, or clear it when both are null.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          emoji: {
            type: ["string", "null"],
            maxLength: MAX_EMOJI_LENGTH,
            description: "Optional Unicode emoji displayed before the status content.",
          },
          content: {
            type: ["string", "null"],
            maxLength: MAX_STATUS_LENGTH,
            description: "Optional custom status text.",
          },
        },
        required: ["emoji", "content"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const emoji = sanitizeText(input.emoji, true);
      const content = sanitizeText(input.content, true);
      const display = [emoji, content].filter((part) => part.length > 0).join(" ");
      const channelId = dependencies.getActiveChannelId();
      const fail = async (error: string): Promise<ToolResult> => {
        await sendToolStatus(
          dependencies.gateway,
          dependencies.logger,
          "discord.custom_status_message_failed",
          channelId,
          `> ⚠️ Failed to update my status: ${error}`,
        );
        return toolFailure(error);
      };

      if (emoji.length > MAX_EMOJI_LENGTH) {
        return fail(`emoji must contain at most ${String(MAX_EMOJI_LENGTH)} characters`);
      }
      if (display.length > MAX_STATUS_LENGTH) {
        return fail(`combined status must contain at most ${String(MAX_STATUS_LENGTH)} characters`);
      }
      if (channelId === undefined) return fail("no active Discord channel");

      try {
        const status = display.length === 0 ? undefined : display;
        await dependencies.store.set(status);
        dependencies.gateway.setCustomStatus(status);
        await sendToolStatus(
          dependencies.gateway,
          dependencies.logger,
          "discord.custom_status_message_failed",
          channelId,
          display.length === 0 ? "> Reset my status" : `> Updated my status to "${display}"`,
        );
        return {
          type: "continue",
          result: {
            ok: true,
            emoji: emoji.length === 0 ? null : emoji,
            content: content.length === 0 ? null : content,
            reset: display.length === 0,
          },
        };
      } catch (error) {
        return fail(String(error));
      }
    },
  };
}
