import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";

import {
  ModelBudgetExceededError,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "../Model.js";
import { getModelPricing } from "../pricing.js";
import { OpenAIMapper } from "./OpenAIMapper.js";
import { OpenAIUsageStore } from "./OpenAIUsageStore.js";

export const OPENAI_CONVERSATION_MODEL = "gpt-5.6-luna";
export const OPENAI_INTERNAL_MODEL = "gpt-5.6-luna";
const MAX_OUTPUT_TOKENS = 512;

type ResponsesClient = {
  create(params: ResponseCreateParamsNonStreaming): Promise<Response>;
};

export type OpenAIModelOptions = {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
};

/** Implements the provider-neutral model contract with the OpenAI Responses API. */
export class OpenAIModel implements Model {
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly responses: ResponsesClient;
  private readonly mapper = new OpenAIMapper();

  /**
   * Creates the adapter without performing a network request.
   *
   * @param options - Provider credential and optional local request overrides.
   * @param usageStore - Shared usage persistence and budget boundary.
   * @param responses - Optional owned client seam used by tests.
   * @throws When the model lacks configured pricing or `maxOutputTokens` is invalid.
   */
  constructor(
    options: OpenAIModelOptions,
    private readonly usageStore: OpenAIUsageStore,
    responses?: ResponsesClient,
  ) {
    this.model = options.model ?? OPENAI_CONVERSATION_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
    this.responses = responses ?? new OpenAI({ apiKey: options.apiKey }).responses;
    getModelPricing(this.model);

    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens < 1) {
      throw new Error("maxOutputTokens must be a positive integer");
    }
  }

  /**
   * Performs one budget-checked Responses API request and records returned usage.
   *
   * @param request - Provider-neutral request to translate and execute.
   * @returns The provider response translated into a portable model turn.
   * @throws When the configured daily model budget has been exhausted.
   */
  async invoke(request: ModelRequest): Promise<ModelTurn> {
    const budget = await this.usageStore.getBudgetStatus();

    if (budget.limited) {
      throw new ModelBudgetExceededError(budget.day, budget.costUsd, budget.budgetUsd);
    }

    const tools = this.mapper.toTools(request);
    const response = await this.responses.create({
      model: this.model,
      instructions: request.instructions,
      input: this.mapper.toInput(request),
      ...(tools.length === 0
        ? {}
        : { tools, tool_choice: "required" as const, parallel_tool_calls: false }),
      max_output_tokens: this.maxOutputTokens,
      reasoning: { effort: "medium", summary: "concise" },
      include: ["reasoning.encrypted_content"],
      store: false,
    });
    const turn = this.mapper.toTurn(response);

    if (turn.usage !== undefined) {
      await this.usageStore.record(this.model, turn.usage);
    }

    return turn;
  }
}
