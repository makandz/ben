import assert from "node:assert/strict";
import test from "node:test";

import type { HumanMessage } from "../../app/types.js";
import { DiscordAdapter } from "../DiscordAdapter.js";
import {
  ChannelMentionDirectory,
  findMatchingChannel,
  findMatchingMember,
  UserMentionDirectory,
} from "../DiscordDirectory.js";
import type {
  DiscordChannel,
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordMember,
  DiscordSendOptions,
  DiscordUser,
} from "../DiscordGateway.js";
import { DiscordPresence } from "../DiscordPresence.js";
import { DiscordTransport } from "../DiscordTransport.js";

const bot: DiscordUser = { id: "999", username: "ben", bot: true };
const human: DiscordUser = { id: "user-1", username: "Makan", bot: false };
const general: DiscordChannel = { id: "channel-1", name: "general", guildId: "guild-1" };

test("adapter normalizes human messages, detects pings, and ignores bots", () => {
  const gateway = new FakeDiscordGateway();
  const messages: Array<{ message: HumanMessage; pinged: boolean }> = [];
  const typings: string[][] = [];
  const ready: string[] = [];
  const adapter = new DiscordAdapter(
    gateway,
    {
      handleMessage: (message, pinged) => messages.push({ message, pinged }),
      handleTyping: (...values) => typings.push(values),
      handleReady: (username) => ready.push(username),
    },
    new UserMentionDirectory(),
    new ChannelMentionDirectory(),
    { info() {}, error() {} },
  );

  gateway.emitReady(bot);
  gateway.emitMessage({
    id: "message-1",
    channel: general,
    author: human,
    content: "hello <@999>, see <#222>",
    createdAt: 123,
    mentionedUsers: [bot],
    mentionedChannels: [{ id: "222", name: "plans", guildId: "guild-1" }],
  });
  gateway.emitMessage({
    id: "message-2",
    channel: general,
    author: bot,
    content: "ignored",
    createdAt: 124,
    mentionedUsers: [],
    mentionedChannels: [],
  });
  gateway.emitTyping({ channel: general, user: human });
  gateway.emitTyping({ channel: general, user: bot });

  assert.deepEqual(ready, ["ben"]);
  assert.deepEqual(messages, [
    {
      message: {
        id: "message-1",
        channelId: "channel-1",
        userId: "user-1",
        username: "Makan",
        content: "hello @ben, see #plans",
        createdAt: 123,
      },
      pinged: true,
    },
  ]);
  assert.deepEqual(typings, [["channel-1", "user-1", "Makan"]]);
  void adapter;
});

test("adapter owns login, shutdown, and error forwarding", async () => {
  const gateway = new FakeDiscordGateway();
  const errors: string[] = [];
  const adapter = new DiscordAdapter(
    gateway,
    { handleMessage() {}, handleTyping() {} },
    new UserMentionDirectory(),
    new ChannelMentionDirectory(),
    { info() {}, error: (_event, data) => errors.push(String(data?.error)) },
  );

  await adapter.start("token");
  gateway.emitError(new Error("socket failed"));
  await adapter.stop();

  assert.equal(gateway.loginToken, "token");
  assert.equal(gateway.destroyed, true);
  assert.deepEqual(errors, ["Error: socket failed"]);
});

test("transport resolves unique names and sends only safe mentions", async () => {
  const gateway = new FakeDiscordGateway();
  gateway.channels = [general, { id: "channel-2", name: "plans", guildId: "guild-1" }];
  gateway.members = [{ ...human, displayName: "Makan A" }];
  const transport = new DiscordTransport(
    gateway,
    new UserMentionDirectory(),
    new ChannelMentionDirectory(),
    "log-channel",
    { debug() {} },
  );

  await transport.sendMessage("channel-1", "hey @makan in #plans, not @everyone or @here");
  await transport.logStatus("@everyone diagnostics");
  await transport.sendTyping("channel-1");

  assert.deepEqual(gateway.sent, [
    {
      channelId: "channel-1",
      content: "hey <@user-1> in <#channel-2>, not @\u200Beveryone or @\u200Bhere",
      options: { allowUserMentions: true },
    },
    {
      channelId: "log-channel",
      content: "@\u200Beveryone diagnostics",
      options: { allowUserMentions: false },
    },
  ]);
  assert.deepEqual(gateway.typing, ["channel-1"]);
  assert.deepEqual(gateway.memberSearches, [{ guildId: "guild-1", query: "makan" }]);
});

