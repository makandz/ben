import assert from "node:assert/strict";
import test from "node:test";
import {
  BotSession,
  type ConversationRunner,
  type BotSessionPersistence,
  type BotSessionTimingOverrides,
} from "../BotSession.js";
import type { ChatTransport } from "../ChatTransport.js";
import { ConversationOrchestrator } from "../ConversationOrchestrator.js";
import {
  observeExecution,
  type ExecutionEvent,
  type ExecutionObserver,
} from "../ExecutionObserver.js";
import { ScriptedModel } from "../../testing/ScriptedModel.js";
import { RecordingTransport } from "../../testing/RecordingTransport.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { sleepTool, waitTool } from "../../tools/conversationControls.js";
import type { Tool } from "../../tools/Tool.js";

const logger = { debug() {}, info() {}, warn() {} };
const ping = {
  id: "ping",
  channelId: "general",
  userId: "human",
  username: "Makan",
  content: "hello",
  createdAt: 0,
};
const call = (name: string, args: unknown = {}) => ({
  type: "tool_call" as const,
  callId: name,
  name,
  arguments: args,
});

function completionObserver(events: ExecutionEvent[]) {
  let resolve!: () => void;
  const completed = new Promise<void>((done) => {
    resolve = done;
  });
  const observer: ExecutionObserver = (event) => {
    events.push(event);
    if (event.type === "turn_completed") resolve();
  };
  return { observer, completed };
}

function createSession(
  runner: ConversationRunner,
  observer: ExecutionObserver,
  options: {
    transport?: ChatTransport;
    persistence?: BotSessionPersistence;
    timings?: BotSessionTimingOverrides;
  } = {},
) {
  return new BotSession(
    "instructions",
    runner,
    options.transport ?? new RecordingTransport(),
    { setPresence() {} },
    logger,
    { messageDebounceMs: 0, idleSleepMs: 10000, ...options.timings },
    options.persistence,
    {},
    observer,
  );
}

test("records the complete ordered trace through persisted sleep and queued wake promotion", async (t) => {
  const events: ExecutionEvent[] = [];
  const { observer, completed } = completionObserver(events);
  let saved = "";
  let savedAtCompletion = "";
  const persistence = {
    summaries: {
      async list() {
        return [];
      },
      async add(summary: string) {
        saved = summary;
      },
    },
  };
  const lookup: Tool = {
    definition: { name: "lookup", description: "Lookup", parameters: {} },
    async execute() {
      return { type: "continue", result: { found: true } };
    },
  };
  const model = new ScriptedModel([
    { items: [call("lookup")] },
    { items: [call("sleep", { summary: "Saved summary" })] },
  ]);
  const registry = new ToolRegistry([lookup, sleepTool]);
  const session = createSession(
    new ConversationOrchestrator(model, registry, undefined, observer),
    (event) => {
      if (event.type === "turn_completed") savedAtCompletion = saved;
      observer(event);
    },
    { persistence },
  );
  t.after(() => session.stop());
  session.handleMessage(ping, true);
  session.handleMessage({ ...ping, id: "other", channelId: "other" }, true);
  await completed;
  assert.equal(savedAtCompletion, "Saved summary");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "session_wake",
      "model_request",
      "model_turn",
      "tool_call",
      "tool_result",
      "model_request",
      "model_turn",
      "tool_call",
      "tool_result",
      "session_sleep",
      "session_wake",
      "turn_completed",
    ],
  );
  assert.deepEqual(events[1], { type: "model_request", request: model.requests[0] });
  assert.deepEqual(events[5], { type: "model_request", request: model.requests[1] });
  assert.deepEqual(events[8], {
    type: "tool_result",
    call: call("sleep", { summary: "Saved summary" }),
    execution: {
      type: "finish",
      result: { ok: true, pausedUntil: "ping_after_sleep" },
      outcome: { type: "sleep", summary: "Saved summary" },
    },
  });
  assert.deepEqual(events.at(-1), {
    type: "turn_completed",
    channelId: "general",
    outcome: { type: "sleep", summary: "Saved summary" },
  });
  assert.equal(session.getActiveChannelId(), "other");
});

test("completes reply turns after delivery and does not recreate timers after stop", async () => {
  const events: ExecutionEvent[] = [];
  const { observer, completed } = completionObserver(events);
  let release!: () => void;
  let started!: () => void;
  const delivering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delivery = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = createSession(
    {
      async run() {
        return { type: "reply", text: "hi", history: [] };
      },
    },
    observer,
    {
      timings: { idleSleepMs: 1, typingRefreshMs: 1 },
      transport: {
        async sendMessage() {
          started();
          await delivery;
          return { id: "delivered", createdAt: 0 };
        },
        async sendTyping() {},
        async logStatus() {},
      },
    },
  );
  session.handleMessage(ping, true);
  await delivering;
  assert.equal(
    events.some((event) => event.type === "turn_completed"),
    false,
  );
  session.stop();
  release();
  await completed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    events.map((event) => event.type),
    ["session_wake", "session_stopped", "turn_completed"],
  );
});

