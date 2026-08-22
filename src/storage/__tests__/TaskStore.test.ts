import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TaskDefinitionInput } from "../TaskStore.js";
import { TaskStore } from "../TaskStore.js";

test("task store creates, replaces, deletes, and advances its persisted revision", async (t) => {
  const { filePath, store } = await createStore(t);
  assert.deepEqual(await store.list(), { revision: 0, tasks: [] });

  const created = await store.create(0, definition("Review memories"), instant(0));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.match(created.task.id, /^task_[\da-f]{8}$/);
  assert.equal(created.revision, 1);
  assert.equal(created.task.createdAt, instant(0).toISOString());

  const replaced = await store.replace(
    created.task.id,
    1,
    definition("Weekly memory review", "weekly"),
    instant(1),
  );
  assert.equal(replaced.ok, true);
  if (!replaced.ok) return;
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.task.id, created.task.id);
  assert.equal(replaced.task.createdAt, created.task.createdAt);
  assert.equal(replaced.task.updatedAt, instant(1).toISOString());

  const deleted = await store.delete(created.task.id);
  assert.equal(deleted.ok, true);
  assert.deepEqual(await store.list(), { revision: 3, tasks: [] });
  const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.version, 1);
  assert.equal(persisted.revision, 3);
});

test("task store enforces view revisions and case-insensitive unique names", async (t) => {
  const { store } = await createStore(t);
  const first = await store.create(0, definition("Friday Plans"));
  assert.equal(first.ok, true);

  assert.deepEqual(await store.create(0, definition("Another")), {
    ok: false,
    error: "tasks changed since the last view; run view_tasks again",
    revision: 1,
  });
  assert.deepEqual(await store.create(1, definition(" friday plans ")), {
    ok: false,
    error: 'a task named "Friday Plans" already exists',
    revision: 1,
  });
  if (!first.ok) return;
  const second = await store.create(1, definition("Another"));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(await store.replace(second.task.id, 2, definition("FRIDAY PLANS")), {
    ok: false,
    error: 'a task named "Friday Plans" already exists',
    revision: 2,
  });
  assert.equal((await store.replace(first.task.id, 2, definition("Friday Plans"))).ok, true);
});

test("task store ignores malformed entries and rejects malformed JSON", async (t) => {
  const warnings: string[] = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-tasks-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const filePath = path.join(directory, "tasks.json");
  const valid = {
    id: "task_valid",
    version: 1,
    ...definition("Valid"),
    nextRunAt: "2026-08-22T16:00:00.000Z",
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
  };
  await writeFile(
    filePath,
    JSON.stringify({ version: 1, revision: 7, tasks: [valid, { id: "broken" }, null] }),
  );
  const store = new TaskStore(filePath, { warn: (event) => warnings.push(event) });
  const snapshot = await store.list();
  assert.equal(snapshot.revision, 7);
  assert.deepEqual(snapshot.tasks, [valid]);
  assert.deepEqual(warnings, ["tasks.invalid_entry_ignored", "tasks.invalid_entry_ignored"]);

  await writeFile(filePath, "not json");
  await assert.rejects(() => store.list(), /must contain valid JSON/);
});

test("task store lists all due tasks and completes occurrences idempotently", async (t) => {
  const { store } = await createStore(t);
  const oneTime = await store.create(0, definition("One time"), instant(0));
  const recurring = await store.create(1, definition("Recurring", "daily"), instant(1));
  assert.equal(oneTime.ok, true);
  assert.equal(recurring.ok, true);
  if (!oneTime.ok) return;

  const due = await store.listDue(new Date("2026-08-22T16:00:00.000Z"));
  assert.deepEqual(
    due.map(({ id }) => id),
    [oneTime.task.id, recurring.ok ? recurring.task.id : ""],
  );
  assert.deepEqual(
    await store.completeOccurrence(oneTime.task.id, oneTime.task.version, "none", undefined),
    {
      outcome: "deleted",
      revision: 3,
    },
  );
  assert.deepEqual(
    await store.completeOccurrence(oneTime.task.id, oneTime.task.version, "none", undefined),
    {
      outcome: "unchanged",
      revision: 3,
    },
  );
  assert.equal((await store.list()).tasks.length, 1);
});