test("transport does not guess ambiguous users or channels", async () => {
  const gateway = new FakeDiscordGateway();
  gateway.channels = [
    general,
    { id: "one", name: "plans", guildId: "guild-1" },
    { id: "two", name: "plans", guildId: "guild-1" },
  ];
  gateway.members = [
    { id: "one", username: "sam_one", displayName: "Sam", bot: false },
    { id: "two", username: "sam_two", displayName: "Sam", bot: false },
  ];
  const transport = new DiscordTransport(
    gateway,
    new UserMentionDirectory(),
    new ChannelMentionDirectory(),
    undefined,
    { debug() {} },
  );

  await transport.sendMessage("channel-1", "@sam in #plans");

  assert.equal(gateway.sent[0]?.content, "@sam in #plans");
});

test("directories use exact matches and require uniqueness", () => {
  const members: DiscordMember[] = [
    { id: "1", username: "sam_one", displayName: "Sam", bot: false },
    { id: "2", username: "sam_two", displayName: "Other", bot: false },
  ];
  assert.equal(findMatchingMember("sam_one", members)?.id, "1");
  assert.equal(findMatchingMember("missing", members), undefined);
  assert.equal(findMatchingChannel("general", [general])?.id, "channel-1");
  assert.equal(
    findMatchingChannel("general", [general, { ...general, id: "duplicate" }]),
    undefined,
  );
});

test("presence is a separate application capability", () => {
  const gateway = new FakeDiscordGateway();
  const presence = new DiscordPresence(gateway);
  presence.setPresence({ status: "idle" });
  presence.setPresence({ status: "online" });
  assert.deepEqual(gateway.presences, ["idle", "online"]);
});

class FakeDiscordGateway implements DiscordGateway {
  handlers: DiscordGatewayHandlers | undefined;
  botUser: DiscordUser | undefined;
  channels: DiscordChannel[] = [general];
  members: DiscordMember[] = [];
  loginToken: string | undefined;
  destroyed = false;
  sent: Array<{ channelId: string; content: string; options: DiscordSendOptions }> = [];
  typing: string[] = [];
  presences: Array<"idle" | "online"> = [];
  memberSearches: Array<{ guildId: string; query: string }> = [];

  setHandlers(handlers: DiscordGatewayHandlers): void {
    this.handlers = handlers;
  }
  async login(token: string): Promise<void> {
    this.loginToken = token;
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
  getBotUser(): DiscordUser | undefined {
    return this.botUser;
  }
  async fetchChannel(channelId: string): Promise<DiscordChannel | undefined> {
    return this.channels.find((channel) => channel.id === channelId);
  }
  async searchGuildMembers(guildId: string, query: string): Promise<readonly DiscordMember[]> {
    this.memberSearches.push({ guildId, query });
    return this.members;
  }
  async fetchGuildChannels(): Promise<readonly DiscordChannel[]> {
    return this.channels;
  }
  async sendMessage(
    channelId: string,
    content: string,
    options: DiscordSendOptions,
  ): Promise<void> {
    this.sent.push({ channelId, content, options });
  }
  async sendTyping(channelId: string): Promise<void> {
    this.typing.push(channelId);
  }
  setPresence(status: "idle" | "online"): void {
    this.presences.push(status);
  }
  async registerCommand(): Promise<"registered"> {
    return "registered";
  }
  emitReady(user: DiscordUser): void {
    this.botUser = user;
    this.handlers?.ready(user);
  }
  emitMessage(message: Parameters<DiscordGatewayHandlers["message"]>[0]): void {
    this.handlers?.message(message);
  }
  emitTyping(event: Parameters<DiscordGatewayHandlers["typing"]>[0]): void {
    this.handlers?.typing(event);
  }
  emitError(error: unknown): void {
    this.handlers?.error(error);
  }
}