test("contains observer throws, rejected promises, uncloneable events, and attempted mutations", async () => {
  const model = new ScriptedModel([{ items: [call("wait")] }]);
  const events: ExecutionEvent[] = [];
  const observer: ExecutionObserver = (event) => {
    events.push(event);
    if (event.type === "model_request") {
      event.request.instructions = "mutated";
      throw new Error("observer failure");
    }
    if (event.type === "model_turn") event.turn.items.length = 0;
    if (event.type === "tool_call") event.call.name = "mutated";
    return Promise.reject(new Error("async observer failure"));
  };
  const result = await new ConversationOrchestrator(
    model,
    new ToolRegistry([waitTool]),
    undefined,
    observer,
  ).run("instructions", [], "hello");
  assert.equal(result.type, "wait");
  assert.equal(model.requests[0]?.instructions, "instructions");
  assert.equal(events.at(-1)?.type, "tool_result");
  observeExecution(observer, { type: "model_error", error: () => undefined });
  const fallback = events.at(-1);
  assert.equal(fallback?.type, "model_error");
  if (fallback?.type === "model_error") assert.equal(typeof fallback.error, "string");
  await new Promise((resolve) => setImmediate(resolve));
});

test("records model and tool errors including synchronous boundary failures", async () => {
  const events: ExecutionEvent[] = [];
  const observer: ExecutionObserver = (event) => {
    events.push(event);
  };
  const failedModel = new ConversationOrchestrator(
    {
      invoke() {
        throw new Error("model failed");
      },
    },
    new ToolRegistry(),
    undefined,
    observer,
  );
  assert.equal((await failedModel.run("instructions", [], "hello")).type, "failed");
  assert.deepEqual(
    events.map((event) => event.type),
    ["model_request", "model_error"],
  );
  const error = events[1];
  assert.ok(error?.type === "model_error");
  assert.match(String(error.error), /model failed/);
  events.length = 0;
  const broken: Tool = {
    definition: { name: "broken", description: "Broken", parameters: {} },
    execute() {
      throw new Error("tool failed");
    },
  };
  const failedTool = new ConversationOrchestrator(
    new ScriptedModel([{ items: [call("broken")] }]),
    new ToolRegistry([broken]),
    undefined,
    observer,
  );
  assert.equal((await failedTool.run("instructions", [], "hello")).type, "failed");
  assert.deepEqual(
    events.map((event) => event.type),
    ["model_request", "model_turn", "tool_call", "tool_error"],
  );
});

test("reports contained persistence and delivery errors before completing outcomes", async (t) => {
  for (const outcome of [
    { type: "sleep" as const, summary: "summary" },
    { type: "reply" as const, text: "reply", history: [] },
  ]) {
    const events: ExecutionEvent[] = [];
    const { observer, completed } = completionObserver(events);
    const transport = new RecordingTransport();
    transport.sendMessage = async () => {
      throw new Error("delivery unavailable");
    };
    const session = createSession(
      {
        async run() {
          return outcome;
        },
      },
      observer,
      {
        transport,
        persistence: {
          summaries: {
            async list() {
              return [];
            },
            async add() {
              throw new Error("persistence unavailable");
            },
          },
        },
      },
    );
    t.after(() => session.stop());
    session.handleMessage(ping, true);
    await completed;
    const error = events.find((event) => event.type === "outcome_error");
    assert.ok(error?.type === "outcome_error");
    assert.equal(error.operation, outcome.type === "sleep" ? "summary" : "delivery");
    assert.ok(error.error instanceof Error);
    assert.equal(events.at(-1)?.type, "turn_completed");
  }
});

test("observes dreaming and idle sleep transitions without awaiting async observers", async (t) => {
  const events: ExecutionEvent[] = [];
  let resolve!: () => void;
  const slept = new Promise<void>((done) => {
    resolve = done;
  });
  const session = createSession(
    {
      async run() {
        return { type: "wait", history: [] };
      },
    },
    (event) => {
      events.push(event);
      if (event.type === "session_sleep") resolve();
      return new Promise<void>(() => {});
    },
    { timings: { idleSleepMs: 1 } },
  );
  t.after(() => session.stop());
  assert.equal(session.beginDreaming(), true);
  session.finishDreaming();
  session.handleMessage(ping, true);
  await slept;
  assert.deepEqual(
    events.map((event) => event.type),
    ["session_dreaming", "session_dreaming", "session_wake", "turn_completed", "session_sleep"],
  );
  assert.deepEqual(events.at(-1), { type: "session_sleep", channelId: "general", reason: "idle" });
});

test("completes task turns after their durable completion callback settles", async (t) => {
  const events: ExecutionEvent[] = [];
  const { observer, completed } = completionObserver(events);
  let release!: () => void;
  let started!: () => void;
  const saving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const saved = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = createSession(
    {
      async run() {
        return { type: "sleep", summary: "task done" };
      },
    },
    observer,
  );
  t.after(() => session.stop());
  session.enqueueTask(
    {
      id: "task",
      version: 1,
      name: "Task",
      description: "Task",
      instructions: "Do task",
      destination: { kind: "named", channelId: "tasks", channelName: "tasks" },
      runDate: "2026-10-05",
      runTime: "12:00",
      repeat: "none",
      nextRunAt: "2026-10-05T16:00:00Z",
      createdAt: "2026-10-04T16:00:00Z",
      updatedAt: "2026-10-04T16:00:00Z",
    },
    async () => {
      started();
      await saved;
    },
  );
  await saving;
  assert.equal(events.at(-1)?.type, "session_sleep");
  assert.equal(
    events.some((event) => event.type === "turn_completed"),
    false,
  );
  release();
  await completed;
  assert.deepEqual(events.at(-1), {
    type: "turn_completed",
    channelId: "tasks",
    outcome: { type: "sleep", summary: "task done" },
  });
});
