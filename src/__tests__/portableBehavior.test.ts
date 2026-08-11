import assert from "node:assert/strict";
import test from "node:test";

import { escapeBroadcastMentions } from "../discord/mentions.js";
import { calculateCostUsd, getModelPricing } from "../model/pricing.js";
import { buildUserPrompt, formatGroupedMessages } from "../prompts/formatMessages.js";
import { loadSystemPrompt } from "../prompts/systemPrompt.js";
import { isSingleUnicodeEmoji } from "../util/emoji.js";

const messageBase = {
  channelId: "channel",
  userId: "user",
  createdAt: 0,
};

test("escapes broadcast mentions without changing user mentions", () => {
  assert.equal(
    escapeBroadcastMentions("@everyone @here @makan"),
    "@\u200Beveryone @\u200Bhere @makan",
  );
});

test("validates one emoji grapheme", () => {
  assert.equal(isSingleUnicodeEmoji("👨‍👩‍👧‍👦"), true);
  assert.equal(isSingleUnicodeEmoji("🇨🇦"), true);
  assert.equal(isSingleUnicodeEmoji("🙂🙂"), false);
  assert.equal(isSingleUnicodeEmoji("a"), false);
  assert.equal(isSingleUnicodeEmoji(""), false);
});

test("resolves established model pricing and rejects unknown models", () => {
  assert.deepEqual(getModelPricing("gpt-5.6-luna"), {
    inputUsdPer1M: 0.2,
    cachedInputUsdPer1M: 0.02,
    outputUsdPer1M: 1.2,
  });
  assert.throws(() => getModelPricing("unknown"), /No OpenAI pricing configured/);
});

test("calculates cached and uncached token cost", () => {
  const cost = calculateCostUsd(
    {
      inputTokens: 1_000_000,
      cachedInputTokens: 250_000,
      outputTokens: 100_000,
    },
    {
      inputUsdPer1M: 2,
      cachedInputUsdPer1M: 1,
      outputUsdPer1M: 10,
    },
  );

  assert.equal(cost, 2.75);
});

test("does not produce negative uncached usage", () => {
  const cost = calculateCostUsd(
    { inputTokens: 10, cachedInputTokens: 20, outputTokens: 0 },
    { inputUsdPer1M: 2, cachedInputUsdPer1M: 1, outputUsdPer1M: 10 },
  );

  assert.equal(cost, 0.00002);
});

test("groups consecutive messages and omits empty content", () => {
  const result = formatGroupedMessages(
    [
      { ...messageBase, id: "1", username: "makan", content: " hi " },
      { ...messageBase, id: "2", username: "makan", content: "there" },
      { ...messageBase, id: "3", username: "sam", content: " " },
      { ...messageBase, id: "4", username: "sam", content: "hello" },
    ],
    { makan: { name: "Makan" } },
  );

  assert.equal(result, "makan (Makan): hi there\nsam: hello");
});

test("builds all optional prompt context in stable order", () => {
  const result = buildUserPrompt({
    recentContext: [{ ...messageBase, id: "1", username: "sam", content: "earlier" }],
    messages: [{ ...messageBase, id: "2", username: "makan", content: "hello" }],
    knownPeople: { makan: { name: "Makan" } },
    includeKnownPeople: true,
    currentBotTime: "Monday at noon",
    pingedByUsername: "makan",
    recentConversationSummaries: [{ summary: "They discussed lunch." }],
  });

  assert.equal(
    result,
    [
      "Known people:\n- makan is Makan",
      "Current bot time: Monday at noon. Scheduled message tool dates must be YYYY-MM-DD and times must be 24-hour HH:mm in the bot's local time.",
      "Ben was pinged by makan (Makan).",
      "Recent conversations:\n- They discussed lunch.",
      "Recent context:\nsam: earlier",
      "New messages:\nmakan (Makan): hello",
    ].join("\n\n"),
  );
});

test("loads the copied system prompt and falls back for a missing file", async () => {
  const loaded = await loadSystemPrompt();
  const fallback = await loadSystemPrompt(
    new URL("file:///definitely-missing-ben-system-prompt.txt"),
  );

  assert.match(loaded, /Ben/);
  assert.match(fallback, /Discord bot participating in a group chat/);
});
