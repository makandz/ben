import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";

import { ModelBudgetExceededError } from "../../Model.js";
import { OpenAIModel } from "../OpenAIModel.js";
import { OpenAIUsageStore } from "../OpenAIUsageStore.js";

test("makes one configured request, maps its turn, and records usage", async (context) => {
  const directory = await createTempDirectory(context);
  const usageStore = new OpenAIUsageStore(directory, "gpt-5.4-mini", 1);
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const client = {
    async create(params: ResponseCreateParamsNonStreaming): Promise<Response> {
      requests.push(params);
      return createResponse();
    },
  };
  const model = new OpenAIModel({ apiKey: "test" }, usageStore, client);

  const turn = await model.invoke({
    instructions: "Be Ben.",
    history: [{ type: "message", role: "user", text: "hello" }],
    tools: [{ name: "finish", description: "Finishes.", parameters: { type: "object" } }],
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    model: "gpt-5.6-luna",
    instructions: "Be Ben.",
    input: [{ type: "message", role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        name: "finish",
        description: "Finishes.",
        parameters: { type: "object" },
        strict: true,
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
    max_output_tokens: 512,
    reasoning: { effort: "medium" },
    include: ["reasoning.encrypted_content"],
    store: false,
  });
  assert.deepEqual(turn.items, [
    { type: "tool_call", callId: "call-1", name: "finish", arguments: {} },
  ]);
  assert.equal((await usageStore.getTodaySummary()).requests, 1);
});

test("blocks the provider request after the daily budget is reached", async (context) => {
  const directory = await createTempDirectory(context);
  const usageStore = new OpenAIUsageStore(directory, "gpt-5.4-mini", 0.000001);
  await usageStore.record("gpt-5.4-mini", {
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 10,
    totalTokens: 20,
  });
  let calls = 0;
  const model = new OpenAIModel({ apiKey: "test" }, usageStore, {
    async create(): Promise<Response> {
      calls += 1;
      return createResponse();
    },
  });

  await assert.rejects(
    model.invoke({ instructions: "x", history: [], tools: [] }),
    ModelBudgetExceededError,
  );
  assert.equal(calls, 0);
});

test("supports requests without forcing a tool call", async (context) => {
  const directory = await createTempDirectory(context);
  const usageStore = new OpenAIUsageStore(directory, "gpt-5.4-mini", 0);
  let request: ResponseCreateParamsNonStreaming | undefined;
  const model = new OpenAIModel({ apiKey: "test", maxOutputTokens: 96 }, usageStore, {
    async create(params): Promise<Response> {
      request = params;
      return {
        output: [
          {
            id: "message-1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        ],
      } as unknown as Response;
    },
  });

  const turn = await model.invoke({
    instructions: "Be concise.",
    history: [{ type: "message", role: "user", text: "Say hello." }],
    tools: [],
  });

  assert.equal("tools" in (request ?? {}), false);
  assert.equal("tool_choice" in (request ?? {}), false);
  assert.deepEqual(turn.items, [{ type: "message", role: "assistant", text: "hello" }]);
});

function createResponse(): Response {
  return {
    output: [
      {
        id: "function-1",
        type: "function_call",
        call_id: "call-1",
        name: "finish",
        arguments: "{}",
        status: "completed",
      },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 120,
    },
  } as unknown as Response;
}

async function createTempDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ben-openai-model-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
