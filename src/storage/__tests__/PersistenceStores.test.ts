import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationSummaryStore } from "../ConversationSummaryStore.js";
import { CustomStatusStore } from "../CustomStatusStore.js";
import { KnownPeopleStore } from "../KnownPeopleStore.js";
import { MemoryStore } from "../MemoryStore.js";
import { LongTermMemoryStore } from "../LongTermMemoryStore.js";
import { MemoryConsolidationStateStore } from "../MemoryConsolidationStateStore.js";
import { ScheduledMessageStore } from "../ScheduledMessageStore.js";

const warnings: string[] = [];
const logger = {
  warn(event: string) {
    warnings.push(event);
  },
};

test("custom-status store atomically persists and resets the rendered status", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "custom-status.json");
  const store = new CustomStatusStore(filePath, logger);

  assert.equal(await store.get(), undefined);
  await store.set("🍕 making pizza");
  assert.equal(await store.get(), "🍕 making pizza");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    version: 1,
    status: "🍕 making pizza",
  });
  await store.set(undefined);
  assert.equal(await store.get(), undefined);
  assert.deepEqual(await readdir(directory), ["custom-status.json"]);
});

test("custom-status store contains malformed data", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "custom-status.json");
  const store = new CustomStatusStore(filePath, logger);

  await writeFile(filePath, JSON.stringify({ status: 42 }));
  assert.equal(await store.get(), undefined);
  await writeFile(filePath, "not json");
  assert.equal(await store.get(), undefined);
});

test("summary store reads the current shape, bounds entries, and writes atomically", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "conversation-summaries.json");
  await copyFile("src/testing/fixtures/conversation-summaries.json", filePath);
  const store = new ConversationSummaryStore(filePath, logger);

  assert.deepEqual(await store.list(), [
    {
      sleptAt: "2026-01-02T03:04:05.000Z",
      summary: "Ben and the group discussed a fictional weekend plan.",
    },
  ]);
  await Promise.all(
    Array.from({ length: 26 }, (_, index) =>
      store.add(` summary ${String(index + 1)} `, new Date(2026, 1, index + 1)),
    ),
  );

  const stored = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    conversations: Array<{ summary: string }>;
  };
  assert.equal(stored.version, 1);
  assert.deepEqual(
    stored.conversations.map(({ summary }) => summary),
    Array.from({ length: 25 }, (_, index) => `summary ${String(index + 2)}`),
  );
  await store.clear();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(directory), ["conversation-summaries.json"]);
});

test("summary store ignores malformed entries and contains malformed files", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "summaries.json");
  const store = new ConversationSummaryStore(filePath, logger);
  await writeFile(
    filePath,
    JSON.stringify({
      conversations: [
        { sleptAt: "valid", summary: " kept " },
        { sleptAt: 1, summary: "bad" },
        { sleptAt: "empty", summary: " " },
      ],
    }),
  );
  assert.deepEqual(await store.list(), [{ sleptAt: "valid", summary: "kept" }]);
  await writeFile(filePath, "not json");
  assert.deepEqual(await store.list(), []);
});

test("known-people store reads the current shape, updates IDs, and rejects username duplicates", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "known-people.json");
  await copyFile("src/testing/fixtures/known-people.json", filePath);
  const store = new KnownPeopleStore(filePath, logger);

  assert.deepEqual(await store.listForPrompt(), { sample_user: { name: "Sample" } });
  const [remembered] = await Promise.all([
    store.remember({
      userId: "100000000000000002",
      username: "New_User",
      name: " New Person ",
    }),
    store.remember({ userId: "100000000000000004", username: "second", name: "Second" }),
  ]);
  assert.deepEqual(remembered, { ok: true, username: "New_User", name: "New Person" });
  assert.deepEqual(
    await store.remember({
      userId: "100000000000000002",
      username: "New_User",
      name: "Updated Person",
    }),
    { ok: true, username: "New_User", name: "Updated Person" },
  );
  assert.deepEqual(
    await store.remember({
      userId: "100000000000000003",
      username: "new_user",
      name: "Duplicate",
    }),
    { ok: false, error: 'New_User is already remembered as "Updated Person"' },
  );
  assert.deepEqual(await store.listForPrompt(), {
    sample_user: { name: "Sample" },
    new_user: { name: "Updated Person" },
    second: { name: "Second" },
  });
  assert.deepEqual(await readdir(directory), ["known-people.json"]);
});

test("known-people store ignores malformed entries and rejects malformed containers", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "known.json");
  const store = new KnownPeopleStore(filePath, logger);
  await writeFile(
    filePath,
    JSON.stringify({
      people: {
        good: { username: " Good ", name: " Person " },
        bad: { username: "", name: "Nobody" },
        scalar: 2,
      },
    }),
  );
  assert.deepEqual(await store.listForPrompt(), { good: { name: "Person" } });
  await writeFile(filePath, JSON.stringify({ people: [] }));
  await assert.rejects(() => store.listForPrompt(), /people must be a JSON object/);
});

