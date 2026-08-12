import assert from "node:assert/strict";
import test from "node:test";

import { ConversationOrchestrator } from "../ConversationOrchestrator.js";
import { ScriptedModel } from "../../testing/ScriptedModel.js";
import type { Tool } from "../../tools/Tool.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { sleepTool, waitTool } from "../../tools/conversationControls.js";

function createToolCall(callId: string, name: string, argumentsValue: unknown) {
  return {
    type: "tool_call" as const,
    callId,
    name,
    arguments: argumentsValue,
  };
}

test("loops through a capability tool and finishes with portable history", async () => {
  const capability: Tool = {
    definition: {
      name: "lookup",
      description: "Looks up a value.",
      parameters: {},
    },
    async execute() {
      return { type: "continue", result: { found: true } };
    },
  };
  const sendMessage: Tool = {
    definition: { name: "message", description: "Replies.", parameters: {} },
    async execute() {
      return {
        type: "finish",
        result: { ok: true, pausedUntil: "new_human_message" },
        outcome: { type: "reply", text: "hey" },
      };
    },
  };
  const model = new ScriptedModel([
    { items: [createToolCall("1", "lookup", {})] },
    {
      items: [
        { type: "message", role: "assistant", text: "I'll greet them." },
        createToolCall("2", "message", { text: "hey" }),
      ],
    },
  ]);
  const registry = new ToolRegistry([capability, sendMessage, waitTool, sleepTool]);
  const orchestrator = new ConversationOrchestrator(model, registry);

  const result = await orchestrator.run("system prompt", [], "hello");

  assert.equal(result.type, "reply");

  if (result.type !== "reply") {
    return;
  }

  assert.equal(result.text, "hey");
  assert.deepEqual(model.requests[1]?.history.at(-1), {
    type: "tool_result",
    callId: "1",
    result: { found: true },
  });
  assert.deepEqual(result.history.at(-1), {
    type: "tool_result",
    callId: "2",
    result: { ok: true, pausedUntil: "new_human_message" },
  });
});

test("preserves prior history without mutating the caller's array", async () => {
  const history = [{ type: "message" as const, role: "assistant" as const, text: "earlier" }];
  const model = new ScriptedModel([{ items: [createToolCall("1", "wait", {})] }]);
  const orchestrator = new ConversationOrchestrator(model, new ToolRegistry([waitTool, sleepTool]));

  await orchestrator.run("system prompt", history, "new message");

  assert.deepEqual(history, [{ type: "message", role: "assistant", text: "earlier" }]);
  assert.deepEqual(model.requests[0]?.history, [
    { type: "message", role: "assistant", text: "earlier" },
    { type: "message", role: "user", text: "new message" },
  ]);
});

test("returns model-readable failures for unknown tools before continuing", async () => {
  const model = new ScriptedModel([
    { items: [createToolCall("1", "unknown", {})] },
    { items: [createToolCall("2", "wait", {})] },
  ]);
  const orchestrator = new ConversationOrchestrator(model, new ToolRegistry([waitTool, sleepTool]));

  const result = await orchestrator.run("system prompt", [], "hello");

  assert.equal(result.type, "wait");
  assert.deepEqual(model.requests[1]?.history.at(-1), {
    type: "tool_result",
    callId: "1",
    result: { ok: false, error: "unknown tool: unknown" },
  });
});

test("resolves every unexpected tool call with a failure result", async () => {
  const model = new ScriptedModel([
    {
      items: [
        createToolCall("1", "message", { text: "first" }),
        createToolCall("2", "message", { text: "second" }),
      ],
    },
  ]);
  const orchestrator = new ConversationOrchestrator(model, new ToolRegistry([waitTool, sleepTool]));

  const result = await orchestrator.run("system prompt", [], "hello");

  assert.equal(result.type, "wait");

  if (result.type !== "wait") {
    return;
  }

  assert.deepEqual(result.history.slice(-2), [
    {
      type: "tool_result",
      callId: "1",
      result: { ok: false, error: "expected exactly one tool call" },
    },
    {
      type: "tool_result",
      callId: "2",
      result: { ok: false, error: "expected exactly one tool call" },
    },
  ]);
});

test("turns missing tool calls and execution failures into controlled outcomes", async () => {
  const missingCall = new ConversationOrchestrator(
    new ScriptedModel([{ items: [] }]),
    new ToolRegistry(),
  );
  const failedModel = new ConversationOrchestrator(new ScriptedModel([]), new ToolRegistry());
  const throwingTool: Tool = {
    definition: { name: "throw", description: "Throws.", parameters: {} },
    async execute() {
      throw new Error("tool failure");
    },
  };
  const failedTool = new ConversationOrchestrator(
    new ScriptedModel([{ items: [createToolCall("1", "throw", {})] }]),
    new ToolRegistry([throwingTool]),
  );

  assert.equal((await missingCall.run("prompt", [], "hello")).type, "wait");
  assert.equal((await failedModel.run("prompt", [], "hello")).type, "failed");
  assert.equal((await failedTool.run("prompt", [], "hello")).type, "failed");
});

test("enforces the configured tool iteration limit", async () => {
  const capability: Tool = {
    definition: { name: "loop", description: "Loops.", parameters: {} },
    async execute() {
      return { type: "continue", result: { ok: true } };
    },
  };
  const model = new ScriptedModel([
    { items: [createToolCall("1", "loop", {})] },
    { items: [createToolCall("2", "loop", {})] },
  ]);
  const orchestrator = new ConversationOrchestrator(model, new ToolRegistry([capability]), 2);

  const result = await orchestrator.run("system prompt", [], "hello");

  assert.equal(result.type, "wait");
  assert.equal(model.requests.length, 2);
});

test("rejects invalid iteration limits", () => {
  assert.throws(
    () => new ConversationOrchestrator(new ScriptedModel([]), new ToolRegistry(), 0),
    /positive integer/,
  );
});
