import assert from "node:assert/strict";
import test from "node:test";

import { MemoryConsolidationScheduler } from "../MemoryConsolidationScheduler.js";

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
};

const quietReporter = {
  async started() {},
  async completed() {},
  async failed() {},
};

test("initializes a 24-hour due time without invoking consolidation", async (t) => {
  const scheduled: Date[] = [];
  const scheduler = new MemoryConsolidationScheduler(
    {
      async hasPendingMemory() {
        throw new Error("should not inspect memory yet");
      },
      async consolidate() {
        throw new Error("should not consolidate");
      },
    },
    {
      async getNextRunAt() {
        return undefined;
      },
      async setNextRunAt(nextRunAt) {
        scheduled.push(nextRunAt);
      },
    },
    { beginDreaming: () => true, finishDreaming() {} },
    quietReporter,
    quietLogger,
    { now: () => new Date("2026-08-12T12:00:00.000Z"), checkIntervalMs: 10_000 },
  );
  t.after(() => scheduler.stop());

  await scheduler.start();

  assert.deepEqual(
    scheduled.map((date) => date.toISOString()),
    ["2026-08-13T12:00:00.000Z"],
  );
});

test("skips an empty due buffer and advances the schedule without dreaming", async (t) => {
  let consolidated = 0;
  let dreaming = 0;
  const scheduled: Date[] = [];
  const scheduler = new MemoryConsolidationScheduler(
    {
      async hasPendingMemory() {
        return false;
      },
      async consolidate() {
        consolidated += 1;
        return "consolidated" as const;
      },
    },
    {
      async getNextRunAt() {
        return new Date("2026-08-12T11:00:00.000Z");
      },
      async setNextRunAt(nextRunAt) {
        scheduled.push(nextRunAt);
      },
    },
    {
      beginDreaming() {
        dreaming += 1;
        return true;
      },
      finishDreaming() {},
    },
    quietReporter,
    quietLogger,
    { now: () => new Date("2026-08-12T12:00:00.000Z"), checkIntervalMs: 10_000 },
  );
  t.after(() => scheduler.stop());

  await scheduler.start();

  assert.equal(consolidated, 0);
  assert.equal(dreaming, 0);
  assert.deepEqual(
    scheduled.map((date) => date.toISOString()),
    ["2026-08-13T12:00:00.000Z"],
  );
});

test("scheduled consolidation reports dream start and completion", async (t) => {
  const events: string[] = [];
  const scheduler = new MemoryConsolidationScheduler(
    {
      async hasPendingMemory() {
        return true;
      },
      async consolidate() {
        events.push("consolidate");
        return "consolidated" as const;
      },
    },
    {
      async getNextRunAt() {
        return new Date("2026-08-12T11:00:00.000Z");
      },
      async setNextRunAt() {},
    },
    {
      beginDreaming() {
        return true;
      },
      finishDreaming() {
        events.push("finish");
      },
    },
    {
      async started() {
        events.push("started");
      },
      async completed() {
        events.push("completed");
      },
      async failed() {
        events.push("failed");
      },
    },
    quietLogger,
    { now: () => new Date("2026-08-12T12:00:00.000Z"), checkIntervalMs: 10_000 },
  );
  t.after(() => scheduler.stop());

  await scheduler.start();

  assert.deepEqual(events, ["started", "consolidate", "finish", "completed"]);
});

test("defers while active and completes once dreaming can be acquired", async (t) => {
  let canDream = false;
  let consolidated = 0;
  let finished = 0;
  let nextRunAt = new Date("2026-08-12T11:00:00.000Z");
  const scheduler = new MemoryConsolidationScheduler(
    {
      async hasPendingMemory() {
        return true;
      },
      async consolidate() {
        consolidated += 1;
        return "consolidated" as const;
      },
    },
    {
      async getNextRunAt() {
        return nextRunAt;
      },
      async setNextRunAt(value) {
        nextRunAt = value;
      },
    },
    {
      beginDreaming() {
        return canDream;
      },
      finishDreaming() {
        finished += 1;
      },
    },
    quietReporter,
    quietLogger,
    {
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      checkIntervalMs: 5,
      consolidationIntervalMs: 100,
    },
  );
  t.after(() => scheduler.stop());

  await scheduler.start();
  assert.equal(consolidated, 0);
  canDream = true;
  await until(() => consolidated === 1);

  assert.equal(finished, 1);
  assert.equal(nextRunAt.toISOString(), "2026-08-12T12:00:00.100Z");
});

test("manual consolidation reports dreaming and resets the due time", async (t) => {
  const events: string[] = [];
  let nextRunAt = new Date("2026-08-20T12:00:00.000Z");
  const scheduler = new MemoryConsolidationScheduler(
    {
      async hasPendingMemory() {
        return true;
      },
      async consolidate() {
        events.push("consolidate");
        return "consolidated" as const;
      },
    },
    {
      async getNextRunAt() {
        return nextRunAt;
      },
      async setNextRunAt(value) {
        nextRunAt = value;
      },
    },
    {
      beginDreaming() {
        events.push("begin");
        return true;
      },
      finishDreaming() {
        events.push("finish");
      },
    },
    quietReporter,
    quietLogger,
    { now: () => new Date("2026-08-12T12:00:00.000Z"), checkIntervalMs: 10_000 },
  );
  t.after(() => scheduler.stop());

  await scheduler.start();
  const outcome = await scheduler.consolidateNow({
    async started() {
      events.push("started");
    },
    async completed() {
      events.push("completed");
    },
    async failed() {
      events.push("failed");
    },
  });

  assert.equal(outcome, "consolidated");
  assert.deepEqual(events, ["begin", "started", "consolidate", "finish", "completed"]);
  assert.equal(nextRunAt.toISOString(), "2026-08-13T12:00:00.000Z");
});

test("manual consolidation returns empty or active without lifecycle messages", async (t) => {
  let pending = false;
  let canDream = false;
  const events: string[] = [];
  const scheduler = new MemoryConsolidationScheduler(
    {
      async hasPendingMemory() {
        return pending;
      },
      async consolidate() {
        throw new Error("should not consolidate");
      },
    },
    {
      async getNextRunAt() {
        return new Date("2026-08-20T12:00:00.000Z");
      },
      async setNextRunAt() {},
    },
    { beginDreaming: () => canDream, finishDreaming() {} },
    quietReporter,
    quietLogger,
    { checkIntervalMs: 10_000 },
  );
  t.after(() => scheduler.stop());
  const reporter = {
    async started() {
      events.push("started");
    },
    async completed() {
      events.push("completed");
    },
    async failed() {
      events.push("failed");
    },
  };

  assert.equal(await scheduler.consolidateNow(reporter), "empty");
  pending = true;
  assert.equal(await scheduler.consolidateNow(reporter), "active");
  canDream = true;
  assert.deepEqual(events, []);
});

async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler behavior");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
