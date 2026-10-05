import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, symlink, mkdir, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OpenAIUsageStore } from "../../src/model/openai/OpenAIUsageStore.js";
import { OPENAI_CONVERSATION_MODEL } from "../../src/model/openai/OpenAIModel.js";
import { ScriptedModel } from "../../src/testing/ScriptedModel.js";
import type { Model, ModelTurn } from "../../src/model/Model.js";
import { parseCommand } from "./protocol.js";
import { startSession, serialize } from "./session.js";
import { createWorker } from "./worker.js";

const turn = (name: string, args: unknown = {}): ModelTurn => ({
  items: [{ type: "tool_call", callId: "call", name, arguments: args }],
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await pause(5);
  }
  throw new Error("Test event deadline exceeded");
}
async function fixture(model: Model) {
  const root = await mkdtemp(join(tmpdir(), "ben-console-test-"));
  const events: Record<string, unknown>[] = [];
  const worker = createWorker({
    root,
    model,
    timings: { messageDebounceMs: 0 },
    emit: (event) => events.push(event),
  });
  const command = (body: unknown) => worker.handle(JSON.stringify(body));
  const ready = () => {
    const event = events.find((event) => event.type === "ready");
    assert.ok(event);
    return event;
  };
  return {
    root,
    events,
    worker,
    command,
    ready,
    async cleanup() {
      await worker.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("protocol rejects invalid commands, unknown fields and seed filenames", () => {
  assert.equal(parseCommand('{"op":"message","content":"hello"}').op, "message");
  for (const line of [
    "invalid",
    '{"op":"reset"}',
    '{"op":"inspect","id":"x"}',
    '{"op":"start","seed":{"../../logs/foo":{}}}',
    '{"op":"batch","messages":[]}',
    '{"op":"message","content":""}',
    '{"op":"start","timings":{}}',
  ])
    assert.throws(() => parseCommand(line));
  assert.match(
    serialize({ error: new Error("secret diagnostic") }, ["secret"]),
    /\[REDACTED\] diagnostic/,
  );
});

test("stdin accepts fragmented JSONL and CRLF with machine-only stdout", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "tools/ben-console/worker.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.write('{"op":');
  child.stdin.end('"inspect"}\r\ninvalid\n{"op":"stop"}\n');
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    rows.map((event) => event.type),
    ["error", "error", "result"],
  );
  assert.equal(rows.at(-1)?.status, "stopped");
  assert.equal(stderr, "");
});

test("personas and multi-channel batches use real prompts, tools and ordered artifacts", async () => {
  const model = new ScriptedModel([
    turn("message", {
      text: ["hello @alex", "second"],
      reply_to: "10001",
      next_action: "sleep",
      sleep_summary: "general summary",
    }),
    turn("sleep", { summary: "games summary" }),
  ]);
  const f = await fixture(model);
  try {
    await f.command({ op: "start" });
    await f.command({
      op: "batch",
      messages: [
        { user: "makan", content: "@Ben hello #games" },
        { user: "alex", content: "hi" },
        { user: "alex", channel: "games", content: "@Ben game night?" },
      ],
    });
    await until(() => f.events.filter((event) => event.type === "turn_completed").length === 2);
    assert.match(JSON.stringify(model.requests[0]), /makan \(unknown\): @Ben hello #games/);
    assert.match(JSON.stringify(model.requests[0]), /alex \(unknown\): hi/);
    assert.match(JSON.stringify(model.requests[1]), /game night/);
    const request = model.requests[0];
    assert.ok(request);
    assert.match(request.instructions, /Ben/);
    assert.ok(request.tools.some((tool) => tool.name === "message"));
    assert.ok(f.events.some((event) => event.type === "tool_result"));
    assert.deepEqual(f.events.find((event) => event.type === "discord_send")?.options, {
      allowUserMentions: true,
      replyToMessageId: "10001",
    });
    const ready = f.ready();
    const trace = (await readFile(String(ready.tracePath), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      trace.filter((event) => event.type !== "diagnostic"),
      f.events.filter((event) => "sequence" in event),
    );
    assert.match(await readFile(String(ready.logPath), "utf8"), /Ben: second/);
    assert.match(
      await readFile(join(String(ready.session), "prompts.json"), "utf8"),
      /instructions/,
    );
  } finally {
    await f.cleanup();
  }
});

test("seed and usage are isolated, unpinged context stays asleep, inspect returns local state", async () => {
  const model = new ScriptedModel([turn("wait")]);
  const a = await fixture(model);
  const b = await fixture(new ScriptedModel([]));
  try {
    await a.command({
      op: "start",
      seed: {
        "memories.json": { version: 1, memories: ["private test memory"] },
        "custom-status.json": { version: 1, status: "private test status" },
        "long-term-memory.txt": "private long term memory",
      },
    });
    await b.command({ op: "start" });
    assert.notEqual(a.ready().session, b.ready().session);
    assert.deepEqual(await readdir(String(a.ready().stateDirectory)), [
      "custom-status.json",
      "long-term-memory.txt",
      "memories.json",
    ]);
    await a.command({ op: "message", content: "quiet context" });
    assert.equal(model.requests.length, 0);
    await a.command({ op: "message", content: "hi", ping: true });
    await until(() => a.events.some((event) => event.type === "turn_completed"));
    for (const expected of [
      "private test memory",
      "private test status",
      "private long term memory",
    ])
      assert.ok(JSON.stringify(model.requests).includes(expected));
    await new OpenAIUsageStore(
      join(String(a.ready().stateDirectory), "openai-usage"),
      OPENAI_CONVERSATION_MODEL,
      1,
    ).record(OPENAI_CONVERSATION_MODEL, {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10,
      totalTokens: 110,
    });
    await a.command({ op: "inspect" });
    assert.ok((a.events.at(-1)?.state as { usage: { costUsd: number } }).usage.costUsd > 0);
    await b.command({ op: "inspect" });
    const state = b.events.at(-1)?.state as {
      state: unknown;
      messages: unknown[];
      usage: { costUsd: number };
    };
    assert.deepEqual(state.state, {});
    assert.deepEqual(state.messages, []);
    assert.equal(state.usage.costUsd, 0);
    await a.command({ op: "message", user: "unknown", content: "hi" });
    assert.equal(a.events.at(-1)?.type, "error");
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test("input remains available during processing; stop guards lifecycle and drains persistence", async () => {
  let release!: (value: ModelTurn) => void;
  const prompts: string[] = [];
  const f = await fixture({
    invoke(request) {
      prompts.push(JSON.stringify(request.history));
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const starting = f.command({ op: "start" });
    await f.command({ op: "inspect" });
    assert.equal(f.events.at(-1)?.type, "error");
    await starting;
    await f.command({ op: "message", content: "@Ben first" });
    await until(() => f.events.some((event) => event.type === "model_request"));
    await f.command({ op: "message", user: "alex", content: "follow-up while processing" });
    assert.equal(f.events.at(-1)?.type, "result");
    release(turn("wait"));
    await until(() => prompts.length === 2);
    assert.match(prompts[1] ?? "", /alex \(unknown\): follow-up while processing/);
    const beforeStop = f.events.length;
    const stopping = f.command({ op: "stop" });
    await f.command({ op: "inspect" });
    assert.ok(
      f.events.slice(beforeStop).some((event) => event.type === "error" && event.op === "inspect"),
    );
    release(turn("sleep", { summary: "persisted before shutdown" }));
    await stopping;
    const tracePath = String(f.ready().tracePath);
    const trace = await readFile(tracePath, "utf8");
    assert.match(
      await readFile(join(String(f.ready().stateDirectory), "conversation-summaries.json"), "utf8"),
      /persisted before shutdown/,
    );
    await pause(20);
    assert.equal(await readFile(tracePath, "utf8"), trace);
    assert.equal(f.events.at(-1)?.status, "stopped");
    await f.command({ op: "message", content: "too late" });
    assert.equal(f.events.at(-1)?.type, "error");
  } finally {
    release?.(turn("sleep", { summary: "cleanup" }));
    await f.cleanup();
  }
});

test("shared-root symlinks and nonexistent ancestors are rejected before mkdir", async () => {
  const root = await mkdtemp(join(tmpdir(), "ben-console-overlap-"));
  const previousDirectory = process.cwd();
  const production = join(root, "logs");
  try {
    await mkdir(production);
    await symlink(production, join(root, "alias"));
    await symlink(join(production, "pending"), join(root, "dangling-alias"));
    process.chdir(root);
    for (const candidate of [
      root,
      production,
      join(production, "new", "nested"),
      join(production, "..hidden"),
      join(root, "alias", "new"),
      join(root, "dangling-alias", "child"),
    ]) {
      await assert.rejects(
        startSession({ root: candidate, model: new ScriptedModel([]), emit() {} }),
        /must not overlap/,
      );
    }
    assert.deepEqual(await readdir(production), []);
    await rm(production, { recursive: true });
    await assert.rejects(
      startSession({ root: join(root, "alias", "new"), model: new ScriptedModel([]), emit() {} }),
      /must not overlap/,
    );
    await assert.rejects(access(production), { code: "ENOENT" });
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});
