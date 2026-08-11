import assert from "node:assert/strict";
import test from "node:test";

import type { ChatTransport } from "../../app/ChatTransport.js";
import type {
  CreateScheduledMessageInput,
  ScheduledMessage,
} from "../../storage/ScheduledMessageStore.js";
import type { Tool } from "../../tools/Tool.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { sleepTool, waitTool } from "../../tools/conversationControls.js";
import { ChannelMentionDirectory, UserMentionDirectory } from "../DiscordDirectory.js";
import type {
  DiscordChannel,
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordMember,
  DiscordSendOptions,
  DiscordUser,
} from "../DiscordGateway.js";
import { createScheduledMessageDelivery } from "../ScheduledMessageDelivery.js";
import { createScheduledMessageTool } from "../tools/createScheduledMessage.js";
import { createRememberPersonTool } from "../tools/rememberPerson.js";
import { createSendMessageTool } from "../tools/sendChannelMessage.js";

const general: DiscordChannel = { id: "general", name: "general", guildId: "guild" };
const plans: DiscordChannel = { id: "plans", name: "plans", guildId: "guild" };
const logger = { warn() {} };

test("remember-person verifies the member, stores them, and reports success", async () => {
  const gateway = new FakeGateway();
  gateway.members = [{ id: "one", username: "makan", displayName: "Makan", bot: false }];
  const remembered: unknown[] = [];
  const tool = createRememberPersonTool({
    gateway,
    users: new UserMentionDirectory(),
    store: {
      async remember(input) {
        remembered.push(input);
        return { ok: true, username: input.username, name: input.name };
      },
    },
    getActiveChannelId: () => "general",
    logger,
  });

  const result = await execute(tool, { username: " @makan ", name: " Makan A. " });
  assert.deepEqual(result, {
    type: "continue",
    result: { ok: true, username: "makan", name: "Makan A." },
  });
  assert.deepEqual(remembered, [{ userId: "one", username: "makan", name: "Makan A." }]);
  assert.match(gateway.sent[0]?.content ?? "", /Remembering/);
  assert.deepEqual(gateway.sent[0]?.options, { allowUserMentions: false });
});

test("remember-person controls empty, ambiguous, duplicate, and lookup failures", async () => {
  const gateway = new FakeGateway();
  const create = (storeResult = { ok: false as const, error: "already known" }) =>
    createRememberPersonTool({
      gateway,
      users: new UserMentionDirectory(),
      store: { async remember() { return storeResult; } },
      getActiveChannelId: () => "general",
      logger,
    });

  assert.match(JSON.stringify(await execute(create(), { username: "", name: "Name" })), /non-empty/);
  gateway.members = [
    { id: "one", username: "sam_one", displayName: "Sam", bot: false },
    { id: "two", username: "sam_two", displayName: "Sam", bot: false },
  ];
  assert.match(JSON.stringify(await execute(create(), { username: "sam", name: "Sam" })), /no matching/);
  gateway.members = [{ id: "one", username: "sam", displayName: "Sam", bot: false }];
  assert.match(JSON.stringify(await execute(create(), { username: "sam", name: "Sam" })), /already known/);
  gateway.memberError = new Error("Discord unavailable");
  assert.match(JSON.stringify(await execute(create(), { username: "sam", name: "Sam" })), /Discord unavailable/);
});

test("send-message preserves terminal current-channel behavior", async () => {
  const tool = createSendTool(new FakeGateway(), new FakeTransport(), () => undefined);
  assert.deepEqual(await execute(tool, { text: " hello ", reaction: "👍", channel: null }), {
    type: "finish",
    result: { ok: true, pausedUntil: "new_human_message" },
    outcome: { type: "reply", text: "hello", reaction: "👍" },
  });
  assert.match(JSON.stringify(await execute(tool, { text: null, reaction: "no", channel: null })), /exactly one/);
});

test("cross-channel send resolves uniquely and records successful bot context", async () => {
  const gateway = new FakeGateway();
  gateway.channels = [general, plans];
  const transport = new FakeTransport();
  const recorded: unknown[] = [];
  const tool = createSendTool(gateway, transport, (...values) => recorded.push(values));

  assert.deepEqual(await execute(tool, { text: "see you there", reaction: null, channel: "#plans" }), {
    type: "continue",
    result: { ok: true, channel: "plans", channelId: "plans" },
  });
  assert.deepEqual(transport.messages, [{ channelId: "plans", text: "see you there" }]);
  assert.deepEqual(recorded, [["plans", "see you there"]]);
});