test("task store advances recurring completion and invalidates viewed revisions", async (t) => {
  const { store } = await createStore(t);
  const created = await store.create(0, definition("Daily", "daily"), instant(0));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.deepEqual(
    await store.completeOccurrence(
      created.task.id,
      created.task.version,
      "daily",
      new Date("2026-08-23T16:00:00.000Z"),
      instant(1),
    ),
    {
      outcome: "advanced",
      revision: 2,
    },
  );
  const task = (await store.list()).tasks[0];
  assert.equal(task?.nextRunAt, "2026-08-23T16:00:00.000Z");
  assert.equal(task?.version, 2);
  assert.deepEqual(await store.create(1, definition("Stale")), {
    ok: false,
    error: "tasks changed since the last view; run view_tasks again",
    revision: 2,
  });
});

test("task completion does not delete a definition edited after it was claimed", async (t) => {
  const { store } = await createStore(t);
  const created = await store.create(0, definition("Original"), instant(0));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const editedDefinition = {
    ...definition("Rescheduled"),
    nextRunAt: new Date("2026-08-23T16:00:00.000Z"),
  };
  const edited = await store.replace(created.task.id, 1, editedDefinition, instant(1));
  assert.equal(edited.ok, true);

  assert.deepEqual(
    await store.completeOccurrence(created.task.id, created.task.version, "none", undefined),
    {
      outcome: "unchanged",
      revision: 2,
    },
  );
  assert.equal((await store.list()).tasks[0]?.name, "Rescheduled");
});

test("task completion preserves deleted and recurrence-type-changed definitions", async (t) => {
  const { store } = await createStore(t);
  const deleted = await store.create(0, definition("Deleted", "daily"), instant(0));
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal((await store.delete(deleted.task.id)).ok, true);
  assert.deepEqual(
    await store.completeOccurrence(
      deleted.task.id,
      deleted.task.version,
      "daily",
      new Date("2026-08-23T16:00:00.000Z"),
    ),
    { outcome: "unchanged", revision: 2 },
  );

  const changed = await store.create(2, definition("Changed", "none"), instant(1));
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.equal(
    (await store.replace(changed.task.id, 3, definition("Changed", "weekly"), instant(2))).ok,
    true,
  );
  assert.deepEqual(
    await store.completeOccurrence(changed.task.id, changed.task.version, "none", undefined),
    {
      outcome: "unchanged",
      revision: 4,
    },
  );
  assert.equal((await store.list()).tasks[0]?.repeat, "weekly");
});

test("pre-version recurring entries load and can advance without migration", async (t) => {
  const { filePath, store } = await createStore(t);
  const legacy = {
    id: "task_existing",
    ...definition("Existing", "weekly"),
    nextRunAt: "2026-08-22T16:00:00.000Z",
    createdAt: instant(0).toISOString(),
    updatedAt: instant(0).toISOString(),
  };
  await writeFile(filePath, JSON.stringify({ version: 1, revision: 4, tasks: [legacy] }));
  const loaded = (await store.list()).tasks[0];
  assert.equal(loaded?.version, 0);
  assert.deepEqual(
    await store.advanceRecurring(
      "task_existing",
      0,
      new Date("2026-08-29T16:00:00.000Z"),
      instant(1),
    ),
    { advanced: true, revision: 5 },
  );
  assert.equal((await store.list()).tasks[0]?.version, 1);
});

async function createStore(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-tasks-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const filePath = path.join(directory, "tasks.json");
  return { filePath, store: new TaskStore(filePath, { warn() {} }) };
}

function definition(
  name: string,
  repeat: TaskDefinitionInput["repeat"] = "none",
): TaskDefinitionInput {
  return {
    name,
    description: "A short description",
    instructions: "Detailed instructions Ben wrote for himself.",
    destination: { kind: "own", channelId: "logs", channelName: "ben-logs" },
    runDate: "2026-08-22",
    runTime: "12:00",
    repeat,
    nextRunAt: new Date("2026-08-22T16:00:00.000Z"),
  };
}

function instant(minutes: number): Date {
  return new Date(Date.UTC(2026, 7, 21, 12, minutes));
}
