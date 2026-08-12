import assert from "node:assert/strict";
import test from "node:test";

import { sleepTool, waitTool } from "../conversationControls.js";

function createToolCall(argumentsValue: unknown) {
  return {
    type: "tool_call" as const,
    callId: "1",
    name: "test",
    arguments: argumentsValue,
  };
}

test("wait finishes without producing a message", async () => {
  const result = await waitTool.execute(createToolCall({}));

  assert.deepEqual(result, {
    type: "finish",
    result: { ok: true, pausedUntil: "new_human_message" },
    outcome: { type: "wait" },
  });
});

test("sleep requires a summary", async () => {
  const missingSummary = await sleepTool.execute(createToolCall({ summary: "" }));

  assert.equal(missingSummary.type, "continue");
});

test("sleep finishes with its summary", async () => {
  const result = await sleepTool.execute(createToolCall({ summary: "done" }));

  assert.equal(result.type, "finish");

  if (result.type === "finish") {
    assert.deepEqual(result.outcome, {
      type: "sleep",
      summary: "done",
    });
  }
});
