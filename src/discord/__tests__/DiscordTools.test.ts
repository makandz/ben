import assert from "node:assert/strict";
import test from "node:test";

import type { SendMessageOptions } from "../../app/ChatTransport.js";
import type { Tool } from "../../tools/Tool.js";
import { UserMentionDirectory } from "../DiscordDirectory.js";
import type {
  DiscordChannel,
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordMember,
  DiscordSendOptions,
  DiscordUser,
} from "../DiscordGateway.js";
import { createReactToMessageTool } from "../tools/reactToMessage.js";
import { createRememberNameTool } from "../tools/rememberName.js";
import { createSendMessageTool } from "../tools/sendChannelMessage.js";
import { createThinkTool } from "../tools/think.js";
import { createUpdateCustomStatusTool } from "../tools/updateCustomStatus.js";

const general: DiscordChannel = { id: "general", name: "general", guildId: "guild" };
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

test("custom-status tool sets, resets, and reports the global status", async () => {
  const gateway = new FakeGateway();
  const tool = createUpdateCustomStatusTool({
    gateway,
    store: {
      async set(status) {
        gateway.storedCustomStatuses.push(status);
      },
    },
    getActiveChannelId: () => "general",
    logger,
  });

  assert.deepEqual(await execute(tool, { emoji: " 🍕 ", content: " making   pizza " }), {
    type: "continue",
    result: { ok: true, emoji: "🍕", content: "making pizza", reset: false },
  });
  assert.deepEqual(await execute(tool, { emoji: "🤔", content: null }), {
    type: "continue",
    result: { ok: true, emoji: "🤔", content: null, reset: false },
  });
  assert.deepEqual(await execute(tool, { emoji: null, content: " thinking " }), {
    type: "continue",
    result: { ok: true, emoji: null, content: "thinking", reset: false },
  });
  assert.deepEqual(await execute(tool, { emoji: null, content: null }), {
    type: "continue",
    result: { ok: true, emoji: null, content: null, reset: true },
  });
  assert.deepEqual(gateway.customStatuses, ["🍕 making pizza", "🤔", "thinking", undefined]);
  assert.deepEqual(gateway.storedCustomStatuses, ["🍕 making pizza", "🤔", "thinking", undefined]);
  assert.deepEqual(
    gateway.sent.map(({ content }) => content),
    [
      '> Updated my status to "🍕 making pizza"',
      '> Updated my status to "🤔"',
      '> Updated my status to "thinking"',
      "> Reset my status",
    ],
  );
});

test("custom-status tool reports validation and Discord failures", async () => {
  const gateway = new FakeGateway();
  const tool = createUpdateCustomStatusTool({
    gateway,
    store: {
      async set(status) {
        gateway.storedCustomStatuses.push(status);
      },
    },
    getActiveChannelId: () => "general",
    logger,
  });

  assert.match(
    JSON.stringify(await execute(tool, { emoji: "x".repeat(33), content: null })),
    /at most 32/,
  );
  gateway.customStatusError = new Error("Discord unavailable");
  assert.match(
    JSON.stringify(await execute(tool, { emoji: null, content: "thinking" })),
    /Discord unavailable/,
  );
  assert.match(gateway.sent.at(-1)?.content ?? "", /^> ⚠️ Failed to update my status/);
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

test("think expresses one inner thought and always continues", async () => {
  const transport = new FakeMessageTransport();
  const tool = createThinkTool({
    transport,
    getActiveChannelId: () => "general",
  });

  assert.deepEqual(await execute(tool, { text: "  wait,   something feels off  " }), {
    type: "continue",
    result: { ok: true, messageId: "sent-1" },
  });
  assert.deepEqual(transport.messages, ["> 💭 wait, something feels off"]);
  assert.deepEqual(tool.definition.parameters, {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: 1995,
        description: "The thought to express in your inner voice.",
      },
    },
    required: ["text"],
  });
});

test("think reports validation, active-channel, and delivery failures as continuing results", async () => {
  const transport = new FakeMessageTransport(0);
  const create = (channelId: string | undefined) =>
    createThinkTool({
      transport,
      getActiveChannelId: () => channelId,
    });

  assert.match(JSON.stringify(await execute(create("general"), { text: " " })), /1-1995/);
  assert.match(JSON.stringify(await execute(create(undefined), { text: "hmm" })), /no active/);
  assert.deepEqual(await execute(create("general"), { text: "hmm" }), {
    type: "continue",
    result: { ok: false, error: "Error: send failed" },
  });
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

function createSendTool(transport = new FakeMessageTransport()): Tool {
  return createSendMessageTool({
    transport,
    getActiveChannelId: () => "general",
    isMessageInActiveConversation: (messageId) => messageId === "message-1",
  });
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
  customStatuses: Array<string | undefined> = [];
  storedCustomStatuses: Array<string | undefined> = [];
  customStatusError: unknown;
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
  setCustomStatus(content: string | undefined): void {
    if (this.customStatusError !== undefined) throw this.customStatusError;
    this.customStatuses.push(content);
  }
  async registerCommand(): Promise<"registered"> {
    return "registered";
  }
}
