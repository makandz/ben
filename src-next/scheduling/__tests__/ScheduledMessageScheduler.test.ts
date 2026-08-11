import assert from "node:assert/strict";
import test from "node:test";

import { ScheduledMessageScheduler } from "../ScheduledMessageScheduler.js";
import type { ScheduledMessage } from "../../storage/ScheduledMessageStore.js";

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
};

test("startup delivers overdue one-time schedules and completes them", async (t) => {
  const message = scheduledMessage({ repeat: "none", nextRunAt: "2026-03-01T14:00:00.000Z" });
  const store = new MemoryScheduleStore([message]);
  const delivered: ScheduledMessage[] = [];
  const logs: string[] = [];
  const scheduler = createScheduler(store, async (value) => { delivered.push(value); }, logs);
  t.after(() => scheduler.stop());

  await scheduler.start();

  assert.deepEqual(delivered.map(({ id }) => id), [message.id]);
  assert.equal(store.messages[0]?.enabled, false);
  assert.equal(store.messages[0]?.lastRunAt, "2026-03-10T16:00:00.000Z");
  assert.match(logs[0] ?? "", /schedule complete/);
});

test("startup skips missed recurring occurrences and finds the first future wall-clock run", async (t) => {
  const message = scheduledMessage({ repeat: "daily", nextRunAt: "2026-03-06T14:00:00.000Z" });
  const store = new MemoryScheduleStore([message]);
  const delivered: ScheduledMessage[] = [];
  const logs: string[] = [];
  const scheduler = createScheduler(store, async (value) => { delivered.push(value); }, logs);
  t.after(() => scheduler.stop());

  await scheduler.start();

  assert.deepEqual(delivered, []);
  assert.equal(store.messages[0]?.nextRunAt, "2026-03-11T13:00:00.000Z");
  assert.equal(store.messages[0]?.lastRunAt, undefined);
  assert.match(logs[0] ?? "", /Skipped missed scheduled message/);
});

test("a due recurring occurrence advances after delivery", async (t) => {
  const message = scheduledMessage({ repeat: "weekly", nextRunAt: "2026-03-10T16:00:00.000Z" });
  const store = new MemoryScheduleStore([message]);
  const scheduler = createScheduler(store, async () => undefined, []);
  t.after(() => scheduler.stop());

  await scheduler.start();

  assert.equal(store.messages[0]?.nextRunAt, "2026-03-17T16:00:00.000Z");
  assert.equal(store.messages[0]?.failureCount, 0);
});

test("delivery failures retain due schedules and increment failure accounting", async (t) => {
  const message = scheduledMessage({
    repeat: "none",
    nextRunAt: "2026-03-10T16:00:00.000Z",
    failureCount: 2,
  });
  const store = new MemoryScheduleStore([message]);
  const logs: string[] = [];
  const scheduler = createScheduler(store, async () => { throw new Error("Discord unavailable"); }, logs);
  t.after(() => scheduler.stop());

  await scheduler.start();

  assert.equal(store.messages[0]?.enabled, true);
  assert.equal(store.messages[0]?.failureCount, 3);
  assert.equal(store.messages[0]?.nextRunAt, "2026-03-10T16:00:00.000Z");
  assert.match(logs[0] ?? "", /Discord unavailable/);
});

function createScheduler(
  store: MemoryScheduleStore,
  deliver: (message: ScheduledMessage) => Promise<void>,
  logs: string[],
): ScheduledMessageScheduler {
  return new ScheduledMessageScheduler(
    store,
    deliver,
    async (text) => { logs.push(text); },
    quietLogger,
    {
      intervalMs: 60_000,
      timeZone: "America/Toronto",
      now: () => new Date("2026-03-10T16:00:00.000Z"),
    },
  );
}

function scheduledMessage(
  overrides: Partial<ScheduledMessage> = {},
): ScheduledMessage {
  return {
    id: "sm_test",
    channelId: "general",
    channelName: "general",
    message: "remember this",
    targetUsers: [{ userId: "user", username: "makan" }],
    runDate: "2026-03-10",
    runTime: "12:00",
    repeat: "none",
    nextRunAt: "2026-03-10T16:00:00.000Z",
    enabled: true,
    createdByUserId: "creator",
    createdByUsername: "friend",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

class MemoryScheduleStore {
  readonly messages: ScheduledMessage[];

  constructor(messages: readonly ScheduledMessage[]) {
    this.messages = [...structuredClone(messages)];
  }

  async listDue(now: Date): Promise<ScheduledMessage[]> {
    return this.messages
      .filter((message) => message.enabled && Date.parse(message.nextRunAt) <= now.getTime())
      .map((message) => structuredClone(message));
  }

  async markSent(id: string, nextRunAt: Date | undefined, now: Date): Promise<void> {
    const message = this.messages.find((item) => item.id === id);
    if (message === undefined) return;
    message.lastRunAt = now.toISOString();
    message.updatedAt = now.toISOString();
    message.failureCount = 0;
    if (nextRunAt === undefined) message.enabled = false;
    else message.nextRunAt = nextRunAt.toISOString();
  }

  async reschedule(id: string, nextRunAt: Date, now: Date): Promise<void> {
    const message = this.messages.find((item) => item.id === id);
    if (message === undefined) return;
    message.nextRunAt = nextRunAt.toISOString();
    message.updatedAt = now.toISOString();
  }

  async markFailed(id: string, now: Date): Promise<number> {
    const message = this.messages.find((item) => item.id === id);
    if (message === undefined) return 0;
    message.failureCount = (message.failureCount ?? 0) + 1;
    message.updatedAt = now.toISOString();
    return message.failureCount;
  }
}
