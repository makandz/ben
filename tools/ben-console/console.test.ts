import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, symlink, mkdir, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
async function fixture(model: Model, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "ben-console-test-"));
  const events: Record<string, unknown>[] = [];
  const session = await startSession(
    { root, model, emit: (event) => events.push(event) },
    { timings: { messageDebounceMs: 0 }, ...settings },
  );
  return {
    root,
    events,
    session,
    async cleanup() {
      await session.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("protocol validates identifiers, batches and unknown fields", () => {
  assert.equal(parseCommand('{"id":"x","op":"message","content":"hello"}').op, "message");
  assert.throws(() => parseCommand('{"id":"x","op":"start","seed":{"../../logs/foo":{}}}'));
  assert.throws(() => parseCommand('{"op":"inspect"}'));
  assert.throws(() => parseCommand('{"id":"x","op":"inspect","surprise":true}'));
  assert.throws(() => parseCommand('{"id":"x","op":"batch","messages":[]}'));
});

test("stdin handles fragmented lines, CRLF, malformed input and machine-only stdout", async () => {
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
  child.stdin.write('{"id":"a","op":');
  child.stdin.write('"inspect"}\r\ninvalid\n{"id":"b","op":"stop"}\n');
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows[0]?.requestId, "a");
  assert.equal(rows[1]?.requestId, null);
  assert.equal(rows.at(-1)?.status, "stopped");
  assert.equal(stderr, "");
});

test("batch retains speakers and mentions, live trace ordering and exact last outcome", async () => {
  const model = new ScriptedModel([
    turn("message", {
      text: ["hello @alex", "second"],
      reply_to: "10001",
      next_action: "wait",
      sleep_summary: null,
    }),
  ]);
  const f = await fixture(model);
  try {
    f.session.message("batch", [
      { user: "makan", content: "@Ben hello #games" },
      { user: "alex", content: "hi" },
    ]);
    await until(() => f.events.some((event) => event.type === "settled"));
    const prompt = JSON.stringify(model.requests[0]);
    assert.match(prompt, /makan \(unknown\): @Ben hello #games/);
    assert.match(prompt, /alex \(unknown\): hi/);
    assert.equal(f.session.local.messages.filter((message) => message.userId === "9000").length, 2);
    const state = await f.session.inspect();
    assert.equal(state.lastResult?.type, "turn_completed");
    if (state.lastResult?.type === "turn_completed")
      assert.equal(state.lastResult.outcome.type, "wait");
    const trace = (await readFile(f.session.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      trace.filter((event) => event.type !== "diagnostic").map((event) => event.sequence),
      f.events.map((event) => event.sequence),
    );
    assert.match(await readFile(f.session.logPath, "utf8"), /Ben: second/);
    const send = f.events.find((event) => event.type === "discord_send");
    assert.deepEqual(send?.options, { allowUserMentions: true, replyToMessageId: "10001" });
  } finally {
    await f.cleanup();
  }
});

test("isolated seed state never crosses sessions and no ping means no model call", async () => {
  const model = new ScriptedModel([turn("wait")]);
  const a = await fixture(model, {
    seed: { "memories.json": { version: 1, memories: ["private test memory"] } },
  });
  const b = await fixture(new ScriptedModel([]));
  try {
    a.session.message("context", [{ content: "quiet context" }]);
    assert.equal(a.events.find((event) => event.type === "settled")?.status, "no-wake");
    assert.equal(model.requests.length, 0);
    a.session.message("wake", [{ content: "@Ben hi" }]);
    await until(() =>
      a.events.some((event) => event.type === "settled" && event.requestId === "wake"),
    );
    assert.match(JSON.stringify(model.requests), /private test memory/);
    assert.deepEqual((await b.session.inspect()).state, {});
    assert.notEqual(a.session.directory, b.session.directory);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test("delivery failures retain actual tool result and error messages", async () => {
  const f = await fixture(
    new ScriptedModel([
      turn("message", { text: "oops", reply_to: null, next_action: "wait" }),
      turn("sleep", { summary: "failure handled" }),
    ]),
  );
  try {
    f.session.local.fail("send", 1);
    f.session.message("x", [{ content: "@Ben hi" }]);
    await until(() => f.events.some((event) => event.type === "settled"));
    assert.match(await readFile(f.session.tracePath, "utf8"), /Simulated send failure/);
    assert.equal(f.session.local.messages.filter((message) => message.userId === "9000").length, 0);
  } finally {
    await f.cleanup();
  }
  assert.match(serialize({ error: new Error("secret error") }, ["secret"]), /REDACTED/);
  assert.match(serialize({ error: new Error("diagnostic detail") }), /diagnostic detail/);
});

test("input can arrive during model processing and shutdown drains persistence", async () => {
  let release!: (turn: ModelTurn) => void;
  let calls = 0;
  const model: Model = {
    async invoke() {
      calls++;
      return await new Promise<ModelTurn>((resolve) => {
        release = resolve;
      });
    },
  };
  const f = await fixture(model);
  try {
    f.session.message("first", [{ content: "@Ben first" }]);
    await until(() => calls === 1);
    f.session.message("second", [{ user: "alex", content: "follow-up while processing" }]);
    const stopped = f.session.stop();
    release(turn("sleep", { summary: "persisted before shutdown" }));
    await stopped;
    const oldTrace = await readFile(f.session.tracePath, "utf8");
    assert.match(
      await readFile(join(f.session.directory, "state/conversation-summaries.json"), "utf8"),
      /persisted before shutdown/,
    );
    await pause(20);
    assert.equal(await readFile(f.session.tracePath, "utf8"), oldTrace);
    assert.equal(
      f.events.find((event) => event.type === "settled" && event.requestId === "second")?.status,
      "stopped",
    );
  } finally {
    await f.cleanup();
  }
});

test("timeout does not cancel in-flight work or infer completion from emitted messages", async () => {
  let release!: (value: ModelTurn) => void;
  const f = await fixture(
    {
      invoke: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    { timeoutMs: 20 },
  );
  try {
    f.session.message("x", [{ content: "@Ben hi" }]);
    await until(() => f.events.some((event) => event.type === "settled"));
    assert.equal(f.events.find((event) => event.type === "settled")?.status, "timeout");
    release(turn("wait"));
    await until(() => f.events.some((event) => event.type === "turn_completed"));
  } finally {
    await f.cleanup();
  }
});

test("reset waits for old work, preserves artifacts and isolates new events", async () => {
  const root = await mkdtemp(join(tmpdir(), "ben-console-reset-"));
  const events: Record<string, unknown>[] = [];
  let release!: (value: ModelTurn) => void;
  const worker = createWorker({
    root,
    emit: (event) => events.push(event),
    model: {
      invoke: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  try {
    await worker.handle('{"id":"start","op":"start","timings":{"messageDebounceMs":0}}');
    const old = String(events.find((event) => event.type === "ready")?.session);
    await worker.handle('{"id":"m","op":"message","content":"@Ben hi"}');
    await until(() => events.some((event) => event.type === "model_request"));
    const reset = worker.handle('{"id":"reset","op":"reset"}');
    await worker.handle('{"id":"during","op":"inspect"}');
    assert.equal(events.at(-1)?.type, "error");
    release(turn("sleep", { summary: "old session summary" }));
    await reset;
    const ready = events.filter((event) => event.type === "ready");
    assert.equal(ready.length, 2);
    assert.notEqual(ready[0]?.session, ready[1]?.session);
    assert.match(
      await readFile(join(old, "state/conversation-summaries.json"), "utf8"),
      /old session summary/,
    );
    const before = await readFile(join(old, "trace.jsonl"), "utf8");
    await worker.shutdown();
    assert.equal(await readFile(join(old, "trace.jsonl"), "utf8"), before);
  } finally {
    await worker.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("channel wakes interleave with prior sleep and batch completes across both channels", async () => {
  const model = new ScriptedModel([
    turn("sleep", { summary: "general" }),
    turn("sleep", { summary: "games" }),
  ]);
  const f = await fixture(model);
  try {
    f.session.message("two-channels", [
      { content: "@Ben general" },
      { channel: "games", user: "alex", content: "@Ben games" },
    ]);
    await until(() => f.events.some((event) => event.type === "settled"));
    assert.equal(model.requests.length, 2);
    assert.equal(f.events.filter((event) => event.type === "turn_completed").length, 2);
    const settled = f.events.find((event) => event.type === "settled");
    assert.equal((settled?.outcomes as unknown[]).length, 2);
  } finally {
    await f.cleanup();
  }
});

test("a root symlink into live logs is rejected before state files are created", async () => {
  const root = await mkdtemp(join(tmpdir(), "ben-console-root-"));
  try {
    await symlink(join(process.cwd(), "logs"), join(root, "live"));
    await assert.rejects(
      startSession({ root: join(root, "live"), model: new ScriptedModel([]), emit() {} }),
      /must not overlap/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adaptive same-channel follow-up during processing reaches its own terminal outcome", async () => {
  let release!: () => void;
  const scripted = new ScriptedModel([turn("wait"), turn("wait")]);
  let calls = 0;
  const model: Model = {
    async invoke(request) {
      calls++;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return scripted.invoke(request);
    },
  };
  const f = await fixture(model);
  try {
    f.session.message("first", [{ content: "@Ben first" }]);
    await until(() => calls === 1);
    f.session.message("second", [{ user: "alex", content: "adaptive follow-up" }]);
    assert.deepEqual((await f.session.inspect()).pending, ["first", "second"]);
    release();
    await until(() => f.events.filter((event) => event.type === "settled").length === 2);
    assert.equal(scripted.requests.length, 2);
    assert.match(
      JSON.stringify(scripted.requests[1]?.history),
      /alex \(unknown\): adaptive follow-up/,
    );
    assert.deepEqual(
      f.events.filter((event) => event.type === "settled").map((event) => event.requestId),
      ["first", "second"],
    );
  } finally {
    await f.cleanup();
  }
});

test("JSONL start accepts one seed file without inventing missing seed entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ben-console-partial-seed-"));
  const events: Record<string, unknown>[] = [];
  const worker = createWorker({
    root,
    model: new ScriptedModel([]),
    emit: (event) => events.push(event),
  });
  try {
    await worker.handle(
      '{"id":"start","op":"start","seed":{"memories.json":{"version":1,"memories":["a seeded memory"]}}}',
    );
    const ready = events.find((event) => event.type === "ready");
    assert.ok(ready);
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
    assert.deepEqual(await readdir(String(ready.stateDirectory)), ["memories.json"]);
    await worker.handle('{"id":"inspect","op":"inspect"}');
    const result = events.find((event) => event.type === "result" && event.requestId === "inspect");
    const snapshot = result?.state as { state: Record<string, unknown> };
    assert.deepEqual(snapshot.state, {
      "memories.json": { version: 1, memories: ["a seeded memory"] },
    });
  } finally {
    await worker.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping nonexistent roots and symlink ancestors are rejected before any mkdir", async () => {
  const root = await mkdtemp(join(tmpdir(), "ben-console-overlap-"));
  const previousDirectory = process.cwd();
  const production = join(root, "logs");
  try {
    await mkdir(production);
    await symlink(production, join(root, "alias"));
    await symlink(join(production, "pending"), join(root, "dangling-alias"));
    process.chdir(root);
    for (const candidate of [
      join(production, "new", "nested"),
      join(root, "alias", "new", "nested"),
      join(root, "dangling-alias", "child"),
    ]) {
      await assert.rejects(
        startSession({ root: candidate, model: new ScriptedModel([]), emit() {} }),
        /must not overlap/,
      );
    }
    assert.deepEqual(await readdir(production), []);
    await assert.rejects(access(join(production, "new")), { code: "ENOENT" });
    await assert.rejects(access(join(production, "pending")), { code: "ENOENT" });
    await rm(production, { recursive: true });
    await assert.rejects(
      startSession({
        root: join(root, "alias", "missing-production", "nested"),
        model: new ScriptedModel([]),
        emit() {},
      }),
      /must not overlap/,
    );
    await assert.rejects(access(production), { code: "ENOENT" });
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});