test("cross-channel send reports missing, ambiguous, and transport failures without context updates", async () => {
  const gateway = new FakeGateway();
  const transport = new FakeTransport();
  const recorded: unknown[] = [];
  const tool = createSendTool(gateway, transport, (...values) => recorded.push(values));
  assert.match(JSON.stringify(await execute(tool, { text: "hi", channel: "missing", reaction: null })), /no matching/);
  gateway.channels = [general, plans, { ...plans, id: "plans-two" }];
  assert.match(JSON.stringify(await execute(tool, { text: "hi", channel: "plans", reaction: null })), /no matching/);
  gateway.channels = [general, plans];
  transport.failChannelId = "plans";
  assert.match(JSON.stringify(await execute(tool, { text: "hi", channel: "plans", reaction: null })), /send failed/);
  assert.deepEqual(recorded, []);
});

test("scheduled-message tool verifies targets and stores a future local schedule", async () => {
  const gateway = new FakeGateway();
  gateway.channels = [general, { ...plans, sendable: true }];
  gateway.members = [
    { id: "one", username: "makan", displayName: "Makan", bot: false },
    { id: "two", username: "friend", displayName: "Friend", bot: false },
  ];
  const added: CreateScheduledMessageInput[] = [];
  const statuses: string[] = [];
  const tool = createScheduleTool(gateway, {
    async add(input) {
      added.push(input);
      return storedSchedule(input);
    },
  }, statuses);

  const result = await execute(tool, {
    message: "  remember   the thing  ",
    target_usernames: ["@makan", "friend"],
    channel: "#plans",
    run_date: "2026-01-02",
    run_time: "09:30",
    repeat: "weekly",
  });

  assert.deepEqual(result, {
    type: "continue",
    result: {
      ok: true,
      id: "sm_created",
      nextRunAt: "2026-01-02T14:30:00.000Z",
      repeat: "weekly",
      channel: "plans",
      targetUsernames: ["makan", "friend"],
    },
  });
  assert.equal(added[0]?.message, "remember the thing");
  assert.deepEqual(added[0]?.targetUsers, [
    { userId: "one", username: "makan" },
    { userId: "two", username: "friend" },
  ]);
  assert.deepEqual(added[0]?.nextRunAt, new Date("2026-01-02T14:30:00.000Z"));
  assert.deepEqual(
    { userId: added[0]?.createdByUserId, username: added[0]?.createdByUsername },
    { userId: "creator", username: "Creator" },
  );
  assert.match(gateway.sent[0]?.content ?? "", /Scheduled every week/);
  assert.equal(statuses.length, 1);
});

test("scheduled-message tool controls content, creator, destination, target, time, and recurrence", async () => {
  const gateway = new FakeGateway();
  const store = { async add(input: CreateScheduledMessageInput) { return storedSchedule(input); } };
  const create = (creator: { userId: string; username: string } | null = {
    userId: "creator",
    username: "Creator",
  }) =>
    createScheduleTool(gateway, store, [], creator);
  const valid = {
    message: "hello",
    target_usernames: ["makan"],
    channel: null,
    run_date: "2026-01-02",
    run_time: "09:30",
    repeat: "none",
  };

  assert.match(JSON.stringify(await execute(create(), { ...valid, message: " " })), /1-1000/);
  assert.match(JSON.stringify(await execute(create(null), valid)), /missing creator/);
  assert.match(JSON.stringify(await execute(create(), { ...valid, run_date: "2025-12-31" })), /future/);
  assert.match(JSON.stringify(await execute(create(), { ...valid, repeat: "monthly" })), /repeat must/);
  assert.match(JSON.stringify(await execute(create(), { ...valid, target_usernames: ["@everyone"] })), /real Discord users/);

  gateway.members = [
    { id: "one", username: "sam_one", displayName: "Sam", bot: false },
    { id: "two", username: "sam_two", displayName: "Sam", bot: false },
  ];
  assert.match(JSON.stringify(await execute(create(), { ...valid, target_usernames: ["sam"] })), /no matching/);
  gateway.channels = [general, { ...plans, sendable: false }];
  assert.match(JSON.stringify(await execute(create(), { ...valid, channel: "plans" })), /not sendable/);
});

test("scheduled delivery pings only stored target IDs with an explicit mention policy", async () => {
  const gateway = new FakeGateway();
  const deliver = createScheduledMessageDelivery(gateway);
  await deliver(storedSchedule({
    channelId: "plans",
    channelName: "plans",
    message: "hello @everyone <@999>",
    targetUsers: [
      { userId: "one", username: "makan" },
      { userId: "two", username: "friend" },
    ],
    runDate: "2026-01-02",
    runTime: "09:30",
    repeat: "none",
    nextRunAt: new Date("2026-01-02T14:30:00.000Z"),
    createdByUserId: "creator",
    createdByUsername: "Creator",
  }));

  assert.deepEqual(gateway.sent, [{
    channelId: "plans",
    content: "<@one> <@two> hello @\u200beveryone <@\u200b999>",
    options: { allowUserMentions: true },
  }]);
});

