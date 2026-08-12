import assert from "node:assert/strict";
import test from "node:test";

import { createActionableTool } from "../createActionableTool.js";

function createTool(succeeds = true) {
  return createActionableTool({
    definition: {
      name: "example",
      description: "Runs an example capability.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
    async execute() {
      return succeeds
        ? { ok: true as const, result: { ok: true } }
        : { ok: false as const, result: { ok: false, error: "capability failed" } };
    },
  });
}

function execute(argumentsValue: unknown, succeeds = true) {
  const tool = createTool(succeeds);
  return tool.execute({
    type: "tool_call",
    callId: "call",
    name: tool.definition.name,
    arguments: argumentsValue,
  });
}

test("adds strict reusable lifecycle fields to a capability schema", () => {
  const parameters = createTool().definition.parameters;

  assert.deepEqual(parameters.required, ["value", "next_action", "sleep_summary"]);
  assert.deepEqual(Object.keys(parameters.properties as object), [
    "value",
    "next_action",
    "sleep_summary",
  ]);
});

test("defaults to continue and supports explicit wait and sleep", async () => {
  assert.deepEqual(await execute({ value: "x" }), {
    type: "continue",
    result: { ok: true },
  });
  assert.deepEqual(await execute({ value: "x", next_action: "wait", sleep_summary: null }), {
    type: "finish",
    result: { ok: true },
    outcome: { type: "wait" },
  });
  assert.deepEqual(await execute({ value: "x", next_action: "sleep", sleep_summary: " Done. " }), {
    type: "finish",
    result: { ok: true },
    outcome: { type: "sleep", summary: "Done." },
  });
});

test("keeps action validation and capability failures recoverable", async () => {
  assert.match(
    JSON.stringify(await execute({ value: "x", next_action: "stop" })),
    /next_action must be continue, wait, or sleep/,
  );
  assert.match(
    JSON.stringify(await execute({ value: "x", next_action: "sleep", sleep_summary: null })),
    /sleep_summary is required/,
  );
  assert.deepEqual(
    await execute({ value: "x", next_action: "sleep", sleep_summary: "Should not apply." }, false),
    {
      type: "continue",
      result: { ok: false, error: "capability failed" },
    },
  );
});
