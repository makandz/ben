import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationSummaryStore } from "../ConversationSummaryStore.js";
import { KnownPeopleStore } from "../KnownPeopleStore.js";
import { ScheduledMessageStore } from "../ScheduledMessageStore.js";

const warnings: string[] = [];
const logger = {
  warn(event: string) {
    warnings.push(event);
  },
};

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
    Array.from({ length: 5 }, (_, index) =>
      store.add(
        ` summary ${String(index + 1)} `,
        new Date(`2026-02-0${String(index + 1)}T00:00:00Z`),
      ),
    ),
  );

  const stored = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    conversations: Array<{ summary: string }>;
  };
  assert.equal(stored.version, 1);
  assert.deepEqual(
    stored.conversations.map(({ summary }) => summary),
    ["summary 1", "summary 2", "summary 3", "summary 4", "summary 5"],
  );
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
