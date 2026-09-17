/**
 * Token estimation for budget-aware retrieval.
 *
 * This is deliberately a cheap heuristic, not a real tokenizer: pulling in a
 * model-specific tokenizer (tiktoken, etc.) would be an extra runtime
 * dependency, and the right tokenizer depends on the *downstream* model the
 * caller injects memories into, not on Jev. `TokenEstimator` is a one-argument
 * function type so callers can swap in `tiktoken`, a provider's own counter,
 * or anything else without touching the rest of this package.
 */
export type TokenEstimator = (text: string) => number;

/**
 * Default estimator: ~4 characters per token, the commonly cited rule of
 * thumb for English text in GPT-family tokenizers. Rounds up so a non-empty
 * string never estimates to 0 tokens.
 */
export const estimateTokens: TokenEstimator = (text: string): number => {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
};
