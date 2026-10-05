import type {
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordUser,
  DiscordChannel,
} from "../../src/discord/DiscordGateway.js";

export type InputMessage = {
  user?: string | undefined;
  channel?: string | undefined;
  content: string;
  ping?: boolean | undefined;
};
export type Directory = { users?: string[] | undefined; channels?: string[] | undefined };

/**
 * Builds an entirely local Discord boundary with synthetic users and channels.
 * @param record - Ordered output event sink.
 * @param directory - Synthetic usernames and channel names.
 * @returns Gateway and input controls that never construct a Discord client.
 */
export function createGateway(
  record: (event: Record<string, unknown>) => void,
  directory: Directory = {},
) {
  const bot: DiscordUser = { id: "9000", username: "Ben", bot: true };
  const users = (directory.users ?? ["makan", "alex"]).map((username, index) => ({
    id: String(1000 + index),
    username,
    bot: false,
  }));
  const channels: DiscordChannel[] = (directory.channels ?? ["general", "games", "ben-log"]).map(
    (name, index) => ({ id: String(2000 + index), name, guildId: "3000", sendable: true }),
  );
  let handlers: DiscordGatewayHandlers | undefined;
  let counter = 0;
  const messages: Record<string, unknown>[] = [];
  const user = (name = users[0]?.username ?? "makan") => {
    const found = users.find((item) => item.username === name || item.id === name);
    if (!found) throw new Error(`Unknown user: ${name}`);
    return found;
  };
  const channel = (name = channels[0]?.name ?? "general") => {
    const found = channels.find((item) => item.name === name || item.id === name);
    if (!found) throw new Error(`Unknown channel: ${name}`);
    return found;
  };
  const delivery = (operation: string, data: Record<string, unknown>) => {
    record({ type: `discord_${operation}`, ...data });
  };
  const gateway: DiscordGateway = {
    setHandlers(value) {
      handlers = value;
    },
    async login() {
      handlers?.ready(bot);
    },
    async destroy() {
      record({ type: "discord_destroy" });
    },
    getBotUser: () => bot,
    async fetchChannel(id) {
      return channels.find((item) => item.id === id);
    },
    async searchGuildMembers(_guild, query) {
      return [...users, bot]
        .filter((item) => item.username.toLowerCase().includes(query.toLowerCase()))
        .map((item) => ({ ...item, displayName: item.username }));
    },
    async fetchGuildChannels() {
      return channels;
    },
    async sendMessage(channelId, content, options) {
      const result = { id: String(++counter + 10000), createdAt: Date.now() };
      delivery("send", { channelId, content, options, ...result });
      messages.push({ channelId, content, options, ...result, userId: bot.id });
      return result;
    },
    async addReaction(channelId, messageId, emoji) {
      delivery("reaction", { channelId, messageId, emoji });
    },
    async sendTyping(channelId) {
      delivery("typing", { channelId });
    },
    setPresence(status) {
      delivery("presence", { status });
    },
    setCustomStatus(content) {
      delivery("status", { content });
    },
    async registerCommand(command) {
      record({ type: "discord_command_registered", command });
      return "registered";
    },
  };
  return {
    gateway,
    users,
    channels,
    messages,
    validate(input: InputMessage) {
      user(input.user);
      channel(input.channel);
    },
    message(input: InputMessage) {
      const author = user(input.user);
      const destination = channel(input.channel);
      let content = input.content.replace(/@Ben\b/g, `<@${bot.id}>`);
      for (const person of users)
        content = content.replaceAll(`@${person.username}`, `<@${person.id}>`);
      for (const item of channels)
        content = content.replaceAll(`#${item.name ?? ""}`, `<#${item.id}>`);
      if (input.ping === true && !content.includes(`<@${bot.id}>`))
        content = `<@${bot.id}> ${content}`;
      const event = {
        id: String(++counter + 10000),
        channel: destination,
        author,
        content,
        createdAt: Date.now(),
        mentionedUsers: [...users, bot].filter((item) => content.includes(`<@${item.id}>`)),
        mentionedChannels: channels.filter((item) => content.includes(`<#${item.id}>`)),
      };
      messages.push(event);
      record({ type: "discord_input", message: event });
      handlers?.message(event);
      return event;
    },
  };
}
