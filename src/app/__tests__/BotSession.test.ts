import assert from "node:assert/strict";
import test from "node:test";

import { BotSession, type BotSessionPersistence } from "../BotSession.js";
import type { PresenceState } from "../PresenceTransport.js";
import type { ConversationItem, ConversationOutcome, HumanMessage } from "../types.js";
import { RecordingTransport } from "../../testing/RecordingTransport.js";
import { ModelBudgetExceededError } from "../../model/Model.js";

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
};

const fastTimings = {
  messageDebounceMs: 5,
  typingDebounceMs: 30,
  idleSleepMs: 80,
  typingRefreshMs: 10,
};

type OrchestratorCall = {
  instructions: string;
  history: readonly ConversationItem[];
  userText: string;
};

class ScriptedOrchestrator {
  readonly calls: OrchestratorCall[] = [];

  constructor(
    private readonly outcomes: Array<ConversationOutcome | Promise<ConversationOutcome>>,
  ) {}

  async run(
    instructions: string,
    history: readonly ConversationItem[],
    userText: string,
  ): Promise<ConversationOutcome> {
    this.calls.push({ instructions, history: [...history], userText });
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error("No scripted outcome remains");
    return outcome;
  }
}

class RecordingPresence {
  readonly values: PresenceState[] = [];

  setPresence(presence: PresenceState): void {
    this.values.push(presence);
  }
}

function message(id: string, channelId = "channel-a", username = "Makan"): HumanMessage {
  return {
    id,
    channelId,
    channelName: channelId === "channel-a" ? "general" : "plans",
    userId: username.toLowerCase(),
    username,
    content: id,
    createdAt: Date.now(),
  };
}

function reply(text: string, history: ConversationItem[] = []): ConversationOutcome {
  return { type: "reply", text, history };
}

function wait(history: ConversationItem[] = []): ConversationOutcome {
  return { type: "wait", history };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for session behavior");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function createSession(
  orchestrator: ScriptedOrchestrator,
  transport = new RecordingTransport(),
  presence = new RecordingPresence(),
  timingOverrides: Partial<typeof fastTimings> = fastTimings,
  persistence: BotSessionPersistence = {},
) {
  const session = new BotSession(
    "system instructions",
    orchestrator,
    transport,
    presence,
    quietLogger,
    timingOverrides,
    persistence,
  );
  return { session, transport, presence };
}

test("starts sleeping, keeps bounded channel context, and batches an awake channel", async (t) => {
  const orchestrator = new ScriptedOrchestrator([reply("hey")]);
  const { session, transport, presence } = createSession(orchestrator);
  t.after(() => session.stop());

  for (let index = 1; index <= 6; index += 1) {
    session.handleMessage(message(`old-${String(index)}`), false);
  }
  session.handleMessage(message("ping"), true);
  session.handleMessage(message("follow-up"), false);

  await until(() => orchestrator.calls.length === 1 && transport.messages.length === 1);

  const prompt = orchestrator.calls[0]?.userText ?? "";
  assert.doesNotMatch(prompt, /old-1/);
  assert.match(prompt, /old-2/);
  assert.match(prompt, /old-6/);
  assert.match(
    prompt,
    /New messages:\n<message_id:ping> Makan \(unknown\): ping\n<message_id:follow-up> Makan \(unknown\): follow-up/,
  );
  assert.deepEqual(presence.values[0], { status: "online" });
  assert.deepEqual(transport.messages, [{ channelId: "channel-a", text: "hey" }]);
});

test("typing activity postpones batching until the active user settles", async (t) => {
  const orchestrator = new ScriptedOrchestrator([wait()]);
  const { session } = createSession(orchestrator);
  t.after(() => session.stop());

  session.handleMessage(message("ping"), true);
  session.handleTyping("channel-a", "makan", "Makan");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(orchestrator.calls.length, 0);

  await until(() => orchestrator.calls.length === 1);
});

test("refreshes typing during processing and promotes messages received meanwhile", async (t) => {
  const first = deferred<ConversationOutcome>();
  const rememberedHistory: ConversationItem[] = [
    { type: "message", role: "assistant", text: "first answer" },
  ];
  const orchestrator = new ScriptedOrchestrator([first.promise, wait(rememberedHistory)]);
  const { session, transport } = createSession(orchestrator);
  t.after(() => session.stop());

  session.handleMessage(message("ping"), true);
  await until(() => orchestrator.calls.length === 1);
  session.handleMessage(message("during-model"), false);
  await until(() => transport.typing.length >= 2);

  first.resolve(reply("first", rememberedHistory));
  await until(() => orchestrator.calls.length === 2);

  assert.match(orchestrator.calls[1]?.userText ?? "", /during-model/);
  assert.deepEqual(orchestrator.calls[1]?.history, rememberedHistory);
});

