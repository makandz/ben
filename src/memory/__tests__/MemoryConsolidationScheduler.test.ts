import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryConsolidationScheduler,
  type ConsolidationReporter,
} from "../MemoryConsolidationScheduler.js";

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
};

const quietReporter: ConsolidationReporter = {
  async started() {},
  async completed() {},
  async failed() {},
};

const consolidationResult = {
  conversationSummaries: 2,
  shortTermMemories: 1,
};

test("initializes a 24-hour due time without invoking consolidation", async (t) => {
  const harness = createHarness({ nextRunAt: null, pendingInspectionFails: true });
  t.after(() => harness.scheduler.stop());

  await harness.scheduler.start();

  assert.equal(harness.nextRunAt?.toISOString(), "2026-08-13T12:00:00.000Z");
  assert.equal(harness.consolidated, 0);
});

test("skips an empty due buffer and advances the schedule without dreaming", async (t) => {
  const harness = createHarness({ pending: false });
  t.after(() => harness.scheduler.stop());

  await harness.scheduler.start();

  assert.equal(harness.consolidated, 0);
  assert.equal(harness.dreamAttempts, 0);
  assert.equal(harness.nextRunAt?.toISOString(), "2026-08-13T12:00:00.000Z");
});

test("scheduled consolidation reports dream start and completion", async (t) => {
  const events: string[] = [];
  const harness = createHarness({
    onConsolidate: () => events.push("consolidate"),
    onFinishDreaming: () => events.push("finish"),
    reporter: {
      async started() {
        events.push("started");
      },
      async completed(result) {
        events.push(
          `completed:${String(result.conversationSummaries)}:${String(result.shortTermMemories)}`,
        );
      },
      async failed() {
        events.push("failed");
      },
    },
  });
  t.after(() => harness.scheduler.stop());

  await harness.scheduler.start();

  assert.deepEqual(events, ["started", "consolidate", "finish", "completed:2:1"]);
});

test("defers while active and completes once dreaming can be acquired", async (t) => {
  const harness = createHarness({
    canDream: false,
    checkIntervalMs: 5,
    consolidationIntervalMs: 100,
  });
  t.after(() => harness.scheduler.stop());

  await harness.scheduler.start();
  assert.equal(harness.consolidated, 0);
  harness.canDream = true;
  await until(() => harness.consolidated === 1);

  assert.equal(harness.finished, 1);
  assert.equal(harness.nextRunAt?.toISOString(), "2026-08-12T12:00:00.100Z");
});

test("manual consolidation reports dreaming and resets the due time", async (t) => {
  const events: string[] = [];
  const harness = createHarness({
    nextRunAt: new Date("2026-08-20T12:00:00.000Z"),
    onBeginDreaming: () => events.push("begin"),
    onConsolidate: () => events.push("consolidate"),
    onFinishDreaming: () => events.push("finish"),
  });
  t.after(() => harness.scheduler.stop());
  await harness.scheduler.start();

  const outcome = await harness.scheduler.consolidateNow(eventReporter(events));

  assert.equal(outcome, "consolidated");
  assert.deepEqual(events, ["begin", "started", "consolidate", "finish", "completed"]);
  assert.equal(harness.nextRunAt?.toISOString(), "2026-08-13T12:00:00.000Z");
});

test("manual consolidation returns empty or active without lifecycle messages", async (t) => {
  const events: string[] = [];
  const harness = createHarness({
    pending: false,
    canDream: false,
    nextRunAt: new Date("2026-08-20T12:00:00.000Z"),
  });
  t.after(() => harness.scheduler.stop());

  assert.equal(await harness.scheduler.consolidateNow(eventReporter(events)), "empty");
  harness.pending = true;
  assert.equal(await harness.scheduler.consolidateNow(eventReporter(events)), "active");
  assert.deepEqual(events, []);
});

type HarnessOptions = {
  pending?: boolean;
  canDream?: boolean;
  nextRunAt?: Date | null;
  checkIntervalMs?: number;
  consolidationIntervalMs?: number;
  pendingInspectionFails?: boolean;
  reporter?: ConsolidationReporter;
  onBeginDreaming?: () => void;
  onConsolidate?: () => void;
  onFinishDreaming?: () => void;
};

function createHarness(options: HarnessOptions = {}) {
  const harness = {
    pending: options.pending ?? true,
    canDream: options.canDream ?? true,
    nextRunAt:
      options.nextRunAt === null
        ? undefined
        : (options.nextRunAt ?? new Date("2026-08-12T11:00:00.000Z")),
    consolidated: 0,
    dreamAttempts: 0,
    finished: 0,
    scheduler: undefined as unknown as MemoryConsolidationScheduler,
  };

  harness.scheduler = new MemoryConsolidationScheduler(
    {
      async hasPendingMemory() {
        if (options.pendingInspectionFails) throw new Error("should not inspect memory yet");
        return harness.pending;
      },
      async consolidate() {
        harness.consolidated += 1;
        options.onConsolidate?.();
        return consolidationResult;
      },
    },
    {
      async getNextRunAt() {
        return harness.nextRunAt;
      },
      async setNextRunAt(nextRunAt) {
        harness.nextRunAt = nextRunAt;
      },
    },
    {
      beginDreaming() {
        harness.dreamAttempts += 1;
        options.onBeginDreaming?.();
        return harness.canDream;
      },
      finishDreaming() {
        harness.finished += 1;
        options.onFinishDreaming?.();
      },
    },
    options.reporter ?? quietReporter,
    quietLogger,
    {
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      checkIntervalMs: options.checkIntervalMs ?? 10_000,
      ...(options.consolidationIntervalMs === undefined
        ? {}
        : { consolidationIntervalMs: options.consolidationIntervalMs }),
    },
  );

  return harness;
}

function eventReporter(events: string[]): ConsolidationReporter {
  return {
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
}

async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler behavior");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
