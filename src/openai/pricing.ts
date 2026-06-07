export interface ModelPricing {
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
}

export const modelPricing: Record<string, ModelPricing> = {
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
};

export function getModelPricing(model: string): ModelPricing {
  const pricing = modelPricing[model];

  if (pricing === undefined) {
    throw new Error(`No OpenAI pricing configured for model: ${model}`);
  }

  return pricing;
}