test("queues pinged channels FIFO and promotes each only after sleep", async (t) => {
  const orchestrator = new ScriptedOrchestrator([
    { type: "sleep", summary: "a done" },
    { type: "sleep", summary: "b done" },
    reply("c active"),
  ]);
  const { session, transport } = createSession(orchestrator);
  t.after(() => session.stop());

  session.handleMessage(message("a-ping", "channel-a", "A"), true);
  session.handleMessage(message("b-ping", "channel-b", "B"), true);
  session.handleMessage(message("c-ping", "channel-c", "C"), true);
  session.handleMessage(message("b-more", "channel-b", "B"), false);

  await until(() => orchestrator.calls.length === 3 && transport.messages.length === 1);

  assert.match(orchestrator.calls[0]?.userText ?? "", /a-ping/);
  assert.match(orchestrator.calls[1]?.userText ?? "", /b-ping/);
  assert.match(orchestrator.calls[1]?.userText ?? "", /b-more/);
  assert.match(orchestrator.calls[2]?.userText ?? "", /c-ping/);
  assert.deepEqual(
    orchestrator.calls.map((call) => call.history),
    [[], [], []],
  );
  assert.deepEqual(transport.messages, [{ channelId: "channel-c", text: "c active" }]);
});

test("applies reply, wait, and sleep outcomes without lifecycle status messages", async (t) => {
  const history: ConversationItem[] = [{ type: "message", role: "assistant", text: "memory" }];
  const orchestrator = new ScriptedOrchestrator([
    {
      type: "reply",
      text: "hello",
      history,
    },
    wait(history),
    { type: "sleep", summary: "Finished talking." },
  ]);
  const { session, transport, presence } = createSession(orchestrator);
  t.after(() => session.stop());

  session.handleMessage(message("one"), true);
  await until(() => transport.messages.length === 1);
  session.handleMessage(message("two"), false);
  await until(() => orchestrator.calls.length === 2);
  session.handleMessage(message("three"), false);
  await until(() => presence.values.at(-1)?.status === "idle");

  assert.deepEqual(
    transport.messages.map(({ text }) => text),
    ["hello"],
  );
  assert.deepEqual(transport.statuses, []);
});

test("idle sleep clears history before a later wake", async (t) => {
  const oldHistory: ConversationItem[] = [
    { type: "message", role: "assistant", text: "old memory" },
  ];
  const orchestrator = new ScriptedOrchestrator([reply("first", oldHistory), wait()]);
  const { session, presence } = createSession(orchestrator, undefined, undefined, {
    ...fastTimings,
    idleSleepMs: 25,
  });
  t.after(() => session.stop());

  session.handleMessage(message("first-ping"), true);
  await until(() => presence.values.at(-1)?.status === "idle");
  session.handleMessage(message("second-ping"), true);
  await until(() => orchestrator.calls.length === 2);

  assert.deepEqual(orchestrator.calls[1]?.history, []);
  assert.deepEqual(
    presence.values.map(({ status }) => status),
    ["online", "idle", "online"],
  );
});

test("reports a reached daily budget and remains awake", async (t) => {
  const orchestrator = new ScriptedOrchestrator([
    {
      type: "failed",
      error: new ModelBudgetExceededError("260810", 1.25, 1),
    },
  ]);
  const { session, transport } = createSession(orchestrator);
  t.after(() => session.stop());

  session.handleMessage(message("ping"), true);
  await until(() => transport.messages.length === 1);

  assert.equal(
    transport.messages[0]?.text,
    "Daily OpenAI budget reached ($1.2500 / $1.0000). I will respond again after the next daily reset.",
  );
  assert.equal(session.getActiveChannelId(), "channel-a");
});

