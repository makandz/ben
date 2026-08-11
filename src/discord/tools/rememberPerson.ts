import type { Logger } from "../../logger.js";
import type { KnownPeopleStore } from "../../storage/KnownPeopleStore.js";
import type { Tool, ToolResult } from "../../tools/Tool.js";
import { findMatchingMember, UserMentionDirectory } from "../DiscordDirectory.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { escapeBroadcastMentions } from "../mentions.js";

export type RememberPersonToolDependencies = {
  gateway: DiscordGateway;
  users: UserMentionDirectory;
  store: Pick<KnownPeopleStore, "remember">;
  getActiveChannelId(): string | undefined;
  logger: Pick<Logger, "warn">;
};

/**
 * Creates the Discord-backed, non-terminal `remember_person` capability tool.
 *
 * @param dependencies - Discord lookup, persistence, session, and logging capabilities.
 * @returns A capability tool that verifies and remembers one server member.
 */
export function createRememberPersonTool(dependencies: RememberPersonToolDependencies): Tool {
  return {
    definition: {
      name: "remember_person",
      description:
        "Remember a verified Discord username's real or preferred name, then continue the turn.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          username: { type: "string" },
          name: { type: "string" },
        },
        required: ["username", "name"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const username = sanitizeText(input.username).replace(/^@+/, "");
      const name = sanitizeText(input.name);
      const channelId = dependencies.getActiveChannelId();
      const fail = async (error: string): Promise<ToolResult> => {
        await sendStatus(
          dependencies,
          channelId,
          `> ⚠️ Failed to remember "${username}" as "${name}": ${error}`,
        );
        return { type: "continue", result: { ok: false, error } };
      };

      if (username.length === 0 || name.length === 0) {
        return fail("username and name must be non-empty");
      }
      if (channelId === undefined) return fail("no active Discord channel");

      try {
        const channel = await dependencies.gateway.fetchChannel(channelId);
        if (channel?.guildId === undefined) return await fail("active channel is not in a server");
        const candidates = (await dependencies.gateway.searchGuildMembers(channel.guildId, username))
          .filter((member) => !member.bot);
        const member = findMatchingMember(username, candidates);
        if (member === undefined) return await fail("no matching server member found");

        dependencies.users.rememberUser(member);
        dependencies.users.rememberUsername(username, member.id);
        const result = await dependencies.store.remember({
          userId: member.id,
          username: member.username,
          name,
        });
        if (!result.ok) return await fail(result.error);

        await sendStatus(
          dependencies,
          channelId,
          `> 🧠 Remembering that "${result.username}" is "${result.name}"`,
        );
        return { type: "continue", result };
      } catch (error) {
        return fail(String(error));
      }
    },
  };
}

/** Sends a user-visible capability status while containing status failures. */
async function sendStatus(
  dependencies: Pick<RememberPersonToolDependencies, "gateway" | "logger">,
  channelId: string | undefined,
  text: string,
): Promise<void> {
  if (channelId === undefined) {
    dependencies.logger.warn("discord.remember_status_failed", { error: "Missing channel ID" });
    return;
  }
  await dependencies.gateway.sendMessage(channelId, escapeBroadcastMentions(text), {
    allowUserMentions: false,
  }).catch((error: unknown) => {
    dependencies.logger.warn("discord.remember_status_failed", { error: String(error) });
  });
}

/** Narrows unknown model arguments to a record. */
function parseArguments(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Trims and collapses whitespace in a model string argument. */
function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}
