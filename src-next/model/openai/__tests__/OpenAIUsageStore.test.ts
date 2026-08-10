import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OpenAIUsageStore } from "../OpenAIUsageStore.js";

const fixturePath = path.resolve(
  "src-next/testing/fixtures/openai-usage-month.json",
);
const fixtureDate = new Date(2026, 0, 2, 12);

test("reads the current monthly usage shape and enforces a positive budget", async (context) => {
  const directory = await createTempDirectory(context);
  await writeFile(path.join(directory, "2601.json"), await readFile(fixturePath, "utf8"));
  const store = new OpenAIUsageStore(directory, "gpt-5.4-mini", 0.01);

  assert.deepEqual(await store.getBudgetStatus(fixtureDate), {
    limited: true,
    day: "260102",
    costUsd: 0.0123,
    budgetUsd: 0.01,
  });
  assert.deepEqual(await store.getTodaySummary(fixtureDate), {
    day: "260102",
    model: "gpt-5.4-mini",
    requests: 2,
    inputTokens: 1200,
    cachedInputTokens: 200,
    outputTokens: 300,
    totalTokens: 1500,
    costUsd: 0.0123,
    budgetUsd: 0.01,
    remainingBudgetUsd: 0,
  });
});

test("treats a zero budget as unlimited", async (context) => {
  const directory = await createTempDirectory(context);
  await writeFile(path.join(directory, "2601.json"), await readFile(fixturePath, "utf8"));
  const store = new OpenAIUsageStore(directory, "gpt-5.4-mini", 0);

  assert.equal((await store.getBudgetStatus(fixtureDate)).limited, false);
  assert.equal((await store.getTodaySummary(fixtureDate)).remainingBudgetUsd, undefined);
});

test("records all token categories and atomically updates compatible JSON", async (context) => {
  const directory = await createTempDirectory(context);
  const store = new OpenAIUsageStore(directory, "gpt-5.4-mini", 1);
  const usage = {
    inputTokens: 1_200,
    cachedInputTokens: 200,
    outputTokens: 300,
    totalTokens: 1_500,
  };

  const recorded = await store.record("gpt-5.4-mini", usage, fixtureDate);
  const persisted = JSON.parse(await readFile(path.join(directory, "2601.json"), "utf8"));

  assert.equal(recorded.costUsd, 0.002115);
  assert.equal(recorded.totalCostUsd, 0.002115);
  assert.deepEqual(persisted.days["260102"], {
    requests: 1,
    ...usage,
    costUsd: 0.002115,
  });
  await assert.rejects(readFile(path.join(directory, "2601.json.tmp"), "utf8"));
});

test("rejects malformed persisted usage rather than resetting costs", async (context) => {
  const directory = await createTempDirectory(context);
  await writeFile(path.join(directory, "2601.json"), "{\"month\":\"2601\",\"days\":{\"260102\":{}}}");
  const store = new OpenAIUsageStore(directory, "gpt-5.4-mini", 1);

  await assert.rejects(store.getTodaySummary(fixtureDate), /Invalid OpenAI usage entry/);
});

async function createTempDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-openai-usage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
