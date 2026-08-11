import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ActivityPresence } from "../../app/PresenceTransport.js";
import { ModelBudgetExceededError } from "../../model/Model.js";
import { ScriptedModel } from "../../testing/ScriptedModel.js";
import { InternalActionRunner } from "../InternalActionRunner.js";
import { InternalActionScheduler } from "../InternalActionScheduler.js";
import { InternalStateStore } from "../InternalStateStore.js";

const quietLogger = { debug() {}, info() {}, warn() {} };
const status = { emoji: "🌙", text: "pondering the moon" };

test("runs status generation through the shared model boundary", async () => {
  const model = new ScriptedModel([{
    items: [{ type: "message", role: "assistant", text: JSON.stringify(status) }],
    reasoningSummary: "**A quiet status fits.**",
  }]);
  const runner = new InternalActionRunner(model, quietLogger, false);
  const result = await runner.runStatusAction();
  assert.deepEqual(result, { type: "status", status, reasoningSummary: "**A quiet status fits.**" });
  assert.deepEqual(model.requests[0]?.tools, []);
});

test("converts shared model budget errors into a controlled internal result", async () => {
  const model = {
    async invoke(): Promise<never> { throw new ModelBudgetExceededError("260810", 1, 1); },
  };
  const result = await new InternalActionRunner(model, quietLogger, false).runStatusAction();
  assert.deepEqual(result, {
    type: "budget_exceeded", day: "260810", costUsd: 1, budgetUsd: 1,
  });
});

test("round-trips compatible internal state and reuses a fresh saved status", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-internal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  const store = new InternalStateStore(filePath, quietLogger);
  const now = new Date("2026-08-10T12:00:00.000Z");
  await store.writeCurrentStatus(status, now);
  assert.deepEqual(await store.readCurrentStatus(), { action: "status", status, setAt: now.toISOString() });
  assert.match(await readFile(filePath, "utf8"), /"action": "status"/);

  let runs = 0;
  const presences: ActivityPresence[] = [];
  const scheduler = new InternalActionScheduler(
    { async runStatusAction() { runs += 1; return { type: "status", status }; } },
    store,
    { setPresence: (presence) => presences.push(presence) },
    { async logStatus() {} },
    quietLogger,
    { intervalMs: 1_000, now: () => new Date(now.getTime() + 100) },
  );
  await scheduler.start();
  scheduler.stop();
  assert.equal(runs, 0);
  assert.deepEqual(presences, [{ status: "idle", activity: "🌙 pondering the moon" }]);
});

test("refreshes stale state once, persists presence, and contains logging failures", async () => {
  let runs = 0;
  const writes: unknown[] = [];
  const presences: ActivityPresence[] = [];
  const scheduler = new InternalActionScheduler(
    {
      async runStatusAction() {
        runs += 1;
        return { type: "status", status, reasoningSummary: "**quietly choosing**" } as const;
      },
    },
    {
      async readCurrentStatus() { return undefined; },
      async writeCurrentStatus(value) { writes.push(value); return { action: "status", status: value, setAt: "now" }; },
    },
    { setPresence: (presence) => presences.push(presence) },
    { async logStatus() { throw new Error("log unavailable"); } },
    quietLogger,
    { intervalMs: 60_000 },
  );
  await Promise.all([scheduler.start(), scheduler.start()]);
  scheduler.setAwakePresence(true);
  scheduler.stop();
  assert.equal(runs, 1);
  assert.deepEqual(writes, [status]);
  assert.deepEqual(presences.at(-1), { status: "online", activity: "🌙 pondering the moon" });
});

test("contains action failures without changing presence or state", async () => {
  let writes = 0;
  const presences: ActivityPresence[] = [];
  const scheduler = new InternalActionScheduler(
    { async runStatusAction() { return { type: "failed", error: new Error("provider") } as const; } },
    {
      async readCurrentStatus() { return undefined; },
      async writeCurrentStatus() { writes += 1; throw new Error("unexpected"); },
    },
    { setPresence: (presence) => presences.push(presence) },
    { async logStatus() {} },
    quietLogger,
    { intervalMs: 60_000 },
  );
  await scheduler.start();
  scheduler.stop();
  assert.equal(writes, 0);
  assert.deepEqual(presences, []);
});
