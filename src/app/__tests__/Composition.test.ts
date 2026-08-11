import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../createApplication.js";
import type {
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordUser,
} from "../../discord/DiscordGateway.js";
import { Logger } from "../../logger.js";
import { OpenAIUsageStore } from "../../model/openai/OpenAIUsageStore.js";
import { ScriptedModel } from "../../testing/ScriptedModel.js";

test("composition performs no Discord login until explicitly started", async () => {
  const gateway = new FakeGateway();
  const app = createApplication({
    env: {
      discordToken: "token",
      openaiApiKey: "key",
      discordLogChannelId: undefined,
      openaiDailyBudgetUsd: 0,
      logLevel: "error",
      logPrompts: false,
    },
    logger: new Logger("error"),
    gateway,
    conversationModel: new ScriptedModel([]),
    internalModel: new ScriptedModel([]),
    instructions: "Be Ben.",
    usageStore: new OpenAIUsageStore("logs/openai-usage", "gpt-5.4-mini", 0),
  });
  assert.equal(gateway.loginToken, undefined);
  await app.start();
  assert.equal(gateway.loginToken, "token");
  await app.stop();
  assert.equal(gateway.destroyed, true);
});

class FakeGateway implements DiscordGateway {
  handlers: DiscordGatewayHandlers | undefined;
  loginToken: string | undefined;
  destroyed = false;
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
    return undefined;
  }
  async fetchChannel() {
    return undefined;
  }
  async searchGuildMembers() {
    return [];
  }
  async fetchGuildChannels() {
    return [];
  }
  async sendMessage() {}
  async sendTyping() {}
  async addReaction() {}
  setPresence() {}
  async registerCommand(): Promise<"registered"> {
    return "registered";
  }
}
