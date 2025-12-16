import { Guild } from "discord.js";

/**
 * Converts any @username mentions in a message to proper Discord mentions.
 * Uses Discord.js's built-in cache for guild members.
 */
export const convertUsernamesToMentions = async (
  guild: Guild,
  content: string
): Promise<string> => {
  const mentionRegex = /@(\w+)/g;
  const matches = content.match(mentionRegex);
  if (!matches) return content;

  let result = content;
  for (const match of matches) {
    const username = match.substring(1); // Remove @ symbol

    // Look up the member from the built-in cache first
    let member = guild.members.cache.find(
      (m) => m.user.username.toLowerCase() === username.toLowerCase()
    );

    // Fall back to API fetch if not found in the cache
    if (!member) {
      const fetchedMembers = await guild.members.fetch({
        query: username,
        limit: 1,
      });
      member = fetchedMembers.first();
    }

    if (member) {
      result = result.replace(
        new RegExp(`@${username}\\b`, "g"),
        `<@${member.id}>`
      );
    }
  }

  return result;
};

/**
 * Converts Discord mention format (<@userId>) to @username format
 */
export const convertMentionsToUsernames = (content: string, message: any) => {
  return content.replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = message.mentions.users.get(userId);
    return user ? `@${user.username}` : match;
  });
};
