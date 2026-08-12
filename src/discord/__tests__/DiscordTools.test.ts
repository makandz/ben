import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateScheduledMessageInput,
  ScheduledMessage,
} from "../../storage/ScheduledMessageStore.js";
import type { SendMessageOptions } from "../../app/ChatTransport.js";
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
import { createReactToMessageTool } from "../tools/reactToMessage.js";
import { createRememberNameTool } from "../tools/rememberName.js";
import { createSendMessageTool } from "../tools/sendChannelMessage.js";

const general: DiscordChannel = { id: "general", name: "general", guildId: "guild" };
const plans: DiscordChannel = { id: "plans", name: "plans", guildId: "guild" };
const logger = { warn() {} };

test("remember-name verifies the member, stores them, and reports success", async () => {
  const gateway = new FakeGateway();
  gateway.members = [{ id: "one", username: "makan", displayName: "Makan", bot: false }];
  const remembered: unknown[] = [];
  const tool = createRememberNameTool({
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
  assert.equal(gateway.sent[0]?.content, '> Remembering "makan" is "Makan A."');
  assert.deepEqual(gateway.sent[0]?.options, { allowUserMentions: false });
});

test("remember-name controls empty, ambiguous, duplicate, and lookup failures", async () => {
  const gateway = new FakeGateway();
  const create = (storeResult = { ok: false as const, error: "already known" }) =>
    createRememberNameTool({
      gateway,
      users: new UserMentionDirectory(),
      store: {
        async remember() {
          return storeResult;
        },
      },
      getActiveChannelId: () => "general",
      logger,
    });

  assert.match(
    JSON.stringify(await execute(create(), { username: "", name: "Name" })),
    /non-empty/,
  );
  gateway.members = [
    { id: "one", username: "sam_one", displayName: "Sam", bot: false },
    { id: "two", username: "sam_two", displayName: "Sam", bot: false },
  ];
  assert.match(
    JSON.stringify(await execute(create(), { username: "sam", name: "Sam" })),
    /no matching/,
  );
  gateway.members = [{ id: "one", username: "sam", displayName: "Sam", bot: false }];
  assert.match(
    JSON.stringify(await execute(create(), { username: "sam", name: "Sam" })),
    /already known/,
  );
  assert.match(gateway.sent.at(-1)?.content ?? "", /^> ⚠️ Failed to remember/);
  gateway.memberError = new Error("Discord unavailable");
  assert.match(
    JSON.stringify(await execute(create(), { username: "sam", name: "Sam" })),
    /Discord unavailable/,
  );
});

test("message sends one or more messages and defaults to continuing", async () => {
  const transport = new FakeMessageTransport();
  const tool = createSendTool(transport);
  assert.deepEqual(await execute(tool, { text: " hello " }), {
    type: "continue",
    result: { ok: true, sentCount: 1, messageIds: ["sent-1"] },
  });
  assert.deepEqual(
    await execute(tool, {
      text: [" first ", "second"],
      next_action: "wait",
      sleep_summary: null,
    }),
    {
      type: "finish",
      result: { ok: true, sentCount: 2, messageIds: ["sent-2", "sent-3"] },
      outcome: { type: "wait" },
    },
  );
  assert.deepEqual(transport.messages, ["hello", "first", "second"]);
  assert.match(JSON.stringify(await execute(tool, { text: " " })), /each message must be/);
});

test("message sleeps with a summary only after complete delivery", async () => {
  const transport = new FakeMessageTransport();
  const tool = createSendTool(transport);
  assert.deepEqual(
    await execute(tool, {
      text: ["one", "two"],
      next_action: "sleep",
      sleep_summary: " Finished the work. ",
    }),
    {
      type: "finish",
      result: { ok: true, sentCount: 2, messageIds: ["sent-1", "sent-2"] },
      outcome: { type: "sleep", summary: "Finished the work." },
    },
  );

  const invalid = await execute(tool, {
    text: "not sent",
    next_action: "sleep",
    sleep_summary: null,
  });
  assert.match(JSON.stringify(invalid), /sleep_summary is required/);
  assert.deepEqual(transport.messages, ["one", "two"]);
});

test("message reports partial delivery and does not apply its next action", async () => {
  const transport = new FakeMessageTransport(1);
  const result = await execute(createSendTool(transport), {
    text: ["sent", "failed", "not attempted"],
    next_action: "sleep",
    sleep_summary: "Should not sleep.",
  });

  assert.deepEqual(result, {
    type: "continue",
    result: { ok: false, error: "Error: send failed", sentCount: 1, messageIds: ["sent-1"] },
  });
  assert.deepEqual(transport.messages, ["sent"]);
});

test("message replies only with the first text and validates the reference", async () => {
  const transport = new FakeMessageTransport();
  const tool = createSendTool(transport);

  await execute(tool, { text: ["reply", "follow-up"], reply_to: "message-1" });
  assert.deepEqual(transport.options, [{ replyTo: "message-1" }, undefined]);

  const rejected = await execute(tool, { text: "not sent", reply_to: "unknown" });
  assert.match(JSON.stringify(rejected), /reply_to is not in the active conversation/);
  assert.deepEqual(transport.messages, ["reply", "follow-up"]);
});

test("reaction targets only an exact message from the active conversation", async () => {
  const gateway = new FakeGateway();
  const tool = createReactToMessageTool({
    gateway,
    getActiveChannelId: () => "general",
    isMessageInActiveConversation: (messageId) => messageId === "message-1",
  });

  assert.deepEqual(
    await execute(tool, {
      message_id: "message-1",
      emoji: "🔥",
      next_action: "wait",
      sleep_summary: null,
    }),
    {
      type: "finish",
      result: { ok: true, messageId: "message-1", emoji: "🔥" },
      outcome: { type: "wait" },
    },
  );
  assert.deepEqual(gateway.reactions, [
    { channelId: "general", messageId: "message-1", emoji: "🔥" },
  ]);

  const rejected = await execute(tool, { message_id: "not-visible", emoji: "👍" });
  assert.match(JSON.stringify(rejected), /not in the active conversation/);
  assert.equal(gateway.reactions.length, 1);
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
  const tool = createScheduleTool(
    gateway,
    {
      async add(input) {
        added.push(input);
        return storedSchedule(input);
      },
    },
    statuses,
  );

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
  const store = {
    async add(input: CreateScheduledMessageInput) {
      return storedSchedule(input);
    },
  };
  const create = (
    creator: { userId: string; username: string } | null = {
      userId: "creator",
      username: "Creator",
    },
  ) => createScheduleTool(gateway, store, [], creator);
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
  assert.match(
    JSON.stringify(await execute(create(), { ...valid, run_date: "2025-12-31" })),
    /future/,
  );
  assert.match(
    JSON.stringify(await execute(create(), { ...valid, repeat: "monthly" })),
    /repeat must/,
  );
  assert.match(
    JSON.stringify(await execute(create(), { ...valid, target_usernames: ["@everyone"] })),
    /real Discord users/,
  );

  gateway.members = [
    { id: "one", username: "sam_one", displayName: "Sam", bot: false },
    { id: "two", username: "sam_two", displayName: "Sam", bot: false },
  ];
  assert.match(
    JSON.stringify(await execute(create(), { ...valid, target_usernames: ["sam"] })),
    /no matching/,
  );
  gateway.channels = [general, { ...plans, sendable: false }];
  assert.match(
    JSON.stringify(await execute(create(), { ...valid, channel: "plans" })),
    /not sendable/,
  );
});

test("scheduled delivery pings only stored target IDs with an explicit mention policy", async () => {
  const gateway = new FakeGateway();
  const deliver = createScheduledMessageDelivery(gateway);
  await deliver(
    storedSchedule({
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
    }),
  );

  assert.deepEqual(gateway.sent, [
    {
      channelId: "plans",
      content: "<@one> <@two> hello @\u200beveryone <@\u200b999>",
      options: { allowUserMentions: true },
    },
  ]);
});

test("Discord capability tools register through the generic tool registry", () => {
  const gateway = new FakeGateway();
  const sendMessage = createSendTool();
  const rememberName = createRememberNameTool({
    gateway,
    users: new UserMentionDirectory(),
    store: {
      async remember() {
        return { ok: false, error: "unused" };
      },
    },
    getActiveChannelId: () => "general",
    logger,
  });
  const scheduledMessage = createScheduleTool(
    gateway,
    {
      async add(input) {
        return storedSchedule(input);
      },
    },
    [],
  );
  const reactToMessage = createReactToMessageTool({
    gateway,
    getActiveChannelId: () => "general",
    isMessageInActiveConversation: () => true,
  });
  const registry = new ToolRegistry([
    sendMessage,
    reactToMessage,
    rememberName,
    scheduledMessage,
    waitTool,
    sleepTool,
  ]);

  assert.deepEqual(
    registry.definitions().map(({ name }) => name),
    ["message", "react_to_message", "remember_name", "create_scheduled_message", "wait", "sleep"],
  );
});

function createSendTool(transport = new FakeMessageTransport()): Tool {
  return createSendMessageTool({
    transport,
    getActiveChannelId: () => "general",
    isMessageInActiveConversation: (messageId) => messageId === "message-1",
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
    status: {
      async logStatus(text) {
        statuses.push(text);
      },
    },
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
  return tool.execute({
    type: "tool_call",
    callId: "call",
    name: tool.definition.name,
    arguments: argumentsValue,
  });
}

class FakeMessageTransport {
  messages: string[] = [];
  options: Array<SendMessageOptions | undefined> = [];

  constructor(private readonly failAt?: number) {}

  async sendMessage(_channelId: string, text: string, options?: SendMessageOptions) {
    if (this.messages.length === this.failAt) throw new Error("send failed");
    this.messages.push(text);
    this.options.push(options);
    return { id: `sent-${String(this.messages.length)}`, createdAt: this.messages.length };
  }
}

class FakeGateway implements DiscordGateway {
  channels: DiscordChannel[] = [general];
  members: DiscordMember[] = [];
  memberError: unknown;
  sent: Array<{ channelId: string; content: string; options: DiscordSendOptions }> = [];
  reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  setHandlers(_handlers: DiscordGatewayHandlers): void {}
  async login(_token: string): Promise<void> {}
  async destroy(): Promise<void> {}
  getBotUser(): DiscordUser | undefined {
    return undefined;
  }
  async fetchChannel(channelId: string): Promise<DiscordChannel | undefined> {
    return this.channels.find((channel) => channel.id === channelId);
  }
  async searchGuildMembers(): Promise<readonly DiscordMember[]> {
    if (this.memberError !== undefined) throw this.memberError;
    return this.members;
  }
  async fetchGuildChannels(): Promise<readonly DiscordChannel[]> {
    return this.channels;
  }
  async sendMessage(channelId: string, content: string, options: DiscordSendOptions) {
    this.sent.push({ channelId, content, options });
    return { id: `sent-${String(this.sent.length)}`, createdAt: this.sent.length };
  }
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji });
  }
  async sendTyping(_channelId: string): Promise<void> {}
  setPresence(_status: "idle" | "online"): void {}
  async registerCommand(): Promise<"registered"> {
    return "registered";
  }
}
