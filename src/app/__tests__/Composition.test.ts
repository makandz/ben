import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEvent } from "../ExecutionObserver.js";

import { createApplication } from "../createApplication.js";
import type {
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordUser,
} from "../../discord/DiscordGateway.js";
import { Logger } from "../../logger.js";
import { OpenAIUsageStore } from "../../model/openai/OpenAIUsageStore.js";
import { ScriptedModel } from "../../testing/ScriptedModel.js";

test("composition performs no Discord login until explicitly started", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "ben-composition-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const gateway = new FakeGateway();
  const app = createApplication({
    env: {
      discordToken: "token",
      openaiApiKey: "key",
      discordLogChannelId: undefined,
      discordAdminUserId: undefined,
      openaiDailyBudgetUsd: 0,
      logLevel: "error",
    },
    logger: new Logger("error"),
    gateway,
    conversationModel: new ScriptedModel([]),
    consolidationModel: new ScriptedModel([]),
    instructions: "Be Ben.",
    consolidationInstructions: "Consolidate memory.",
    stateDirectory,
    usageStore: new OpenAIUsageStore(join(stateDirectory, "usage"), "gpt-5.4-mini", 0),
  });
  assert.equal(gateway.loginToken, undefined);
  await app.start();
  assert.equal(gateway.loginToken, "token");
  await app.stop();
  assert.equal(gateway.destroyed, true);
});

test("composition forwards timing and observer options and isolates durable state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ben-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const usageStore = new OpenAIUsageStore(join(root, "caller-usage"), "gpt-5.4-mini", 0);
  for (const label of ["first", "second"]) {
    const stateDirectory = join(root, label);
    await mkdir(stateDirectory);
    await writeFile(join(stateDirectory, "long-term-memory.txt"), `Long term ${label}`);
    await writeFile(
      join(stateDirectory, "memories.json"),
      JSON.stringify({ version: 1, memories: [`Memory ${label}`] }),
    );
    await writeFile(
      join(stateDirectory, "custom-status.json"),
      JSON.stringify({ version: 1, status: `Status ${label}` }),
    );
    const model = new ScriptedModel([
      {
        items: [
          {
            type: "tool_call",
            callId: "sleep",
            name: "sleep",
            arguments: { summary: `Summary ${label}` },
          },
        ],
      },
    ]);
    const gateway = new FakeGateway();
    let resolve!: () => void;
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const events: ExecutionEvent[] = [];
    const app = createApplication({
      env: {
        discordToken: "token",
        openaiApiKey: "key",
        discordLogChannelId: undefined,
        discordAdminUserId: undefined,
        openaiDailyBudgetUsd: 0,
        logLevel: "error",
      },
      logger: new Logger("error"),
      gateway,
      conversationModel: model,
      consolidationModel: new ScriptedModel([]),
      instructions: "Be Ben.",
      consolidationInstructions: "Consolidate memory.",
      usageStore,
      stateDirectory,
      sessionTimings: { messageDebounceMs: 0 },
      observer(event) {
        events.push(event);
        if (event.type === "turn_completed") resolve();
      },
    });
    t.after(() => app.stop());
    await app.start();
    const botUser = gateway.getBotUser();
    assert.ok(botUser);
    gateway.handlers?.message({
      id: "ping",
      channel: { id: "general", name: "general" },
      author: { id: "makan", username: "Makan", bot: false },
      content: "hello",
      createdAt: Date.now(),
      mentionedUsers: [botUser],
      mentionedChannels: [],
    });
    await Promise.race([
      completed,
      new Promise<void>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Composition timing override was not forwarded")),
          1000,
        );
        timer.unref();
      }),
    ]);
    const request = model.requests[0];
    assert.match(JSON.stringify(request?.history), new RegExp(`Memory ${label}`));
    assert.match(JSON.stringify(request?.history), new RegExp(`Long term ${label}`));
    assert.match(JSON.stringify(request?.history), new RegExp(`Status ${label}`));
    const summaries: unknown = JSON.parse(
      await readFile(join(stateDirectory, "conversation-summaries.json"), "utf8"),
    );
    assert.match(JSON.stringify(summaries), new RegExp(`Summary ${label}`));
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "session_wake",
        "model_request",
        "model_turn",
        "tool_call",
        "tool_result",
        "session_sleep",
        "turn_completed",
      ],
    );
    await app.stop();
  }
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
    return { id: "ben", username: "Ben", bot: true };
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
  async sendMessage() {
    return { id: "sent", createdAt: 0 };
  }
  async addReaction() {}
  async sendTyping() {}
  setPresence() {}
  setCustomStatus() {}
  async registerCommand(): Promise<"registered"> {
    return "registered";
  }
}
