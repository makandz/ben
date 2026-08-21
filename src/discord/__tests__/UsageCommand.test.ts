import assert from "node:assert/strict";
import test from "node:test";

import { formatUsageSummary, handleUsageCommand, registerUsageCommand } from "../usageCommand.js";

const summary = {
  day: "260810",
  model: "gpt-5.4-mini",
  requests: 2,
  inputTokens: 1234,
  cachedInputTokens: 200,
  outputTokens: 50,
  totalTokens: 1284,
  costUsd: 0.25,
  budgetUsd: 1,
  remainingBudgetUsd: 0.75,
};

test("formats limited and unlimited daily usage", () => {
  assert.equal(
    formatUsageSummary(summary),
    "1,034/200/50 (uncached/cached/output) - $0.2500 (25.0%) - gpt-5.4-mini",
  );
  assert.match(formatUsageSummary({ ...summary, budgetUsd: 0 }), /\(n\/a\)/);
});

test("registers and handles usage through normalized Discord boundaries", async () => {
  const events: string[] = [];
  const replies: unknown[] = [];
  await registerUsageCommand(
    {
      async registerCommand(command) {
        events.push(command.name);
        return "updated";
      },
    },
    { info: (event) => events.push(event) },
  );
  await handleUsageCommand(
    {
      async reply(content) {
        replies.push(content);
      },
    },
    {
      async getTodaySummary() {
        return summary;
      },
    },
    { warn() {} },
  );
  assert.deepEqual(events, ["usage", "discord.command_updated"]);
  assert.deepEqual(replies, [formatUsageSummary(summary)]);
});

test("returns an ephemeral controlled failure when usage cannot be read", async () => {
  const replies: unknown[] = [];
  await handleUsageCommand(
    {
      async reply(content) {
        replies.push(content);
      },
    },
    {
      async getTodaySummary(): Promise<never> {
        throw new Error("disk");
      },
    },
    { warn() {} },
  );
  assert.deepEqual(replies, [{ content: "Could not read usage right now.", ephemeral: true }]);
});
