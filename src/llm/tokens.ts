export type TokenStats = {
  inputTokens: number;
  outputTokens: number;
};

export type TokenTrackingResult = {
  current: TokenStats;
  total: TokenStats;
};

export const tokenUsage: Record<string, TokenStats> = {};

/**
 * Estimate token count from text (Gemini approximation: 1 token ≈ 4 characters)
 * @param text - The text to estimate tokens for.
 * @returns The estimated number of tokens.
 */
export const estimateTokens = (text: string): number => {
  return Math.ceil(text.length / 4);
};

/**
 * Initialize token tracking for a specific model
 * @param model - The model name to initialize tracking for.
 */
export const initializeTokenTracking = (model: string): void => {
  if (!tokenUsage[model]) {
    tokenUsage[model] = { inputTokens: 0, outputTokens: 0 };
  }
};

/**
 * Track token usage for a specific model
 * @param model - The model name.
 * @param inputText - The input text to estimate tokens for.
 * @param outputText - The output text to estimate tokens for.
 * @returns The token stats for this call and cumulative totals.
 */
export const trackTokenUsage = (
  model: string,
  inputText: string,
  outputText: string
): TokenTrackingResult => {
  initializeTokenTracking(model);
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  tokenUsage[model].inputTokens += inputTokens;
  tokenUsage[model].outputTokens += outputTokens;
  return {
    current: { inputTokens, outputTokens },
    total: { ...tokenUsage[model] },
  };
};
