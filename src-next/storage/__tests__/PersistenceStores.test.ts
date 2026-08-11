import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationSummaryStore } from "../ConversationSummaryStore.js";
import { KnownPeopleStore } from "../KnownPeopleStore.js";

const warnings: string[] = [];
const logger = { warn(event: string) { warnings.push(event); } };

test("summary store reads the current shape, bounds entries, and writes atomically", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "conversation-summaries.json");
  await copyFile("src-next/testing/fixtures/conversation-summaries.json", filePath);
  const store = new ConversationSummaryStore(filePath, logger);

  assert.deepEqual(await store.list(), [{
    sleptAt: "2026-01-02T03:04:05.000Z",
    summary: "Ben and the group discussed a fictional weekend plan.",
  }]);
  for (let index = 1; index <= 5; index += 1) {
    await store.add(` summary ${String(index)} `, new Date(`2026-02-0${String(index)}T00:00:00Z`));
  }

  const stored = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    conversations: Array<{ summary: string }>;
  };
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.conversations.map(({ summary }) => summary), [
    "summary 1", "summary 2", "summary 3", "summary 4", "summary 5",
  ]);
  assert.deepEqual(await readdir(directory), ["conversation-summaries.json"]);
});

test("summary store ignores malformed entries and contains malformed files", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "summaries.json");
  const store = new ConversationSummaryStore(filePath, logger);
  await writeFile(filePath, JSON.stringify({ conversations: [
    { sleptAt: "valid", summary: " kept " },
    { sleptAt: 1, summary: "bad" },
    { sleptAt: "empty", summary: " " },
  ] }));
  assert.deepEqual(await store.list(), [{ sleptAt: "valid", summary: "kept" }]);
  await writeFile(filePath, "not json");
  assert.deepEqual(await store.list(), []);
});

test("known-people store reads the current shape and rejects ID and username duplicates", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "known-people.json");
  await copyFile("src-next/testing/fixtures/known-people.json", filePath);
  const store = new KnownPeopleStore(filePath, logger);

  assert.deepEqual(await store.listForPrompt(), { sample_user: { name: "Sample" } });
  assert.deepEqual(await store.remember({
    userId: "100000000000000002",
    username: "New_User",
    name: " New Person ",
  }), { ok: true, username: "New_User", name: "New Person" });
  assert.deepEqual(await store.remember({
    userId: "100000000000000002",
    username: "other",
    name: "Other",
  }), { ok: false, error: "New_User is already remembered as \"New Person\"" });
  assert.deepEqual(await store.remember({
    userId: "100000000000000003",
    username: "new_user",
    name: "Duplicate",
  }), { ok: false, error: "New_User is already remembered as \"New Person\"" });
  assert.deepEqual(await readdir(directory), ["known-people.json"]);
});

test("known-people store ignores malformed entries and rejects malformed containers", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "known.json");
  const store = new KnownPeopleStore(filePath, logger);
  await writeFile(filePath, JSON.stringify({ people: {
    good: { username: " Good ", name: " Person " },
    bad: { username: "", name: "Nobody" },
    scalar: 2,
  } }));
  assert.deepEqual(await store.listForPrompt(), { good: { name: "Person" } });
  await writeFile(filePath, JSON.stringify({ people: [] }));
  await assert.rejects(() => store.listForPrompt(), /people must be a JSON object/);
});

/** Creates one test-owned directory and removes it after the test. */
async function tempDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-phase-6-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
