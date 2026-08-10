import assert from "node:assert/strict";
import test from "node:test";

import { replyTool, sleepTool, waitTool } from "../conversationControls.js";

function createToolCall(argumentsValue: unknown) {
  return {
    type: "tool_call" as const,
    callId: "1",
    name: "test",
    arguments: argumentsValue,
  };
}

test("reply supports text with an optional reaction", async () => {
  const result = await replyTool.execute(
    createToolCall({ text: " hi ", reaction: "🙂" }),
  );

  assert.deepEqual(result, {
    type: "finish",
    result: { ok: true, pausedUntil: "new_human_message" },
    outcome: { type: "reply", text: "hi", reaction: "🙂" },
  });
});

test("reply supports a reaction without text", async () => {
  const result = await replyTool.execute(
    createToolCall({ text: null, reaction: "👍" }),
  );

  assert.equal(result.type, "finish");

  if (result.type === "finish") {
    assert.deepEqual(result.outcome, { type: "react", reaction: "👍" });
  }
});

test("reply rejects malformed, empty, and invalid reaction arguments", async () => {
  const malformed = await replyTool.execute(createToolCall("not an object"));
  const empty = await replyTool.execute(
    createToolCall({ text: null, reaction: null }),
  );
  const invalidReaction = await replyTool.execute(
    createToolCall({ text: null, reaction: "no" }),
  );

  assert.equal(malformed.type, "continue");
  assert.equal(empty.type, "continue");
  assert.equal(invalidReaction.type, "continue");
});

test("wait finishes without producing a message", async () => {
  const result = await waitTool.execute(createToolCall({}));

  assert.deepEqual(result, {
    type: "finish",
    result: { ok: true, pausedUntil: "new_human_message" },
    outcome: { type: "wait" },
  });
});

test("sleep requires a summary and validates its reaction", async () => {
  const missingSummary = await sleepTool.execute(
    createToolCall({ summary: "", text: null, reaction: null }),
  );
  const invalidReaction = await sleepTool.execute(
    createToolCall({ summary: "done", text: null, reaction: "no" }),
  );

  assert.equal(missingSummary.type, "continue");
  assert.equal(invalidReaction.type, "continue");
});

test("sleep finishes with its optional message and reaction", async () => {
  const result = await sleepTool.execute(
    createToolCall({ summary: "done", text: "bye", reaction: "👋" }),
  );

  assert.equal(result.type, "finish");

  if (result.type === "finish") {
    assert.deepEqual(result.outcome, {
      type: "sleep",
      summary: "done",
      text: "bye",
      reaction: "👋",
    });
  }
});
