import assert from "node:assert/strict";
import test from "node:test";

import { TaskScheduler, type TaskCompletion } from "../TaskScheduler.js";
import type { AutonomousTask, TaskCompletionResult } from "../../storage/TaskStore.js";

const quietLogger = { debug() {}, info() {}, warn() {} };

function task(id: string, nextRunAt = "2026-08-21T12:00:00.000Z"): AutonomousTask {
  return {
    id,
    name: `Task ${id}`,
    description: "A task",
    instructions: "Do the task.",
    destination: { kind: "named", channelId: "channel-a", channelName: "general" },
    runDate: "2026-08-21",
    runTime: "08:00",
    repeat: "none",
    nextRunAt,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

class SchedulerStore {
  tasks: AutonomousTask[];
  completions: string[] = [];

  constructor(tasks: AutonomousTask[]) {
    this.tasks = tasks;
  }

  async listDueOneTime(now: Date): Promise<AutonomousTask[]> {
    return this.tasks.filter((item) => new Date(item.nextRunAt) <= now);
  }

  async completeOneTime(id: string, _expectedUpdatedAt: string): Promise<TaskCompletionResult> {
    this.completions.push(id);
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((item) => item.id !== id);
    return { deleted: this.tasks.length !== before, revision: this.completions.length };
  }
}

test("queues due tasks once across repeated polls and deletes only on completion", async (t) => {
  const store = new SchedulerStore([task("one")]);
  const queued: Array<{ task: AutonomousTask; complete: TaskCompletion }> = [];
  const scheduler = new TaskScheduler(
    store,
    (item, complete) => queued.push({ task: item, complete }),
    quietLogger,
    { intervalMs: 5, now: () => new Date("2026-08-21T12:01:00.000Z") },
  );
  t.after(() => scheduler.stop());

  await scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.equal(queued.length, 1);
  assert.equal(store.tasks.length, 1);

  await queued[0]?.complete();
  assert.deepEqual(store.completions, ["one"]);
  assert.equal(store.tasks.length, 0);
});

test("persisted overdue tasks remain eligible for a scheduler after restart", async (t) => {
  const store = new SchedulerStore([task("restart")]);
  const firstQueued: TaskCompletion[] = [];
  const first = new TaskScheduler(
    store,
    (_item, complete) => firstQueued.push(complete),
    quietLogger,
    { intervalMs: 60_000, now: () => new Date("2026-08-21T12:01:00.000Z") },
  );
  await first.start();
  first.stop();
  assert.equal(store.tasks.length, 1);

  const secondQueued: TaskCompletion[] = [];
  const second = new TaskScheduler(
    store,
    (_item, complete) => secondQueued.push(complete),
    quietLogger,
    { intervalMs: 60_000, now: () => new Date("2026-08-21T12:02:00.000Z") },
  );
  t.after(() => second.stop());
  await second.start();

  assert.equal(firstQueued.length, 1);
  assert.equal(secondQueued.length, 1);
});

test("contains one enqueue failure and continues queueing later tasks", async (t) => {
  const store = new SchedulerStore([task("bad"), task("good")]);
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

test("releases a claim even when completion persistence fails", async (t) => {
  let listCalls = 0;
  let complete!: TaskCompletion;
  const store = {
    async listDueOneTime() {
      listCalls += 1;
      return [task("retry")];
    },
    async completeOneTime(): Promise<TaskCompletionResult> {
      throw new Error("disk unavailable");
    },
  };
  const scheduler = new TaskScheduler(
    store,
    (_item, callback) => (complete = callback),
    quietLogger,
    {
      intervalMs: 5,
    },
  );
  t.after(() => scheduler.stop());

  await scheduler.start();
  await complete();
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.ok(listCalls >= 2);
});
