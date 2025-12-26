import { TextChannel, type Channel, type Guild } from "discord.js";

/**
 * Check if a channel is a guild text channel.
 * @param channel - The channel to check.
 * @returns True if the channel is a guild text channel, false otherwise.
 */
export const isGuildTextChannel = (
  channel: Channel | null
): channel is TextChannel => {
  return channel instanceof TextChannel;
};

/**
 * Convert Discord mention format (<@ID>) to readable username format (@username).
 * Used for incoming messages before storing in history.
 * @param content - The message content with Discord mentions.
 * @param guild - The guild to fetch members from.
 * @returns The content with mentions resolved to usernames.
 */
export const resolveMentionsToUsernames = async (
  content: string,
  guild: Guild
): Promise<string> => {
  // Some sort of deprecated method to grab <@!IDs> as well as <@IDs>
  const mentionRegex = /<@!?(\d+)>/g;
  const matches = Array.from(content.matchAll(mentionRegex));

  let result = content;

  for (const match of matches) {
    const userId = match[1];
    const fullMention = match[0];

    try {
      const member = await guild.members.fetch(userId);
      const username = member.user.username;
      result = result.replace(fullMention, `@${username}`);
    } catch (error) {
      // If we can't fetch the user, replace with @unknown
      result = result.replace(fullMention, "@unknown");
    }
  }

  return result;
};

/**
 * Convert readable username format (@username) to Discord mention format (<@ID>).
 * Used for outgoing messages before sending to Discord.
 * @param content - The message content with @username mentions.
 * @param guild - The guild to fetch members from.
 * @returns The content with usernames resolved to Discord mentions.
 */
export const resolveUsernamesToMentions = async (
  content: string,
  guild: Guild
): Promise<string> => {
  // Match @username format (word characters only, no spaces)
  const usernameRegex = /@(\w+)/g;
  const matches = Array.from(content.matchAll(usernameRegex));

  let result = content;

  for (const match of matches) {
    const username = match[1];
    const fullMention = match[0];

    try {
      // First try to find in cache
      let member = guild.members.cache.find(
        (m) => m.user.username === username
      );

      // If not in cache, query the API
      if (!member) {
        const members = await guild.members.fetch({
          query: username,
          limit: 1,
        });
        member = members.find((m) => m.user.username === username);
      }

      if (member) {
        result = result.replace(fullMention, `<@${member.id}>`);
      }
      // If we can't find the user, leave the @username as-is (don't ping unknown users)
    } catch (error) {
      // If fetch fails, leave the @username as-is
      console.error(`Failed to resolve username ${username}:`, error);
    }
  }

  return result;
};
