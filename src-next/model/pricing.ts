export type ModelPricing = {
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
};

export type BillableUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export const modelPricing: Readonly<Record<string, ModelPricing>> = {
  "gpt-5.4": {
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
  },
  "gpt-5.4-mini": {
    inputUsdPer1M: 0.75,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 4.5,
  },
  "gpt-5.4-nano": {
    inputUsdPer1M: 0.2,
    cachedInputUsdPer1M: 0.02,
    outputUsdPer1M: 1.25,
  },
};

/**
 * Resolves the configured pricing for a model.
 *
 * @param model - Exact model identifier.
 * @returns Pricing for one million tokens.
 */
export function getModelPricing(model: string): ModelPricing {
  const pricing = modelPricing[model];

  if (pricing === undefined) {
    throw new Error(`No OpenAI pricing configured for model: ${model}`);
  }

  return pricing;
}

/**
 * Calculates the cost of one usage record.
 *
 * @param usage - Token counts reported by the model provider.
 * @param pricing - Pricing to apply to each token category.
 * @returns Cost in US dollars.
 */
export function calculateCostUsd(usage: BillableUsage, pricing: ModelPricing): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);

  return (
    uncached * pricing.inputUsdPer1M +
    usage.cachedInputTokens * pricing.cachedInputUsdPer1M +
    usage.outputTokens * pricing.outputUsdPer1M
  ) / 1_000_000;
}
