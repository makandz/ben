import assert from "node:assert/strict";
import test from "node:test";

import { MemoryConsolidator } from "../MemoryConsolidator.js";
import { ScriptedModel } from "../../testing/ScriptedModel.js";

test("skips consolidation without summaries or short-term memories", async () => {
  const model = new ScriptedModel([]);
  const cleared: string[] = [];
  const consolidator = new MemoryConsolidator(model, "dream instructions", {
    summaries: {
      async list() {
        return [];
      },
      async clear() {
        cleared.push("summaries");
      },
    },
    shortTermMemories: {
      async list() {
        return [];
      },
      async clear() {
        cleared.push("memories");
      },
    },
    longTermMemory: {
      async get() {
        return "existing";
      },
      async set() {
        throw new Error("should not write");
      },
    },
  });

  assert.equal(await consolidator.hasPendingMemory(), false);
  assert.equal(await consolidator.consolidate(), "skipped");
  assert.equal(model.requests.length, 0);
  assert.deepEqual(cleared, []);
});

test("consolidates with no tools and clears short-term data after writing", async () => {
  const model = new ScriptedModel([
    {
      items: [
        { type: "reasoning" },
        { type: "message", role: "assistant", text: " Revised durable memory. " },
      ],
    },
  ]);
  const events: string[] = [];
  const consolidator = new MemoryConsolidator(model, "dream instructions", {
    summaries: {
      async list() {
        return [{ summary: "The group planned a trip." }];
      },
      async clear() {
        events.push("clear summaries");
      },
    },
    shortTermMemories: {
      async list() {
        return [{ id: 4, memory: "Makan prefers morning flights." }];
      },
      async clear() {
        events.push("clear memories");
      },
    },
    longTermMemory: {
      async get() {
        return "Existing durable memory.";
      },
      async set(memory) {
        events.push(`write ${memory}`);
      },
    },
  });

  assert.equal(await consolidator.hasPendingMemory(), true);
  assert.equal(await consolidator.consolidate(), "consolidated");
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0]?.instructions, "dream instructions");
  assert.deepEqual(model.requests[0]?.tools, []);
  assert.match(
    model.requests[0]?.history[0]?.type === "message" ? model.requests[0].history[0].text : "",
    /Existing long-term memory:\nExisting durable memory\./,
  );
  assert.match(JSON.stringify(model.requests[0]?.history), /Makan prefers morning flights/);
  assert.match(JSON.stringify(model.requests[0]?.history), /The group planned a trip/);
  assert.equal(events[0], "write Revised durable memory.");
  assert.deepEqual(new Set(events.slice(1)), new Set(["clear summaries", "clear memories"]));
});

test("preserves short-term data when generation returns no text", async () => {
  const model = new ScriptedModel([{ items: [{ type: "reasoning" }] }]);
  let cleared = false;
  const consolidator = new MemoryConsolidator(model, "dream instructions", {
    summaries: {
      async list() {
        return [{ summary: "Important event." }];
      },
      async clear() {
        cleared = true;
      },
    },
    shortTermMemories: {
      async list() {
        return [];
      },
      async clear() {
        cleared = true;
      },
    },
    longTermMemory: {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error("should not write");
      },
    },
  });

  await assert.rejects(() => consolidator.consolidate(), /returned no text/);
  assert.equal(cleared, false);
});

test("preserves short-term data when the long-term write fails", async () => {
  const model = new ScriptedModel([
    { items: [{ type: "message", role: "assistant", text: "Revised memory." }] },
  ]);
  let cleared = false;
  const consolidator = new MemoryConsolidator(model, "dream instructions", {
    summaries: {
      async list() {
        return [];
      },
      async clear() {
        cleared = true;
      },
    },
    shortTermMemories: {
      async list() {
        return [{ id: 0, memory: "Important fact." }];
      },
      async clear() {
        cleared = true;
      },
    },
    longTermMemory: {
      async get() {
        return "Existing memory.";
      },
      async set() {
        throw new Error("disk unavailable");
      },
    },
  });

  await assert.rejects(() => consolidator.consolidate(), /disk unavailable/);
  assert.equal(cleared, false);
});