test("memory store adds, updates, and tombstones stable numeric IDs", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "memories.json");
  await copyFile("src/testing/fixtures/memories.json", filePath);
  const store = new MemoryStore(filePath, logger);

  assert.deepEqual(await store.list(), [
    { id: 0, memory: "The group usually plays games on Friday evenings." },
    { id: 2, memory: "Makan prefers concise technical explanations." },
  ]);
  assert.deepEqual(await store.remember({ action: "delete", id: 0 }), {
    ok: true,
    action: "deleted",
    id: 0,
    memory: "The group usually plays games on Friday evenings.",
  });
  assert.deepEqual(
    await store.remember({ action: "update", id: 2, memory: " Makan likes concise answers. " }),
    { ok: true, action: "updated", id: 2, memory: "Makan likes concise answers." },
  );
  assert.deepEqual(await store.remember({ action: "add", memory: "Ben likes pizza." }), {
    ok: true,
    action: "added",
    id: 3,
    memory: "Ben likes pizza.",
  });
  assert.deepEqual(await store.list(), [
    { id: 2, memory: "Makan likes concise answers." },
    { id: 3, memory: "Ben likes pizza." },
  ]);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    version: 1,
    memories: [null, null, "Makan likes concise answers.", "Ben likes pizza."],
  });
  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test("memory store rejects missing IDs and preserves malformed positions as tombstones", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "memories.json");
  const store = new MemoryStore(filePath, logger);
  await writeFile(filePath, JSON.stringify({ memories: [" kept ", 42, " ", null] }));

  assert.deepEqual(await store.list(), [{ id: 0, memory: "kept" }]);
  assert.deepEqual(await store.remember({ action: "update", id: 1, memory: "no" }), {
    ok: false,
    error: "memory 1 does not exist",
  });
  assert.deepEqual(await store.remember({ action: "delete", id: 10 }), {
    ok: false,
    error: "memory 10 does not exist",
  });
});

test("memory store recommends deletion when the active-memory limit is reached", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "memories.json");
  const store = new MemoryStore(filePath, logger);
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      memories: Array.from({ length: 25 }, (_, id) => `memory ${String(id)}`),
    }),
  );

  assert.deepEqual(await store.remember({ action: "add", memory: "one too many" }), {
    ok: false,
    error: "memory limit of 25 reached; delete an existing memory before adding another",
  });
});

test("long-term memory store reads and atomically replaces plain text", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "long-term-memory.txt");
  const store = new LongTermMemoryStore(filePath);

  assert.equal(await store.get(), undefined);
  await store.set("  Ben remembers the group fondly.  ");
  assert.equal(await store.get(), "Ben remembers the group fondly.");
  assert.equal(await readFile(filePath, "utf8"), "Ben remembers the group fondly.\n");
  await assert.rejects(() => store.set("  "), /must be non-empty/);
});

test("memory consolidation state persists the next due time", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "memory-consolidation.json");
  const store = new MemoryConsolidationStateStore(filePath, logger);
  const dueAt = new Date("2026-08-13T12:00:00.000Z");

  assert.equal(await store.getNextRunAt(), undefined);
  await store.setNextRunAt(dueAt);
  assert.equal((await store.getNextRunAt())?.toISOString(), dueAt.toISOString());
});

test("scheduled-message store reads the current shape and preserves lifecycle fields", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "scheduled-messages.json");
  await copyFile("src/testing/fixtures/scheduled-messages.json", filePath);
  const store = new ScheduledMessageStore(filePath, logger);

  const [fixture] = await store.listDue(new Date("2026-02-04T00:30:00.000Z"));
  assert.equal(fixture?.id, "sm_example1");
  assert.deepEqual(fixture?.targetUsers, [
    {
      userId: "100000000000000001",
      username: "sample_user",
    },
  ]);
  assert.equal(await store.markFailed("sm_example1", new Date("2026-02-04T00:31:00.000Z")), 1);
  await store.reschedule(
    "sm_example1",
    new Date("2026-02-11T00:30:00.000Z"),
    new Date("2026-02-04T00:32:00.000Z"),
  );
  await store.markSent(
    "sm_example1",
    new Date("2026-02-18T00:30:00.000Z"),
    new Date("2026-02-11T00:30:00.000Z"),
  );

  const stored = JSON.parse(await readFile(filePath, "utf8")) as {
    messages: Array<Record<string, unknown>>;
  };
  assert.deepEqual(stored.messages[0], {
    ...fixture,
    nextRunAt: "2026-02-18T00:30:00.000Z",
    updatedAt: "2026-02-11T00:30:00.000Z",
    lastRunAt: "2026-02-11T00:30:00.000Z",
    failureCount: 0,
  });
  assert.deepEqual(await readdir(directory), ["scheduled-messages.json"]);
});

test("scheduled-message store adds atomically and controls malformed data", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "scheduled.json");
  const store = new ScheduledMessageStore(filePath, logger);
  const created = await store.add(
    {
      channelId: "channel",
      channelName: "general",
      message: "hello later",
      targetUsers: [{ userId: "user", username: "makan" }],
      runDate: "2026-04-01",
      runTime: "09:00",
      repeat: "none",
      nextRunAt: new Date("2026-04-01T13:00:00.000Z"),
      createdByUserId: "creator",
      createdByUsername: "friend",
    },
    new Date("2026-03-01T00:00:00.000Z"),
  );
  assert.match(created.id, /^sm_[0-9a-f]{8}$/);
  assert.equal((await store.listDue(new Date("2026-04-01T13:00:00.000Z"))).length, 1);
  await store.markSent(created.id, undefined, new Date("2026-04-01T13:00:00.000Z"));
  assert.deepEqual(await store.listDue(new Date("2027-01-01T00:00:00.000Z")), []);

  await writeFile(filePath, JSON.stringify({ messages: [{ bad: true }, created] }));
  assert.equal((await store.listDue(new Date("2026-04-01T13:00:00.000Z"))).length, 1);
  await writeFile(filePath, "not json");
  await assert.rejects(() => store.listDue(), /must contain valid JSON/);
});

/** Creates one test-owned directory and removes it after the test. */
async function tempDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-migration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
