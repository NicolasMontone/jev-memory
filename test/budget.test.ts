import { describe, expect, it } from 'vitest';
import { selectWithinBudget, type BudgetCandidate } from '../src/budget.js';
import { estimateTokens } from '../src/tokens.js';
import type { Memory } from '../src/types.js';

function makeMemory(id: string, text: string): Memory {
  return { id, text, createdAt: 0, updatedAt: 0 };
}

describe('selectWithinBudget', () => {
  it('picks the higher-density subset over a naive top-score-first cutoff', () => {
    // "expensive" scores slightly higher but costs far more per token of
    // relevance than the two cheaper, almost-as-relevant memories combined.
    const expensive = makeMemory('expensive', 'x'.repeat(400)); // ~100 tokens
    const cheapA = makeMemory('cheapA', 'y'.repeat(40)); // ~10 tokens
    const cheapB = makeMemory('cheapB', 'z'.repeat(40)); // ~10 tokens

    const candidates: BudgetCandidate[] = [
      { memory: expensive, score: 0.9, pinned: false },
      { memory: cheapA, score: 0.8, pinned: false },
      { memory: cheapB, score: 0.8, pinned: false },
    ];

    const result = selectWithinBudget(candidates, 20, estimateTokens);

    const selectedIds = result.selected.map((m) => m.id).sort();
    expect(selectedIds).toEqual(['cheapA', 'cheapB']);
    expect(result.droppedForBudget.map((d) => d.memory.id)).toEqual(['expensive']);
  });

  it('always includes pinned memories regardless of budget, and deducts their cost', () => {
    const pinned = makeMemory('pinned', 'p'.repeat(400)); // ~100 tokens, way over budget alone
    const unpinned = makeMemory('unpinned', 'u'.repeat(20)); // ~5 tokens

    const candidates: BudgetCandidate[] = [
      { memory: pinned, score: 1, pinned: true },
      { memory: unpinned, score: 0.9, pinned: false },
    ];

    const result = selectWithinBudget(candidates, 10, estimateTokens);

    expect(result.selected.map((m) => m.id)).toContain('pinned');
    // Pinned overflowed the whole budget, so nothing else fits.
    expect(result.selected.map((m) => m.id)).not.toContain('unpinned');
    expect(result.droppedForBudget.map((d) => d.memory.id)).toEqual(['unpinned']);
  });

  it('drops zero-score candidates unconditionally, without listing them as budget drops', () => {
    const irrelevant = makeMemory('irrelevant', 'irrelevant text');
    const relevant = makeMemory('relevant', 'relevant text');

    const candidates: BudgetCandidate[] = [
      { memory: irrelevant, score: 0, pinned: false },
      { memory: relevant, score: 0.5, pinned: false },
    ];

    const result = selectWithinBudget(candidates, 1000, estimateTokens);

    expect(result.selected.map((m) => m.id)).toEqual(['relevant']);
    expect(result.droppedForBudget).toEqual([]);
  });

  it('reports an estimated token cost for every candidate, selected or not', () => {
    const a = makeMemory('a', 'abcd'); // 1 token
    const b = makeMemory('b', 'abcdefgh'); // 2 tokens

    const result = selectWithinBudget(
      [
        { memory: a, score: 0.5, pinned: false },
        { memory: b, score: 0.5, pinned: false },
      ],
      1000,
      estimateTokens,
    );

    expect(result.tokens).toEqual({ a: 1, b: 2 });
  });

  it('continues past an item that does not fit rather than stopping the scan', () => {
    // Ranked by score-per-token density: item1 (.18) > item2 (.1) > item3 (.0875).
    const item1 = makeMemory('item1', 'a'.repeat(20)); // 5 tokens, score 0.9
    const item2 = makeMemory('item2', 'b'.repeat(32)); // 8 tokens, score 0.8 -- won't fit after item1
    const item3 = makeMemory('item3', 'c'.repeat(16)); // 4 tokens, score 0.35 -- fits in what's left

    const candidates: BudgetCandidate[] = [
      { memory: item1, score: 0.9, pinned: false },
      { memory: item2, score: 0.8, pinned: false },
      { memory: item3, score: 0.35, pinned: false },
    ];

    // Budget: item1 (5) fits, leaving 5; item2 (8) doesn't fit in the
    // remaining 5 and is dropped; the scan continues and item3 (4) still
    // fits in what's left.
    const result = selectWithinBudget(candidates, 10, estimateTokens);
    expect(result.selected.map((m) => m.id).sort()).toEqual(['item1', 'item3']);
    expect(result.droppedForBudget.map((d) => d.memory.id)).toEqual(['item2']);
  });
});

describe('budget overflow is surfaced, not silent', () => {
  it('flags overBudget when pinned memories alone exceed the budget', () => {
    const big = 'x'.repeat(4000); // ~1000 tokens with the default estimator
    const sel = selectWithinBudget(
      [
        { memory: makeMemory('p1', big), score: 1, pinned: true },
        { memory: makeMemory('p2', big), score: 1, pinned: true },
        { memory: makeMemory('u1', 'small'), score: 1, pinned: false },
      ],
      100,
      estimateTokens,
    );
    expect(sel.overBudget).toBe(true);
    expect(sel.selected.map((m) => m.id).sort()).toEqual(['p1', 'p2']);
    expect(sel.totalTokens).toBeGreaterThan(100);
  });

  it('does not flag overBudget when everything fits', () => {
    const sel = selectWithinBudget(
      [{ memory: makeMemory('a', 'tiny'), score: 1, pinned: false }],
      100,
      estimateTokens,
    );
    expect(sel.overBudget).toBe(false);
    expect(sel.totalTokens).toBeLessThanOrEqual(100);
  });
});
