import type { ChatTransport } from "../../app/ChatTransport.js";
import type { Tool } from "../../tools/Tool.js";
import { createActionableTool } from "../../tools/createActionableTool.js";
import { parseArguments, sanitizeText } from "./toolSupport.js";

const MAX_MESSAGES_PER_CALL = 10;
const MAX_MESSAGE_LENGTH = 2_000;

export type SendMessageToolDependencies = {
  transport: Pick<ChatTransport, "sendMessage">;
  getActiveChannelId(): string | undefined;
  isMessageInActiveConversation(messageId: string): boolean;
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
        "Use whenever you want to say something user-visible in the current Discord channel. This is the only way to communicate text to people in Discord.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            description:
              "The message text to send. Use a string for one brief message. Use an ordered array for a response longer than a couple of sentences or containing multiple distinct thoughts. Each item should be a complete, natural message. Keep closely related sentences together and do not split individual sentences across messages.",
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
          reply_to: {
            type: ["string", "null"],
            description:
              "The exact internal message_id to visibly reply to. Use this only when a visible reply is needed to distinguish which message or person is being answered, such as responding individually to multiple messages or people, or when someone explicitly asks you to respond to or point back to an earlier message. Otherwise use null, including for a normal response to a single recent message. With multiple texts, only the first is attached as a reply; use separate calls when different responses need different reply targets.",
          },
        },
        required: ["text", "reply_to"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const messages = parseMessages(input.text);
      if (!messages.ok) {
        return { ok: false, result: { ok: false, error: messages.error } };
      }
      const replyTo = parseReplyTo(input.reply_to);
      if (!replyTo.ok) {
        return { ok: false, result: { ok: false, error: replyTo.error } };
      }
      if (
        replyTo.messageId !== undefined &&
        !dependencies.isMessageInActiveConversation(replyTo.messageId)
      ) {
        return {
          ok: false,
          result: { ok: false, error: "reply_to is not in the active conversation" },
        };
      }

      const channelId = dependencies.getActiveChannelId();
      if (channelId === undefined) {
        return { ok: false, result: { ok: false, error: "no active Discord channel" } };
      }

      const messageIds: string[] = [];
      try {
        for (const [index, text] of messages.values.entries()) {
          const delivery = await dependencies.transport.sendMessage(
            channelId,
            text,
            index === 0 && replyTo.messageId !== undefined
              ? { replyTo: replyTo.messageId }
              : undefined,
          );
          messageIds.push(delivery.id);
        }
      } catch (error) {
        return {
          ok: false,
          result: { ok: false, error: String(error), sentCount: messageIds.length, messageIds },
        };
      }

      return { ok: true, result: { ok: true, sentCount: messageIds.length, messageIds } };
    },
  });
}

type ParsedMessages = { ok: true; values: string[] } | { ok: false; error: string };
type ParsedReplyTo = { ok: true; messageId?: string } | { ok: false; error: string };

/** Parses an optional exact message reference without accepting other value types. */
function parseReplyTo(value: unknown): ParsedReplyTo {
  if (value === null || value === undefined) return { ok: true };
  if (typeof value !== "string")
    return { ok: false, error: "reply_to must be a message_id or null" };
  const messageId = value.trim();
  return messageId.length === 0
    ? { ok: false, error: "reply_to must be a non-empty message_id or null" }
    : { ok: true, messageId };
}

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