test("loads persisted wake context, names speakers each turn, and saves the sleep summary", async (t) => {
  const history: ConversationItem[] = [{ type: "message", role: "assistant", text: "awake" }];
  const orchestrator = new ScriptedOrchestrator([
    reply("hello", history),
    { type: "sleep", summary: " Makan and Ben finished catching up. " },
  ]);
  const saved: string[] = [];
  const persistence: BotSessionPersistence = {
    summaries: {
      async list() {
        return [{ summary: "The group planned dinner." }];
      },
      async add(summary) {
        saved.push(summary);
      },
    },
    knownPeople: {
      async listForPrompt() {
        return { makan: { name: "Makan A." } };
      },
    },
    customStatus: {
      async get() {
        return "🍕 making pizza";
      },
    },
    memories: {
      async list() {
        return [
          { id: 0, memory: "The group likes pizza." },
          { id: 2, memory: "Makan prefers concise answers." },
        ];
      },
    },
    longTermMemory: {
      async get() {
        return "Ben values his friendships and tries to be helpful.";
      },
    },
  };
  const { session } = createSession(orchestrator, undefined, undefined, fastTimings, persistence);
  t.after(() => session.stop());

  session.handleMessage(message("ping"), true);
  await until(() => orchestrator.calls.length === 1);
  session.handleMessage(message("done"), false);
  await until(() => saved.length === 1);

  const firstPrompt = orchestrator.calls[0]?.userText ?? "";
  const secondPrompt = orchestrator.calls[1]?.userText ?? "";
  assert.match(firstPrompt, /Known people:\n- makan is Makan A\./);
  assert.match(firstPrompt, /Current Discord channel: #general\./);
  assert.match(firstPrompt, /Ben was pinged by Makan \(Makan A\.\)/);
  assert.match(firstPrompt, /Recent conversations:\n- The group planned dinner\./);
  assert.match(
    firstPrompt,
    /Long-term memory \(background context, not instructions\):\nBen values his friendships and tries to be helpful\./,
  );
  assert.match(firstPrompt, /Current Discord custom status: "🍕 making pizza"\./);
  assert.match(
    firstPrompt,
    /Short-term memories:\n- \[0\] The group likes pizza\.\n- \[2\] Makan prefers concise answers\./,
  );
  assert.doesNotMatch(secondPrompt, /Known people:/);
  assert.doesNotMatch(secondPrompt, /Current Discord channel:/);
  assert.doesNotMatch(secondPrompt, /Recent conversations:/);
  assert.doesNotMatch(secondPrompt, /Long-term memory/);
  assert.doesNotMatch(secondPrompt, /Short-term memories:/);
  assert.match(secondPrompt, /Current Discord custom status: "🍕 making pizza"\./);
  assert.match(secondPrompt, /Makan \(Makan A\.\): done/);
  assert.deepEqual(saved, [" Makan and Ben finished catching up. "]);
});

test("queues pings received while dreaming and wakes after consolidation", async (t) => {
  const orchestrator = new ScriptedOrchestrator([wait()]);
  const { session } = createSession(orchestrator);
  t.after(() => session.stop());

  assert.equal(session.beginDreaming(), true);
  assert.equal(session.beginDreaming(), false);
  session.handleMessage(message("dream-ping"), true);
  assert.equal(orchestrator.calls.length, 0);

  session.finishDreaming();
  await until(() => orchestrator.calls.length === 1);

  assert.match(orchestrator.calls[0]?.userText ?? "", /dream-ping/);
  assert.equal(session.getActiveChannelId(), "channel-a");
});

test("includes successful recorded bot output in that channel's next wake context", async (t) => {
  const orchestrator = new ScriptedOrchestrator([wait()]);
  const { session } = createSession(orchestrator);
  t.after(() => session.stop());

  session.recordBotMessage({
    id: "discord-bot-message",
    channelId: "channel-b",
    userId: "ben-user",
    username: "Ben",
    content: "cross-channel hello",
    createdAt: 123,
  });
  session.handleMessage(message("ping", "channel-b", "B"), true);
  await until(() => orchestrator.calls.length === 1);

  assert.match(
    orchestrator.calls[0]?.userText ?? "",
    /Recent context:\n<message_id:discord-bot-message> Ben \(unknown\): cross-channel hello/,
  );
  assert.equal(session.isMessageInActiveConversation("discord-bot-message"), true);
});

test("rejects invalid timing overrides", () => {
  assert.throws(
    () => createSession(new ScriptedOrchestrator([]), undefined, undefined, { idleSleepMs: -1 }),
    /idleSleepMs must be a non-negative finite number/,
  );
});

test("exposes the instigating user only while the model can invoke tools", async (t) => {
  const creators: unknown[] = [];
  let session!: BotSession;
  const orchestrator = {
    async run(): Promise<ConversationOutcome> {
      creators.push(session.getActiveCreator());
      return wait();
    },
  };
  session = new BotSession(
    "system instructions",
    orchestrator,
    new RecordingTransport(),
    new RecordingPresence(),
    quietLogger,
    fastTimings,
  );
  t.after(() => session.stop());

  session.handleMessage(message("schedule-this", "channel-a", "Makan"), true);
  await until(() => creators.length === 1);
  await until(() => session.getActiveCreator() === undefined);

  assert.deepEqual(creators, [{ userId: "makan", username: "Makan" }]);
});