test("Discord capability tools register through the generic tool registry", () => {
  const gateway = new FakeGateway();
  const transport = new FakeTransport();
  const sendMessage = createSendTool(gateway, transport, () => undefined);
  const rememberPerson = createRememberPersonTool({
    gateway,
    users: new UserMentionDirectory(),
    store: { async remember() { return { ok: false, error: "unused" }; } },
    getActiveChannelId: () => "general",
    logger,
  });
  const scheduledMessage = createScheduleTool(gateway, {
    async add(input) { return storedSchedule(input); },
  }, []);
  const registry = new ToolRegistry([
    sendMessage,
    rememberPerson,
    scheduledMessage,
    waitTool,
    sleepTool,
  ]);

  assert.deepEqual(registry.definitions().map(({ name }) => name), [
    "send_message",
    "remember_person",
    "create_scheduled_message",
    "wait_for_more_messages",
    "sleep_conversation",
  ]);
});

function createSendTool(
  gateway: FakeGateway,
  transport: FakeTransport,
  recordBotMessage: (channelId: string, text: string) => void,
): Tool {
  return createSendMessageTool({
    gateway,
    transport,
    channels: new ChannelMentionDirectory(),
    getActiveChannelId: () => "general",
    recordBotMessage,
    logger,
  });
}

function createScheduleTool(
  gateway: FakeGateway,
  store: { add(input: CreateScheduledMessageInput): Promise<ScheduledMessage> },
  statuses: string[],
  creator: { userId: string; username: string } | null = {
    userId: "creator",
    username: "Creator",
  },
): Tool {
  return createScheduledMessageTool({
    gateway,
    users: new UserMentionDirectory(),
    channels: new ChannelMentionDirectory(),
    store,
    status: { async logStatus(text) { statuses.push(text); } },
    getActiveChannelId: () => "general",
    getCreator: () => creator ?? undefined,
    logger,
    timeZone: "America/Toronto",
    now: () => new Date("2026-01-01T12:00:00.000Z"),
  });
}

function storedSchedule(input: CreateScheduledMessageInput): ScheduledMessage {
  return {
    id: "sm_created",
    channelId: input.channelId,
    channelName: input.channelName,
    message: input.message,
    targetUsers: input.targetUsers,
    runDate: input.runDate,
    runTime: input.runTime,
    repeat: input.repeat,
    nextRunAt: input.nextRunAt.toISOString(),
    enabled: true,
    createdByUserId: input.createdByUserId,
    createdByUsername: input.createdByUsername,
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
  };
}

async function execute(tool: Tool, argumentsValue: unknown) {
  return tool.execute({ type: "tool_call", callId: "call", name: tool.definition.name, arguments: argumentsValue });
}

class FakeTransport implements ChatTransport {
  messages: Array<{ channelId: string; text: string }> = [];
  failChannelId: string | undefined;
  async sendMessage(channelId: string, text: string): Promise<void> {
    if (channelId === this.failChannelId) throw new Error("send failed");
    this.messages.push({ channelId, text });
  }
  async addReaction(): Promise<void> {}
  async sendTyping(): Promise<void> {}
  async logStatus(): Promise<void> {}
}

class FakeGateway implements DiscordGateway {
  channels: DiscordChannel[] = [general];
  members: DiscordMember[] = [];
  memberError: unknown;
  sent: Array<{ channelId: string; content: string; options: DiscordSendOptions }> = [];
  setHandlers(_handlers: DiscordGatewayHandlers): void {}
  async login(_token: string): Promise<void> {}
  async destroy(): Promise<void> {}
  getBotUser(): DiscordUser | undefined { return undefined; }
  async fetchChannel(channelId: string): Promise<DiscordChannel | undefined> {
    return this.channels.find((channel) => channel.id === channelId);
  }
  async searchGuildMembers(): Promise<readonly DiscordMember[]> {
    if (this.memberError !== undefined) throw this.memberError;
    return this.members;
  }
  async fetchGuildChannels(): Promise<readonly DiscordChannel[]> { return this.channels; }
  async sendMessage(channelId: string, content: string, options: DiscordSendOptions): Promise<void> {
    this.sent.push({ channelId, content, options });
  }
  async sendTyping(_channelId: string): Promise<void> {}
  async addReaction(_channelId: string, _messageId: string, _emoji: string): Promise<void> {}
  setPresence(_status: "idle" | "online", _activity?: string): void {}
  async registerCommand(): Promise<"registered"> { return "registered"; }
}
