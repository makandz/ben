import assert from "node:assert/strict";
import test from "node:test";

import { TaskScheduler, type TaskCompletion } from "../TaskScheduler.js";
import type { AutonomousTask, TaskCompletionResult } from "../../storage/TaskStore.js";
import type { ScheduleRepeat } from "../scheduleTime.js";

const quietLogger = { debug() {}, info() {}, warn() {} };

function task(
  id: string,
  repeat: ScheduleRepeat = "none",
  nextRunAt = "2026-08-21T12:00:00.000Z",
): AutonomousTask {
  return {
    id,
    version: 1,
    name: `Task ${id}`,
    description: "A task",
    instructions: "Do the task.",
    destination: { kind: "named", channelId: "channel-a", channelName: "general" },
    runDate: nextRunAt.slice(0, 10),
    runTime: "08:00",
    repeat,
    nextRunAt,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

class SchedulerStore {
  tasks: AutonomousTask[];
  completions: string[] = [];
  advances: string[] = [];
  completionFailures = 0;
  revision = 0;

  constructor(tasks: AutonomousTask[]) {
    this.tasks = tasks;
  }

  async listDue(now: Date): Promise<AutonomousTask[]> {
    return this.tasks.filter((item) => new Date(item.nextRunAt) <= now);
  }

  async completeOccurrence(
    id: string,
    expectedVersion: number,
    expectedRepeat: ScheduleRepeat,
    nextRunAt: Date | undefined,
    now: Date,
  ): Promise<TaskCompletionResult> {
    this.completions.push(id);
    if (this.completionFailures > 0) {
      this.completionFailures -= 1;
      throw new Error("disk unavailable");
    }
    const index = this.tasks.findIndex((item) => item.id === id);
    const item = this.tasks[index];
    if (item?.version !== expectedVersion || item.repeat !== expectedRepeat) {
      return { outcome: "unchanged", revision: this.revision };
    }
    this.revision += 1;
    if (item.repeat === "none") {
      this.tasks.splice(index, 1);
      return { outcome: "deleted", revision: this.revision };
    }
    assert.ok(nextRunAt);
    item.nextRunAt = nextRunAt.toISOString();
    item.updatedAt = now.toISOString();
    item.version += 1;
    return { outcome: "advanced", revision: this.revision };
  }

  async advanceRecurring(
    id: string,
    expectedVersion: number,
    nextRunAt: Date,
    now: Date,
  ): Promise<{ advanced: boolean; revision: number }> {
    const item = this.tasks.find((candidate) => candidate.id === id);
    if (item === undefined || item.repeat === "none" || item.version !== expectedVersion) {
      return { advanced: false, revision: this.revision };
    }
    this.advances.push(id);
    this.revision += 1;
    item.nextRunAt = nextRunAt.toISOString();
    item.updatedAt = now.toISOString();
    item.version += 1;
    return { advanced: true, revision: this.revision };
  }
}

test("queues a due one-time task once and deletes it only on completion", async (t) => {
  const store = new SchedulerStore([task("one")]);
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = schedulerFor(store, queued, () => new Date("2026-08-21T12:01:00.000Z"), 5);
  t.after(() => scheduler.stop());

  await scheduler.start();
  await delay(18);
  assert.equal(queued.length, 1);
  assert.equal(store.tasks.length, 1);

  await queued[0]?.complete();
  assert.deepEqual(store.completions, ["one"]);
  assert.equal(store.tasks.length, 0);
});

test("advances daily and weekly tasks after completion without deleting them", async (t) => {
  const store = new SchedulerStore([
    task("daily", "daily", "2026-08-21T12:00:00.000Z"),
    task("weekly", "weekly", "2026-08-21T12:00:00.000Z"),
  ]);
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = schedulerFor(store, queued, () => new Date("2026-08-21T12:00:00.000Z"));
  t.after(() => scheduler.stop());
  await scheduler.start();

  assert.deepEqual(
    queued.map(({ task: item }) => item.id),
    ["daily", "weekly"],
  );
  await queued[0]?.complete();
  await queued[1]?.complete();
  assert.equal(store.tasks.length, 2);
  assert.equal(store.tasks.find(({ id }) => id === "daily")?.nextRunAt, "2026-08-22T12:00:00.000Z");
  assert.equal(
    store.tasks.find(({ id }) => id === "weekly")?.nextRunAt,
    "2026-08-28T12:00:00.000Z",
  );
});

test("late completion advances to the first future occurrence and preserves DST wall time", async (t) => {
  let now = new Date("2026-03-07T14:00:00.000Z");
  const store = new SchedulerStore([task("daily", "daily", now.toISOString())]);
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = schedulerFor(store, queued, () => now);
  t.after(() => scheduler.stop());
  await scheduler.start();

  now = new Date("2026-03-09T13:30:00.000Z");
  await queued[0]?.complete();
  assert.equal(store.tasks[0]?.nextRunAt, "2026-03-10T13:00:00.000Z");
});

test("skips overdue startup recurrences but still queues overdue one-time tasks", async (t) => {
  const store = new SchedulerStore([
    task("once", "none", "2026-08-19T12:00:00.000Z"),
    task("daily", "daily", "2026-08-19T12:00:00.000Z"),
    task("weekly", "weekly", "2026-08-14T12:00:00.000Z"),
  ]);
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = schedulerFor(store, queued, () => new Date("2026-08-21T12:01:00.000Z"));
  t.after(() => scheduler.stop());
  await scheduler.start();

  assert.deepEqual(
    queued.map(({ task: item }) => item.id),
    ["once"],
  );
  assert.deepEqual(store.advances, ["daily", "weekly"]);
  assert.equal(store.tasks.find(({ id }) => id === "daily")?.nextRunAt, "2026-08-22T12:00:00.000Z");
  assert.equal(
    store.tasks.find(({ id }) => id === "weekly")?.nextRunAt,
    "2026-08-28T12:00:00.000Z",
  );
});

test("a recurrence becoming due after startup queues normally and remains claimed", async (t) => {
  let now = new Date("2026-08-21T11:59:00.000Z");
  const store = new SchedulerStore([task("daily", "daily")]);
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = schedulerFor(store, queued, () => now, 5);
  t.after(() => scheduler.stop());
  await scheduler.start();
  assert.equal(queued.length, 0);

  now = new Date("2026-08-21T12:00:01.000Z");
  await delay(18);
  assert.equal(queued.length, 1);
  await delay(12);
  assert.equal(queued.length, 1);
});

test("retries failed completion persistence without duplicating conversational work", async (t) => {
  const store = new SchedulerStore([task("retry")]);
  store.completionFailures = 1;
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = schedulerFor(store, queued, () => new Date("2026-08-21T12:00:00.000Z"), 5);
  t.after(() => scheduler.stop());
  await scheduler.start();

  await queued[0]?.complete();
  assert.equal(store.tasks.length, 1);
  await delay(18);
  assert.equal(queued.length, 1);
  assert.equal(store.tasks.length, 0);
  assert.deepEqual(store.completions, ["retry", "retry"]);
});

test("stale completion preserves edits, deletion, and recurrence type changes", async (t) => {
  const cases: Array<{ replacement?: AutonomousTask; original: AutonomousTask }> = [
    {
      original: task("edited", "daily"),
      replacement: { ...task("edited", "daily", "2026-08-23T12:00:00.000Z"), version: 2 },
    },
    { original: task("deleted", "daily") },
    {
      original: task("to-once", "daily"),
      replacement: { ...task("to-once", "none", "2026-08-23T12:00:00.000Z"), version: 2 },
    },
    {
      original: task("to-recurring", "none"),
      replacement: { ...task("to-recurring", "weekly", "2026-08-28T12:00:00.000Z"), version: 2 },
    },
  ];

  for (const { original, replacement } of cases) {
    const store = new SchedulerStore([original]);
    const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
    const scheduler = schedulerFor(store, queued, () => new Date("2026-08-21T12:00:00.000Z"));
    t.after(() => scheduler.stop());
    await scheduler.start();
    store.tasks = replacement === undefined ? [] : [replacement];
    await queued[0]?.complete();
    assert.deepEqual(store.tasks, replacement === undefined ? [] : [replacement]);
  }
});

test("contains enqueue and missed-advance failures so later due tasks still run", async (t) => {
  const store = new SchedulerStore([
    task("missed", "daily", "2026-08-20T12:00:00.000Z"),
    task("bad"),
    task("good"),
  ]);
  store.advanceRecurring = async () => {
    throw new Error("disk unavailable");
  };
  const queued: string[] = [];
  const scheduler = new TaskScheduler(
    store,
    (item) => {
      if (item.id === "bad") throw new Error("queue unavailable");
      queued.push(item.id);
    },
    quietLogger,
    { intervalMs: 60_000, now: () => new Date("2026-08-21T12:01:00.000Z") },
  );
  t.after(() => scheduler.stop());
  await scheduler.start();
  assert.deepEqual(queued, ["good"]);
});

test("retries a failed startup advance without waking the missed recurrence", async (t) => {
  const store = new SchedulerStore([task("missed", "daily", "2026-08-20T12:00:00.000Z")]);
  const advance = store.advanceRecurring.bind(store);
  let attempts = 0;
  store.advanceRecurring = async (...argumentsValue) => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk unavailable");
    return advance(...argumentsValue);
  };
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = schedulerFor(store, queued, () => new Date("2026-08-21T12:01:00.000Z"), 5);
  t.after(() => scheduler.stop());
  await scheduler.start();
  await delay(18);

  assert.equal(attempts, 2);
  assert.equal(queued.length, 0);
  assert.equal(store.tasks[0]?.nextRunAt, "2026-08-22T12:00:00.000Z");
});

function schedulerFor(
  store: SchedulerStore,
  queued: Array<{ task: AutonomousTask; complete: TaskCompletion }>,
  now: () => Date,
  intervalMs = 60_000,
): TaskScheduler {
  return new TaskScheduler(
    store,
    (item, complete) => queued.push({ task: item, complete }),
    quietLogger,
    { intervalMs, now, timeZone: "America/Toronto" },
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
