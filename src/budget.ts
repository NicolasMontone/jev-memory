import type { Memory, ScoredDrop } from './types.js';
import type { TokenEstimator } from './tokens.js';

export interface BudgetCandidate {
  memory: Memory;
  /** Normalized relevance in [0, 1]. Pinned candidates should pass 1. */
  score: number;
  /** Pinned candidates are always included and bypass ranking entirely. */
  pinned: boolean;
}

export interface BudgetSelection {
  /** Selected memories, in no particular order (the caller re-sorts by score). */
  selected: Memory[];
  droppedForBudget: ScoredDrop[];
  tokens: Record<string, number>;
  /**
   * True when pinned memories alone exceeded `tokenBudget`. Pinned memories are
   * always returned, so the selection is over budget and the caller must decide
   * what to do. Without this flag the overflow is silent and the caller ships a
   * prompt larger than the budget it asked for.
   */
  overBudget: boolean;
  /** Total estimated tokens of `selected`. */
  totalTokens: number;
}

/**
 * Greedy, budget-aware selection: pinned memories are always included (their
 * cost is still deducted from the budget), and everything else is added in
 * order of score-per-token (relevance density), not raw score -- the same
 * intuition as the classic fractional-knapsack heuristic, adapted to whole
 * items. This picks a higher-relevance bundle for a fixed budget than a
 * naive top-K-by-score cutoff would, because top-K can spend the whole
 * budget on a few expensive, only-slightly-more-relevant memories.
 *
 * Zero-relevance candidates are dropped unconditionally (not reported in
 * `droppedForBudget`, which is reserved for candidates that *would* have
 * been retrieved but didn't fit).
 */
export function selectWithinBudget(
  candidates: readonly BudgetCandidate[],
  tokenBudget: number,
  estimateTokens: TokenEstimator,
): BudgetSelection {
  const tokens: Record<string, number> = {};
  for (const c of candidates) tokens[c.memory.id] = estimateTokens(c.memory.text);

  const pinned = candidates.filter((c) => c.pinned);
  const unpinned = candidates.filter((c) => !c.pinned);

  const selected: Memory[] = [];
  let remaining = tokenBudget;

  for (const c of pinned) {
    selected.push(c.memory);
    remaining -= tokens[c.memory.id] as number;
  }
  // Pinned overflow doesn't take away from itself; it just leaves nothing
  // for the ranked pass below. Surfaced as `overBudget` so it isn't silent.
  const overBudget = remaining < 0;
  remaining = Math.max(0, remaining);

  const ranked = unpinned
    .filter((c) => c.score > 0)
    .slice()
    .sort((a, b) => {
      const costA = Math.max(1, tokens[a.memory.id] as number);
      const costB = Math.max(1, tokens[b.memory.id] as number);
      const densityA = a.score / costA;
      const densityB = b.score / costB;
      if (densityB !== densityA) return densityB - densityA;
      return b.score - a.score;
    });

  const droppedForBudget: ScoredDrop[] = [];
  for (const c of ranked) {
    const cost = tokens[c.memory.id] as number;
    if (cost <= remaining) {
      selected.push(c.memory);
      remaining -= cost;
    } else {
      droppedForBudget.push({ memory: c.memory, score: c.score, tokens: cost });
    }
  }

  const totalTokens = selected.reduce((sum, m) => sum + (tokens[m.id] as number), 0);

  return { selected, droppedForBudget, tokens, overBudget, totalTokens };
}
