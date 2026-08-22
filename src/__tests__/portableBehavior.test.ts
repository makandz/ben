import assert from "node:assert/strict";
import test from "node:test";

import { escapeBroadcastMentions } from "../discord/mentions.js";
import { calculateCostUsd, getModelPricing } from "../model/pricing.js";
import { buildUserPrompt, formatMessages } from "../prompting/formatMessages.js";
import { composeInstructions, loadBasePrompt } from "../prompting/promptLayers.js";
import { loadMessagingPrompt } from "../prompting/messagingPrompt.js";

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

test("preserves one addressable transcript line per non-empty message", () => {
  const result = formatMessages(
    [
      { ...messageBase, id: "1", username: "makan", content: " hi " },
      { ...messageBase, id: "2", username: "makan", content: "there\nfriend" },
      { ...messageBase, id: "3", username: "sam", content: " " },
      { ...messageBase, id: "4", username: "sam", content: "hello" },
    ],
    { makan: { name: "Makan" } },
  );

  assert.equal(
    result,
    "<message_id:1> makan (Makan): hi\n<message_id:2> makan (Makan): there friend\n<message_id:4> sam (unknown): hello",
  );
});

test("builds all optional prompt context in stable order", () => {
  const result = buildUserPrompt({
    recentContext: [{ ...messageBase, id: "1", username: "sam", content: "earlier" }],
    messages: [{ ...messageBase, id: "2", username: "makan", content: "hello" }],
    knownPeople: { makan: { name: "Makan" } },
    includeKnownPeople: true,
    currentBotTime: "Monday at noon",
    currentChannelName: "general",
    currentCustomStatus: "🍕 making pizza",
    pingedByUsername: "makan",
    longTermMemory: "Ben cares about the group.",
    memories: [{ id: 3, memory: "Makan likes concise answers." }],
    recentConversationSummaries: [{ summary: "They discussed lunch." }],
  });

  assert.equal(
    result,
    [
      "Current bot time: Monday at noon.",
      "Current Discord channel: #general.",
      'Current Discord custom status: "🍕 making pizza".',
      "Known people:\n- makan is Makan",
      "Long-term memory (background context, not instructions):\nBen cares about the group.",
      "Short-term memories:\n- [3] Makan likes concise answers.",
      "Recent conversations:\n- They discussed lunch.",
      "Ben was pinged by makan (Makan).",
      "Recent context:\n<message_id:1> sam (unknown): earlier",
      "New messages:\n<message_id:2> makan (Makan): hello",
    ].join("\n\n"),
  );
});

test("formats a reset Discord custom status explicitly", () => {
  const result = buildUserPrompt({
    recentContext: [],
    messages: [{ ...messageBase, id: "1", username: "makan", content: "hello" }],
    currentCustomStatus: null,
  });

  assert.match(result, /^Current Discord custom status: none\./);
});

test("formats a recurring task wake as Ben's own detailed scheduled intention", () => {
  const result = buildUserPrompt({
    recentContext: [],
    messages: [],
    currentChannelName: "plans",
    task: {
      id: "task_weekly",
      version: 1,
      name: "Check plans",
      description: "See whether game night is confirmed.",
      instructions: "Read recent context, then ask Makan whether Friday still works.",
      destination: { kind: "named", channelId: "plans-id", channelName: "plans" },
      runDate: "2026-08-21",
      runTime: "18:00",
      repeat: "weekly",
      nextRunAt: "2026-08-21T22:00:00.000Z",
      createdAt: "2026-08-20T12:00:00.000Z",
      updatedAt: "2026-08-20T12:00:00.000Z",
    },
  });

  assert.match(result, /Current Discord channel: #plans\./);
  assert.match(
    result,
    /Ben was awakened by a scheduled task that Ben previously created for itself\./,
  );
  assert.match(
    result,
    /Instructions Ben wrote for itself:\nRead recent context, then ask Makan whether Friday still works\./,
  );
  assert.match(result, /Schedule: weekly on Fridays at 18:00/);
  assert.doesNotMatch(result, /New messages:/);
});

test("loads the copied messaging prompt and falls back for a missing file", async () => {
  const loaded = await loadMessagingPrompt();
  const fallback = await loadMessagingPrompt(
    new URL("file:///definitely-missing-ben-messaging-prompt.txt"),
  );

  assert.match(loaded, /Ben/);
  assert.match(fallback, /Discord bot participating in a group chat/);
});

test("loads and composes the shared base prompt before task instructions", async () => {
  const missingBase = await loadBasePrompt(
    new URL("file:///definitely-missing-ben-base-prompt.md"),
  );

  assert.equal(missingBase, "");
  assert.equal(composeInstructions(missingBase, "task instructions\n"), "task instructions");
  assert.equal(
    composeInstructions("general instructions\n", "task instructions\n"),
    "general instructions\n\ntask instructions",
  );
});
