import assert from "node:assert/strict";
import test from "node:test";

import type { ChatTransport } from "../../app/ChatTransport.js";
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
  const registry = new ToolRegistry([sendMessage, rememberPerson, waitTool, sleepTool]);

  assert.deepEqual(registry.definitions().map(({ name }) => name), [
    "send_message",
    "remember_person",
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
}
