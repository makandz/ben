import type { Message, User } from "discord.js";

const DISCORD_USER_MENTION_PATTERN = /<@!?(\d+)>/g;
const BROADCAST_MENTION_PATTERN = /@(?=everyone\b|here\b)/gi;
const USERNAME_MENTION_PATTERN = /(^|[^\w@.])@([a-z0-9_]{2,32})(?![\w.])/gi;

export function escapeBroadcastMentions(content: string): string {
  return content.replace(BROADCAST_MENTION_PATTERN, "@\u200B");
}

export class UserMentionDirectory {
  private readonly idToUsername = new Map<string, string>();
  private readonly usernameToId = new Map<string, string>();

  rememberUser(user: User): void {
    this.idToUsername.set(user.id, user.username);
    this.usernameToId.set(normalizeUsername(user.username), user.id);
  }

  rememberUsername(username: string, userId: string): void {
    this.idToUsername.set(userId, username);
    this.usernameToId.set(normalizeUsername(username), userId);
  }

  rememberMessageUsers(message: Message): void {
    this.rememberUser(message.author);

    for (const user of message.mentions.users.values()) {
      this.rememberUser(user);
    }
  }

  convertMentionsToUsernames(content: string): string {
    return content.replace(DISCORD_USER_MENTION_PATTERN, (mention, userId: string) => {
      const username = this.idToUsername.get(userId);

      return username === undefined ? mention : `@${username}`;
    });
  }

  convertUsernamesToMentions(content: string): string {
    let converted = content;
    const usernames = [...this.usernameToId.keys()].sort((left, right) => right.length - left.length);

    for (const username of usernames) {
      const userId = this.usernameToId.get(username);

      if (userId === undefined) {
        continue;
      }

      converted = converted.replace(usernameMentionTagPattern(username), `<@${userId}>`);
      converted = converted.replace(usernameMentionPattern(username), `$1<@${userId}>`);
    }

    return converted;
  }

  findUnresolvedMentionUsernames(content: string): string[] {
    const usernames = new Set<string>();

    for (const match of content.matchAll(USERNAME_MENTION_PATTERN)) {
      const username = match[2];

      if (username === undefined) {
        continue;
      }

      const normalizedUsername = normalizeUsername(username);

      if (!this.usernameToId.has(normalizedUsername)) {
        usernames.add(normalizedUsername);
      }
    }

    return [...usernames];
  }
}

function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

function usernameMentionPattern(username: string): RegExp {
  return new RegExp(`(^|[^\\w@.<])@${escapeRegExp(username)}(?![\\w.])`, "gi");
}

function usernameMentionTagPattern(username: string): RegExp {
  return new RegExp(`<@${escapeRegExp(username)}>`, "gi");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
