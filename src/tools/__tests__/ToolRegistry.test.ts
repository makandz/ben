import assert from "node:assert/strict";
import test from "node:test";

import type { Tool } from "../Tool.js";
import { ToolRegistry } from "../ToolRegistry.js";

const exampleTool: Tool = {
  definition: {
    name: "example",
    description: "Example tool.",
    parameters: { type: "object" },
  },
  async execute() {
    return { type: "continue", result: { ok: true } };
  },
};

test("registers and retrieves tools and definitions", () => {
  const registry = new ToolRegistry([exampleTool]);

  assert.equal(registry.get("example"), exampleTool);
  assert.deepEqual(registry.definitions(), [exampleTool.definition]);
});

test("rejects duplicate tool names", () => {
  assert.throws(
    () => new ToolRegistry([exampleTool, exampleTool]),
    /Tool already registered: example/,
  );
});
