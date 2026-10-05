import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync } from "node:fs";
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
import { TaskStore } from "../../storage/TaskStore.js";

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
  const tracePath = join(root, "trace.jsonl");
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
  let closed = false;
  const record = (event: unknown) => {
    if (closed) throw new Error("Cannot write closed test artifacts");
    appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
  };
  const logger = Object.assign(new Logger("error"), {
    debug: (event: string) => record({ event }),
    info: (event: string) => record({ event }),
    warn: (event: string) => record({ event }),
    error: (event: string) => record({ event }),
  });
  const gateway = new FakeGateway();
  const app = createApplication({
    env: {
      discordToken: "local-only",
      openaiApiKey: "",
      discordLogChannelId: undefined,
      discordAdminUserId: undefined,
      openaiDailyBudgetUsd: 0,
      logLevel: "error",
    },
    logger,
    gateway,
    conversationModel: model,
    consolidationModel: new ScriptedModel([]),
    instructions: "Be Ben.",
    consolidationInstructions: "Consolidate memory.",
    usageStore: new OpenAIUsageStore(join(stateDirectory, "usage"), "gpt-5.4-mini", 0),
    stateDirectory,
    sessionTimings: { messageDebounceMs: 0, idleSleepMs: 10 },
    observer: record,
  });
  await app.start();
  return {
    app,
    gateway,
    stateDirectory,
    tracePath,
    closeArtifacts() {
      closed = true;
    },
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
      f.closeArtifacts();
      const trace = await readFile(f.tracePath, "utf8");
      const state = await readFile(join(f.stateDirectory, "tasks.json"), "utf8");
      await pause(100);
      assert.equal(await readFile(f.tracePath, "utf8"), trace);
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
    f.closeArtifacts();
    const trace = await readFile(f.tracePath, "utf8");
    const state = await readFile(join(f.stateDirectory, "tasks.json"), "utf8");
    assert.doesNotMatch(state, /shutdown-task/);
    assert.match(trace, /tasks\.completed/);
    await pause(100);
    assert.equal(await readFile(f.tracePath, "utf8"), trace);
    assert.equal(await readFile(join(f.stateDirectory, "tasks.json"), "utf8"), state);
    assert.equal(model.requests.length, 1);
    assert.equal(f.gateway.destroyed, true);
  } finally {
    releaseWrite();
    await f.cleanup();
  }
});
