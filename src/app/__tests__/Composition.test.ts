import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication, type ApplicationDependencies } from "../createApplication.js";
import type {
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordUser,
} from "../../discord/DiscordGateway.js";
import { Logger } from "../../logger.js";
import { OpenAIUsageStore } from "../../model/openai/OpenAIUsageStore.js";
import { ScriptedModel } from "../../testing/ScriptedModel.js";
import { TaskStore } from "../../storage/TaskStore.js";

function compose(
  stateDirectory: string,
  gateway: FakeGateway,
  model = new ScriptedModel([]),
  options: Partial<ApplicationDependencies> = {},
) {
  return createApplication({
    env: {
      discordToken: "token",
      openaiApiKey: "",
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
    stateDirectory,
    usageStore: new OpenAIUsageStore(join(stateDirectory, "usage"), "gpt-5.4-mini", 0),
    ...options,
  });
}

test("composition performs no Discord login until explicitly started", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "ben-composition-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const gateway = new FakeGateway();
  const app = compose(stateDirectory, gateway);
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await pause(5);
  }
  throw new Error("Composition event deadline exceeded");
}

async function shutdownFixture(repeat: "none" | "daily", model: ScriptedModel) {
  const root = await mkdtemp(join(tmpdir(), "ben-shutdown-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  await writeFile(
    join(stateDirectory, "tasks.json"),
    JSON.stringify({
      version: 1,
      revision: 1,
      tasks: [
        {
          id: "shutdown-task",
          version: 1,
          name: "Shutdown task",
          description: "Isolated shutdown regression",
          instructions: "Send a reminder",
          destination: { kind: "current", channelId: "general", channelName: "general" },
          runDate: "2020-01-01",
          runTime: "18:00",
          repeat,
          nextRunAt: "2020-01-01T23:00:00.000Z",
          createdAt: "2019-12-31T00:00:00.000Z",
          updatedAt: "2019-12-31T00:00:00.000Z",
        },
      ],
    }),
  );
  // Exercise normal readiness with both schedulers, keeping consolidation idle.
  await writeFile(
    join(stateDirectory, "memory-consolidation.json"),
    JSON.stringify({ version: 1, nextRunAt: "2099-01-01T00:00:00.000Z" }),
  );
  const events: string[] = [];
  const record = (event: unknown) => {
    events.push(JSON.stringify(event));
  };
  const logger = Object.assign(
    new Logger("error"),
    Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, record])),
  );
  const gateway = new FakeGateway();
  const app = compose(stateDirectory, gateway, model, {
    logger,
    sessionTimings: { messageDebounceMs: 0, idleSleepMs: 10 },
    observer: record,
  });
  await app.start();
  return {
    app,
    gateway,
    stateDirectory,
    events,
    async cleanup() {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("application shutdown drains scheduler startup without late writes or model work", async (t) => {
  for (const repeat of ["none", "daily"] as const) {
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reading = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = TaskStore.prototype.listDue;
    const mocked = t.mock.method(
      TaskStore.prototype,
      "listDue",
      async function (this: TaskStore, ...args: Parameters<TaskStore["listDue"]>) {
        reading = true;
        await gate;
        return original.apply(this, args);
      },
    );
    const model = new ScriptedModel([]);
    const f = await shutdownFixture(repeat, model);
    try {
      const botUser = f.gateway.getBotUser();
      assert.ok(botUser);
      f.gateway.handlers?.ready(botUser);
      await until(() => reading);
      let stopped = false;
      const stopping = f.app.stop().then(() => {
        stopped = true;
      });
      await pause(20);
      assert.equal(stopped, false, "shutdown must drain the active scheduler pass");
      releaseRead();
      await stopping;
      const trace = f.events.join("\n");
      const state = await readFile(join(f.stateDirectory, "tasks.json"), "utf8");
      await pause(100);
      assert.equal(f.events.join("\n"), trace);
      assert.equal(await readFile(join(f.stateDirectory, "tasks.json"), "utf8"), state);
      assert.equal(model.requests.length, 0);
      assert.doesNotMatch(trace, /tasks\.queued|tasks\.missed_advanced/);
      assert.equal(f.gateway.destroyed, true);
    } finally {
      releaseRead();
      await f.cleanup();
      mocked.mock.restore();
    }
  }
});

test("application shutdown drains idle occurrence persistence before closing artifacts", async (t) => {
  let releaseWrite!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let saving = false;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = TaskStore.prototype.completeOccurrence;
  t.mock.method(
    TaskStore.prototype,
    "completeOccurrence",
    async function (this: TaskStore, ...args: Parameters<TaskStore["completeOccurrence"]>) {
      saving = true;
      await gate;
      return original.apply(this, args);
    },
  );
  const model = new ScriptedModel([
    {
      items: [{ type: "tool_call", callId: "wait", name: "wait", arguments: {} }],
    },
  ]);
  const f = await shutdownFixture("none", model);
  try {
    const botUser = f.gateway.getBotUser();
    assert.ok(botUser);
    f.gateway.handlers?.ready(botUser);
    await until(() => saving);
    let stopped = false;
    const stopping = f.app.stop().then(() => {
      stopped = true;
    });
    await pause(30);
    assert.equal(stopped, false, "shutdown must own the already-started idle completion");
    assert.match(await readFile(join(f.stateDirectory, "tasks.json"), "utf8"), /shutdown-task/);
    releaseWrite();
    await stopping;
    const trace = f.events.join("\n");
    const state = await readFile(join(f.stateDirectory, "tasks.json"), "utf8");
    assert.doesNotMatch(state, /shutdown-task/);
    assert.match(trace, /tasks\.completed/);
    await pause(100);
    assert.equal(f.events.join("\n"), trace);
    assert.equal(await readFile(join(f.stateDirectory, "tasks.json"), "utf8"), state);
    assert.equal(model.requests.length, 1);
    assert.equal(f.gateway.destroyed, true);
  } finally {
    releaseWrite();
    await f.cleanup();
  }
});
