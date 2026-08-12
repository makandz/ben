import assert from "node:assert/strict";
import test from "node:test";

import { MemoryConsolidationScheduler } from "../MemoryConsolidationScheduler.js";

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
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

async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler behavior");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
