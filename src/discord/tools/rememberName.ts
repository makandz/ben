import type { Logger } from "../../logger.js";
import type { KnownPeopleStore } from "../../storage/KnownPeopleStore.js";
import type { Tool, ToolResult } from "../../tools/Tool.js";
import { findMatchingMember, UserMentionDirectory } from "../DiscordDirectory.js";
import type { DiscordGateway } from "../DiscordGateway.js";
import { parseArguments, sanitizeText, sendToolStatus, toolFailure } from "./toolSupport.js";

export type RememberNameToolDependencies = {
  gateway: DiscordGateway;
  users: UserMentionDirectory;
  store: Pick<KnownPeopleStore, "remember">;
  getActiveChannelId(): string | undefined;
  logger: Pick<Logger, "warn">;
};

/**
 * Creates the Discord-backed, non-terminal `remember_name` capability tool.
 *
 * @param dependencies - Discord lookup, persistence, session, and logging capabilities.
 * @returns A capability tool that verifies and remembers one server member.
 */
export function createRememberNameTool(dependencies: RememberNameToolDependencies): Tool {
  return {
    definition: {
      name: "remember_name",
      description:
        "Use when someone clearly establishes that a Discord username belongs to a particular real or preferred name, so you can recognize and address that person naturally in future conversations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          username: {
            type: "string",
            description: "The exact Discord username whose name has been established.",
          },
          name: {
            type: "string",
            description:
              "The person's real or preferred name as established by the conversation. Do not guess or infer a name that was not clearly provided.",
          },
        },
        required: ["username", "name"],
      },
    },
    async execute(call) {
      const input = parseArguments(call.arguments);
      const username = sanitizeText(input.username, true).replace(/^@+/, "");
      const name = sanitizeText(input.name, true);
      const channelId = dependencies.getActiveChannelId();
      const fail = async (error: string): Promise<ToolResult> => {
        await sendToolStatus(
          dependencies.gateway,
          dependencies.logger,
          "discord.remember_status_failed",
          channelId,
          `> ⚠️ Failed to remember "${username}" as "${name}": ${error}`,
        );
        return toolFailure(error);
      };

      if (username.length === 0 || name.length === 0) {
        return fail("username and name must be non-empty");
      }
      if (channelId === undefined) return fail("no active Discord channel");

      try {
        const channel = await dependencies.gateway.fetchChannel(channelId);
        if (channel?.guildId === undefined) return await fail("active channel is not in a server");
        const candidates = (
          await dependencies.gateway.searchGuildMembers(channel.guildId, username)
        ).filter((member) => !member.bot);
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

        await sendToolStatus(
          dependencies.gateway,
          dependencies.logger,
          "discord.remember_status_failed",
          channelId,
          `> Remembering "${result.username}" is "${result.name}"`,
        );
        return { type: "continue", result };
      } catch (error) {
        return fail(String(error));
      }
    },
  };
}
