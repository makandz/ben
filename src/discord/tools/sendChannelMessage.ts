import type { ChatTransport } from "../../app/ChatTransport.js";
import type { Tool } from "../../tools/Tool.js";
import { createActionableTool } from "../../tools/createActionableTool.js";
import { parseArguments, sanitizeText } from "./toolSupport.js";

const MAX_MESSAGES_PER_CALL = 10;
const MAX_MESSAGE_LENGTH = 2_000;

export type SendMessageToolDependencies = {
  transport: Pick<ChatTransport, "sendMessage">;
  getActiveChannelId(): string | undefined;
};

/**
 * Creates the action-enabled, current-channel `message` tool.
 *
 * @param dependencies - Active-channel lookup and Discord message delivery.
 * @returns A tool supporting one or more ordered text replies and a reusable next action.
 */
export function createSendMessageTool(dependencies: SendMessageToolDependencies): Tool {
  return createActionableTool({
    definition: {
      name: "message",
      description:
        "Send one or more text messages in the current channel, then take a next action.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
              {
                type: "array",
                items: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
                minItems: 1,
                maxItems: MAX_MESSAGES_PER_CALL,
              },
            ],
          },
        },
        required: ["text"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const messages = parseMessages(input.text);
      if (!messages.ok) {
        return { ok: false, result: { ok: false, error: messages.error } };
      }

      const channelId = dependencies.getActiveChannelId();
      if (channelId === undefined) {
        return { ok: false, result: { ok: false, error: "no active Discord channel" } };
      }

      let sentCount = 0;
      try {
        for (const text of messages.values) {
          await dependencies.transport.sendMessage(channelId, text);
          sentCount += 1;
        }
      } catch (error) {
        return {
          ok: false,
          result: { ok: false, error: String(error), sentCount },
        };
      }

      return { ok: true, result: { ok: true, sentCount } };
    },
  });
}

type ParsedMessages = { ok: true; values: string[] } | { ok: false; error: string };

/** Validates and normalizes one message or an ordered message batch. */
function parseMessages(value: unknown): ParsedMessages {
  const candidates: unknown[] = Array.isArray(value) ? value : [value];
  if (candidates.length === 0 || candidates.length > MAX_MESSAGES_PER_CALL) {
    return { ok: false, error: `text must contain 1-${String(MAX_MESSAGES_PER_CALL)} messages` };
  }

  const messages = candidates.map((candidate) => sanitizeText(candidate));
  if (messages.some((text) => text.length === 0 || text.length > MAX_MESSAGE_LENGTH)) {
    return {
      ok: false,
      error: `each message must be 1-${String(MAX_MESSAGE_LENGTH)} characters`,
    };
  }
  return { ok: true, values: messages };
}
