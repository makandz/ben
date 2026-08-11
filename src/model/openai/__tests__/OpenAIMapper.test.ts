import assert from "node:assert/strict";
import test from "node:test";

import type { Response } from "openai/resources/responses/responses";

import type { ModelRequest } from "../../Model.js";
import { OpenAIMapper } from "../OpenAIMapper.js";

const request: ModelRequest = {
  instructions: "Be helpful.",
  history: [
    { type: "message", role: "user", text: "hello" },
    { type: "message", role: "assistant", text: "hi" },
    { type: "tool_call", callId: "call-1", name: "lookup", arguments: { query: "x" } },
    { type: "tool_result", callId: "call-1", result: { found: true } },
  ],
  tools: [
    {
      name: "lookup",
      description: "Looks up a value.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
};

test("maps portable history and arbitrary tools into a Responses API request", () => {
  const mapper = new OpenAIMapper();

  assert.deepEqual(mapper.toInput(request), [
    { type: "message", role: "user", content: "hello" },
    { type: "message", role: "assistant", content: "hi" },
    {
      type: "function_call",
      call_id: "call-1",
      name: "lookup",
      arguments: '{"query":"x"}',
    },
    {
      type: "function_call_output",
      call_id: "call-1",
      output: '{"found":true}',
    },
  ]);
  assert.deepEqual(mapper.toTools(request), [
    {
      type: "function",
      name: "lookup",
      description: "Looks up a value.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      strict: true,
    },
  ]);
});

test("maps text, reasoning, calls, usage, and private continuation data", () => {
  const mapper = new OpenAIMapper();
  const response = createResponse();

  const turn = mapper.toTurn(response);

  assert.deepEqual(turn, {
    items: [
      { type: "reasoning", text: "Check the lookup." },
      { type: "message", role: "assistant", text: "I'll check." },
      { type: "tool_call", callId: "call-2", name: "lookup", arguments: { query: "weather" } },
    ],
    reasoningSummary: "Check the lookup.",
    usage: {
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      totalTokens: 150,
    },
  });

  const continuationRequest: ModelRequest = {
    ...request,
    history: [...turn.items, { type: "tool_result", callId: "call-2", result: { ok: true } }],
  };
  assert.deepEqual(mapper.toInput(continuationRequest)[0], {
    id: "reasoning-1",
    type: "reasoning",
    summary: [],
    encrypted_content: "encrypted",
    status: "completed",
  });
});

test("preserves malformed function arguments for tool-level validation", () => {
  const mapper = new OpenAIMapper();
  const response = createResponse();
  const call = response.output[2];

  if (call?.type !== "function_call") {
    throw new Error("fixture function call missing");
  }

  call.arguments = "not json";
  assert.deepEqual(mapper.toTurn(response).items.at(-1), {
    type: "tool_call",
    callId: "call-2",
    name: "lookup",
    arguments: "not json",
  });
});

test("serializes undefined tool values as valid JSON null", () => {
  const mapper = new OpenAIMapper();
  const input = mapper.toInput({
    ...request,
    history: [
      { type: "tool_call", callId: "call-3", name: "lookup", arguments: undefined },
      { type: "tool_result", callId: "call-3", result: undefined },
    ],
  });

  assert.equal(input[0]?.type === "function_call" ? input[0].arguments : undefined, "null");
  assert.equal(input[1]?.type === "function_call_output" ? input[1].output : undefined, "null");
});

function createResponse(): Response {
  return {
    id: "response-1",
    object: "response",
    created_at: 0,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 512,
    model: "gpt-5.4-mini",
    output: [
      {
        id: "reasoning-1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: " Check the lookup. " }],
        encrypted_content: "encrypted",
        status: "completed",
      },
      {
        id: "message-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I'll check.", annotations: [] }],
      },
      {
        id: "function-1",
        type: "function_call",
        call_id: "call-2",
        name: "lookup",
        arguments: '{"query":"weather"}',
        status: "completed",
      },
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: "low", summary: "concise" },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "required",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 150,
    },
    user: null,
    metadata: {},
    output_text: "I'll check.",
  } as unknown as Response;
}
