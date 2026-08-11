import assert from "node:assert/strict";
import test from "node:test";

import { loadEnv } from "../env.js";

const requiredEnv = {
  DISCORD_TOKEN: "discord-token",
  OPENAI_API_KEY: "openai-key",
};

test("loadEnv loads the five-variable contract with defaults", () => {
  assert.deepEqual(loadEnv(requiredEnv), {
    discordToken: "discord-token",
    openaiApiKey: "openai-key",
    discordLogChannelId: undefined,
    openaiDailyBudgetUsd: 0,
    logLevel: "info",
  });
});

test("loadEnv validates and loads optional values", () => {
  assert.deepEqual(
    loadEnv({
      ...requiredEnv,
      DISCORD_LOG_CHANNEL_ID: " log-channel ",
      OPENAI_DAILY_BUDGET_USD: "12.5",
      LOG_LEVEL: "debug",
    }),
    {
      discordToken: "discord-token",
      openaiApiKey: "openai-key",
      discordLogChannelId: "log-channel",
      openaiDailyBudgetUsd: 12.5,
      logLevel: "debug",
    },
  );
});

test("loadEnv rejects missing required values", () => {
  assert.throws(() => loadEnv({ OPENAI_API_KEY: "openai-key" }), /Missing DISCORD_TOKEN/);
  assert.throws(() => loadEnv({ DISCORD_TOKEN: "discord-token" }), /Missing OPENAI_API_KEY/);
});

test("loadEnv rejects invalid optional values", () => {
  assert.throws(
    () => loadEnv({ ...requiredEnv, OPENAI_DAILY_BUDGET_USD: "-1" }),
    /must be a non-negative number/,
  );
  assert.throws(
    () => loadEnv({ ...requiredEnv, LOG_LEVEL: "verbose" }),
    /LOG_LEVEL must be one of/,
  );
});
