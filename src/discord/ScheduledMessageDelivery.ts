import type { ScheduledMessage } from "../storage/ScheduledMessageStore.js";
import type { DiscordGateway } from "./DiscordGateway.js";
import { escapeBroadcastMentions } from "./mentions.js";

export type ScheduledMessageDelivery = (message: ScheduledMessage) => Promise<void>;

/**
 * Creates a Discord delivery function that pings stored target user IDs.
 * Raw user tags and broadcast mentions in the stored message text are neutralized before sending.
 *
 * @param gateway - Discord output boundary.
 * @returns A delivery function suitable for the scheduled-message scheduler.
 */
export function createScheduledMessageDelivery(
  gateway: Pick<DiscordGateway, "sendMessage">,
): ScheduledMessageDelivery {
  return async (message) => {
    const pings = message.targetUsers.map((target) => `<@${target.userId}>`).join(" ");
    const safeMessage = escapeStoredUserMentions(escapeBroadcastMentions(message.message));
    const content = `${pings} ${safeMessage}`.trim();
    await gateway.sendMessage(message.channelId, content, { allowUserMentions: true });
  };
}

/** Breaks raw Discord user tags in persisted model-authored text. */
function escapeStoredUserMentions(text: string): string {
  return text.replace(/<@!?([0-9]+)>/g, "<@\u200b$1>");
}
