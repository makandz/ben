import type { DiscordChannel, DiscordGateway, DiscordMember, DiscordUser } from "./DiscordGateway.js";

const discordUserMentionPattern = /<@!?(\d+)>/g;
const discordChannelMentionPattern = /<#(\d+)>/g;
const usernameMentionPattern = /(^|[^\w@.])@([a-z0-9_]{2,32})(?![\w.])/gi;
const channelNamePattern = /(^|[^\w#<])#([a-z0-9_-]{1,100})(?![\w-])/gi;

/** Stores verified Discord user names used when normalizing and rendering mentions. */
export class UserMentionDirectory {
  private readonly idToUsername = new Map<string, string>();
  private readonly usernameToId = new Map<string, string>();

  /**
   * Remembers a Discord user from a trusted gateway result.
   *
   * @param user - Verified user identifier and username.
   */
  rememberUser(user: Pick<DiscordUser, "id" | "username">): void {
    this.rememberUsername(user.username, user.id);
  }

  /**
   * Remembers a verified username-to-user mapping.
   *
   * @param username - Discord username to render in readable text.
   * @param userId - Discord user identifier used in mention tags.
   */
  rememberUsername(username: string, userId: string): void {
    this.idToUsername.set(userId, username);
    this.usernameToId.set(normalize(username), userId);
  }

  /**
   * Converts known Discord user tags to readable usernames.
   *
   * @param content - Incoming Discord message content.
   * @returns Content with known user tags rendered as usernames.
   */
  convertMentionsToUsernames(content: string): string {
    return content.replace(discordUserMentionPattern, (mention, userId: string) => {
      const username = this.idToUsername.get(userId);
      return username === undefined ? mention : `@${username}`;
    });
  }

  /**
   * Converts verified readable usernames to Discord mention tags.
   *
   * @param content - Outbound content containing readable usernames.
   * @returns Content with verified usernames converted to mention tags.
   */
  convertUsernamesToMentions(content: string): string {
    let converted = content;
    const usernames = [...this.usernameToId.keys()].sort((left, right) => right.length - left.length);
    for (const username of usernames) {
      const userId = this.usernameToId.get(username);
      if (userId !== undefined) {
        converted = converted.replace(mentionTagPattern(username), `<@${userId}>`);
        converted = converted.replace(namedMentionPattern(username), `$1<@${userId}>`);
      }
    }
    return converted;
  }

  /**
   * Returns unresolved plain-text usernames in encounter order.
   *
   * @param content - Outbound content to inspect.
   * @returns Unique unresolved usernames, excluding broadcast targets.
   */
  findUnresolvedUsernames(content: string): string[] {
    const usernames = new Set<string>();
    for (const match of content.matchAll(usernameMentionPattern)) {
      const username = match[2];
      if (username !== undefined && !this.usernameToId.has(normalize(username))) {
        const normalized = normalize(username);
        if (normalized !== "everyone" && normalized !== "here") usernames.add(normalized);
      }
    }
    return [...usernames];
  }
}

/** Stores verified Discord channel names used when normalizing and rendering mentions. */
export class ChannelMentionDirectory {
  private readonly idToName = new Map<string, string>();
  private readonly nameToId = new Map<string, string>();

  /**
   * Remembers a named Discord channel.
   *
   * @param channel - Verified channel returned by the gateway.
   */
  rememberChannel(channel: DiscordChannel): void {
    if (channel.name === undefined || channel.name.length === 0) return;
    this.idToName.set(channel.id, channel.name);
    this.nameToId.set(normalize(channel.name), channel.id);
  }

  /**
   * Converts known Discord channel tags to readable names.
   *
   * @param content - Incoming Discord message content.
   * @returns Content with known channel tags rendered as channel names.
   */
  convertMentionsToNames(content: string): string {
    return content.replace(discordChannelMentionPattern, (mention, channelId: string) => {
      const name = this.idToName.get(channelId);
      return name === undefined ? mention : `#${name}`;
    });
  }

  /**
   * Converts verified readable channel names to Discord mention tags.
   *
   * @param content - Outbound content containing readable channel names.
   * @returns Content with verified channel names converted to mention tags.
   */
  convertNamesToMentions(content: string): string {
    let converted = content;
    const names = [...this.nameToId.keys()].sort((left, right) => right.length - left.length);
    for (const name of names) {
      const channelId = this.nameToId.get(name);
      if (channelId !== undefined) {
        converted = converted.replace(namedChannelPattern(name), `$1<#${channelId}>`);
      }
    }
    return converted;
  }

  /**
   * Returns unresolved plain-text channel names in encounter order.
   *
   * @param content - Outbound content to inspect.
   * @returns Unique unresolved channel names.
   */
  findUnresolvedNames(content: string): string[] {
    const names = new Set<string>();
    for (const match of content.matchAll(channelNamePattern)) {
      const name = match[2];
      if (name !== undefined && !this.nameToId.has(normalize(name))) {
        names.add(normalize(name));
      }
    }
    return [...names];
  }
}

/**
 * Resolves a unique member, preferring exact username or display-name matches.
 *
 * @param username - Username or display name requested by the model.
 * @param members - Candidate members returned by Discord search.
 * @returns The unique matching member, or `undefined` when unresolved or ambiguous.
 */
export function findMatchingMember(
  username: string,
  members: readonly DiscordMember[],
): DiscordMember | undefined {
  const normalized = normalize(username.replace(/^@+/, ""));
  const exact = members.filter(
    (member) => normalize(member.username) === normalized || normalize(member.displayName) === normalized,
  );
  if (exact.length === 1) return exact[0];
  return exact.length === 0 && members.length === 1 ? members[0] : undefined;
}

/**
 * Resolves a unique named channel from a gateway result.
 *
 * @param name - Channel name with or without leading hash characters.
 * @param channels - Candidate channels returned by Discord.
 * @returns The unique exact channel match, or `undefined` when unresolved or ambiguous.
 */
export function findMatchingChannel(
  name: string,
  channels: readonly DiscordChannel[],
): DiscordChannel | undefined {
  const normalized = normalize(name.replace(/^#+/, "").trim());
  const matches = channels.filter((channel) => channel.name !== undefined && normalize(channel.name) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Resolves and remembers unknown user and channel names in outbound text.
 *
 * @param gateway - Discord lookup boundary.
 * @param channel - Destination channel that supplies the server context.
 * @param content - Safe outbound content to inspect for mention names.
 * @param users - Verified user mention directory to update.
 * @param channels - Verified channel mention directory to update.
 * @returns A promise that resolves after all available lookups finish.
 */
export async function resolveUnknownMentions(
  gateway: DiscordGateway,
  channel: DiscordChannel,
  content: string,
  users: UserMentionDirectory,
  channels: ChannelMentionDirectory,
): Promise<void> {
  if (channel.guildId === undefined) return;
  for (const username of users.findUnresolvedUsernames(content)) {
    const member = findMatchingMember(username, await gateway.searchGuildMembers(channel.guildId, username));
    if (member !== undefined) users.rememberUser(member);
  }
  const guildChannels = channels.findUnresolvedNames(content).length === 0
    ? []
    : await gateway.fetchGuildChannels(channel.guildId);
  for (const name of channels.findUnresolvedNames(content)) {
    const match = findMatchingChannel(name, guildChannels);
    if (match !== undefined) channels.rememberChannel(match);
  }
}

/** Normalizes Discord names for case-insensitive lookup. */
function normalize(value: string): string {
  return value.toLowerCase();
}

/** Escapes text before inserting it into a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a boundary-aware pattern for a readable user mention. */
function namedMentionPattern(name: string): RegExp {
  return new RegExp(`(^|[^\\w@.<])@${escapeRegExp(name)}(?![\\w.])`, "gi");
}

/** Builds a pattern for the model's occasional username-shaped mention tag. */
function mentionTagPattern(name: string): RegExp {
  return new RegExp(`<@${escapeRegExp(name)}>`, "gi");
}

/** Builds a boundary-aware pattern for a readable channel mention. */
function namedChannelPattern(name: string): RegExp {
  return new RegExp(`(^|[^\\w#<])#${escapeRegExp(name)}(?![\\w-])`, "gi");
}
