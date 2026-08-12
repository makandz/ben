import assert from "node:assert/strict";
import test from "node:test";

import type { RememberMemoryInput } from "../../storage/MemoryStore.js";
import { createRememberTool } from "../remember.js";

test("remember tool maps explicit add, update, and delete arguments", async () => {
  const inputs: RememberMemoryInput[] = [];
  const statuses: string[] = [];
  const tool = createRememberTool({
    store: {
      async remember(input) {
        inputs.push(input);
        return { ok: true, action: "added", id: 0, memory: "stored" };
      },
    },
    async sendStatus(message) {
      statuses.push(message);
    },
  });

  await tool.execute({
    type: "tool_call",
    callId: "add",
    name: "remember",
    arguments: { action: "add", id: null, memory: "new" },
  });
  await tool.execute({
    type: "tool_call",
    callId: "update",
    name: "remember",
    arguments: { action: "update", id: 2, memory: "changed" },
  });
  await tool.execute({
    type: "tool_call",
    callId: "delete",
    name: "remember",
    arguments: { action: "delete", id: 3, memory: null },
  });

  assert.deepEqual(inputs, [
    { action: "add", memory: "new" },
    { action: "update", id: 2, memory: "changed" },
    { action: "delete", id: 3 },
  ]);
  assert.deepEqual(statuses, [
    '> Remembered "stored"',
    '> Remembered "stored"',
    '> Remembered "stored"',
  ]);
});

test("remember tool rejects mismatched action fields", async () => {
  const tool = createRememberTool({
    store: {
      async remember() {
        throw new Error("store should not be called");
      },
    },
    async sendStatus() {},
  });

  const result = await tool.execute({
    type: "tool_call",
    callId: "bad",
    name: "remember",
    arguments: { action: "delete", id: 1, memory: "not null" },
  });

  assert.deepEqual(result, {
    type: "continue",
    result: {
      ok: false,
      error: "delete requires a non-negative integer id and memory must be null",
    },
  });
});

test("remember tool sends plain success statuses and warning failures", async () => {
  const statuses: string[] = [];
  const results = [
    { ok: true as const, action: "added" as const, id: 0, memory: "new fact" },
    { ok: true as const, action: "updated" as const, id: 0, memory: "better fact" },
    { ok: true as const, action: "deleted" as const, id: 0, memory: "better fact" },
    { ok: false as const, error: "memory limit reached" },
  ];
  const tool = createRememberTool({
    store: {
      async remember() {
        const result = results.shift();
        if (result === undefined) throw new Error("no result");
        return result;
      },
    },
    async sendStatus(message) {
      statuses.push(message);
    },
  });

  await tool.execute(call("add", null, "new fact"));
  await tool.execute(call("update", 0, "better fact"));
  await tool.execute(call("delete", 0, null));
  await tool.execute(call("add", null, "too many"));

  assert.deepEqual(statuses, [
    '> Remembered "new fact"',
    '> Updated memory to "better fact"',
    '> Forgot "better fact"',
    "> ⚠️ Failed to add memory: memory limit reached",
  ]);
});

function call(action: string, id: number | null, memory: string | null) {
  return {
    type: "tool_call" as const,
    callId: action,
    name: "remember",
    arguments: { action, id, memory },
  };
}
