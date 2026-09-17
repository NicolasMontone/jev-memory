import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inMemoryStore } from '../src/store/memory-store.js';
import type { Memory } from '../src/types.js';

const experimental_evaluate = vi.fn();
vi.mock('ai', () => ({ experimental_evaluate }));

const { createMemory } = await import('../src/memory.js');

interface QuestionLike {
  type: 'boolean' | 'score' | 'choice';
  criteria?: unknown;
}

/**
 * Builds an `experimental_evaluate` mock implementation that answers every
 * question in a call based on lookup tables keyed by question id:
 *   - `probabilities[id]` -> boolean answer's P(true)
 *   - `normalizedScores[id]` -> score answer's score, converted to the
 *     fractional [0, levels-1] range the real Jev contract uses.
 * Falls back to 0 for any id not present in the relevant table.
 */
function mockEvaluate(options: { probabilities?: Record<string, number>; normalizedScores?: Record<string, number> } = {}) {
  const { probabilities = {}, normalizedScores = {} } = options;
  experimental_evaluate.mockImplementation(async ({ questions }: { questions: Record<string, QuestionLike> }) => {
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'boolean') {
        answers[id] = { type: 'boolean', probability: probabilities[id] ?? 0 };
      } else if (q.type === 'score') {
        const levels = (q.criteria as unknown[]).length;
        const normalized = normalizedScores[id] ?? 0;
        answers[id] = { type: 'score', score: normalized * (levels - 1) };
      }
    }
    return {
      answers,
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      warnings: [],
      rounding: undefined,
      providerMetadata: undefined,
      response: { timestamp: new Date(), modelId: 'typesafe-ai/jev' },
    };
  });
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? 'mem-1',
    text: overrides.text ?? 'some fact',
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    ...(overrides.pinned !== undefined ? { pinned: overrides.pinned } : {}),
  };
}

beforeEach(() => {
  experimental_evaluate.mockReset();
});

describe('remember (write gate)', () => {
  it('stores the fact verbatim when durability is at/above the threshold', async () => {
    mockEvaluate({ probabilities: { durability: 0.9 } });
    const store = inMemoryStore();
    const memory = createMemory({ store, writeThreshold: 0.6 });

    const result = await memory.remember('User prefers pnpm over npm', { state: 'conversation so far' });

    expect(result.stored).toBe(true);
    expect(result.durability).toBe(0.9);
    expect(result.memory?.text).toBe('User prefers pnpm over npm');
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]!.text).toBe('User prefers pnpm over npm');
  });

  it('rejects a fact below the write threshold, and stores nothing', async () => {
    mockEvaluate({ probabilities: { durability: 0.3 } });
    const store = inMemoryStore();
    const memory = createMemory({ store, writeThreshold: 0.6 });

    const result = await memory.remember('I like turtles today', { state: 'conversation so far' });

    expect(result.stored).toBe(false);
    expect(result.memory).toBeUndefined();
    expect(result.durability).toBe(0.3);
    expect(result.reason).toMatch(/below|<.*threshold/i);
    expect(await store.list()).toEqual([]);
  });

  it('never rewrites the text: the stored memory is byte-identical to the input', async () => {
    mockEvaluate({ probabilities: { durability: 0.99 } });
    const store = inMemoryStore();
    const memory = createMemory({ store });
    const text = 'Exact, unusual formatting -- 42% off, "quoted", trailing spaces   ';

    await memory.remember(text, { state: 'x' });

    expect((await store.list())[0]!.text).toBe(text);
  });

  it('pin: true bypasses the write gate entirely -- no evaluate() call at all', async () => {
    const store = inMemoryStore();
    const memory = createMemory({ store });

    const result = await memory.remember('Always keep this', { pin: true });

    expect(experimental_evaluate).not.toHaveBeenCalled();
    expect(result.stored).toBe(true);
    expect(result.durability).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 });
    expect((await store.list())[0]).toMatchObject({ pinned: true, text: 'Always keep this' });
  });

  it('requires `state` unless pinning', async () => {
    const store = inMemoryStore();
    const memory = createMemory({ store });
    await expect(memory.remember('fact')).rejects.toThrow(/requires `state`/);
  });
});

describe('select (retrieve gate)', () => {
  it('scores N stored memories in exactly ONE evaluate() call', async () => {
    const store = inMemoryStore(
      Array.from({ length: 8 }, (_, i) => makeMemory({ id: `m${i}`, text: `fact ${i}` })),
    );
    mockEvaluate({ normalizedScores: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i}`, 0.5])) });
    const memory = createMemory({ store });

    const result = await memory.select({ state: 'current turn' });

    expect(experimental_evaluate).toHaveBeenCalledTimes(1);
    expect(result.usage.calls).toBe(1);
    expect(Object.keys(result.scores)).toHaveLength(8);
    expect(result.memories).toHaveLength(8);
  });

  it('chunks into multiple evaluate() calls above maxQuestionsPerCall', async () => {
    const store = inMemoryStore(
      Array.from({ length: 5 }, (_, i) => makeMemory({ id: `m${i}`, text: `fact ${i}` })),
    );
    mockEvaluate({ normalizedScores: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`m${i}`, 0.7])) });
    const memory = createMemory({ store, maxQuestionsPerCall: 2 });

    const result = await memory.select({ state: 'current turn' });

    expect(experimental_evaluate).toHaveBeenCalledTimes(3); // 2 + 2 + 1
    expect(result.usage.calls).toBe(3);
    expect(result.usage.inputTokens).toBe(15); // 5 tokens per call * 3 calls
    expect(result.memories).toHaveLength(5);
  });

  it('pinned facts bypass the model entirely: excluded from the question set, always in the result', async () => {
    const store = inMemoryStore([
      makeMemory({ id: 'pinned-1', text: 'pinned fact', pinned: true }),
      makeMemory({ id: 'unpinned-1', text: 'unpinned fact' }),
    ]);
    mockEvaluate({ normalizedScores: { 'unpinned-1': 0.4 } });
    const memory = createMemory({ store });

    const result = await memory.select({ state: 'current turn' });

    expect(experimental_evaluate).toHaveBeenCalledTimes(1);
    const callArgs = experimental_evaluate.mock.calls[0]![0] as { questions: Record<string, unknown> };
    expect(Object.keys(callArgs.questions)).toEqual(['unpinned-1']);
    expect(result.scores['pinned-1']).toBe(1);
    expect(result.memories.map((m) => m.id)).toContain('pinned-1');
  });

  it('makes zero evaluate() calls when every memory is pinned', async () => {
    const store = inMemoryStore([makeMemory({ id: 'p1', pinned: true }), makeMemory({ id: 'p2', pinned: true })]);
    const memory = createMemory({ store });

    const result = await memory.select({ state: 'x' });

    expect(experimental_evaluate).not.toHaveBeenCalled();
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 });
    expect(result.memories.map((m) => m.id).sort()).toEqual(['p1', 'p2']);
  });

  it('returns an empty result with zero calls for an empty store', async () => {
    const store = inMemoryStore();
    const memory = createMemory({ store });
    const result = await memory.select({ state: 'x' });
    expect(experimental_evaluate).not.toHaveBeenCalled();
    expect(result.memories).toEqual([]);
    expect(result.droppedForBudget).toEqual([]);
  });

  it('honors the token budget: picks the higher-density subset and reports what it dropped', async () => {
    const store = inMemoryStore([
      makeMemory({ id: 'expensive', text: 'x'.repeat(400) }), // ~100 tokens
      makeMemory({ id: 'cheapA', text: 'y'.repeat(40) }), // ~10 tokens
      makeMemory({ id: 'cheapB', text: 'z'.repeat(40) }), // ~10 tokens
    ]);
    mockEvaluate({ normalizedScores: { expensive: 0.9, cheapA: 0.8, cheapB: 0.8 } });
    const memory = createMemory({ store });

    const result = await memory.select({ state: 'current turn', tokenBudget: 20 });

    expect(result.memories.map((m) => m.id).sort()).toEqual(['cheapA', 'cheapB']);
    expect(result.droppedForBudget).toHaveLength(1);
    expect(result.droppedForBudget[0]!.memory.id).toBe('expensive');
    expect(result.droppedForBudget[0]!.score).toBeCloseTo(0.9);
  });

  it('returns memories highest-score-first', async () => {
    const store = inMemoryStore([
      makeMemory({ id: 'low', text: 'low relevance fact' }),
      makeMemory({ id: 'high', text: 'high relevance fact' }),
    ]);
    mockEvaluate({ normalizedScores: { low: 0.2, high: 0.9 } });
    const memory = createMemory({ store });

    const result = await memory.select({ state: 'x' });

    expect(result.memories.map((m) => m.id)).toEqual(['high', 'low']);
  });

  it('handles a score answer with no `probabilities` field (optional per the Jev contract)', async () => {
    experimental_evaluate.mockResolvedValueOnce({
      answers: { m1: { type: 'score', score: 3 } }, // no `probabilities`
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      warnings: [],
      rounding: undefined,
      providerMetadata: undefined,
      response: { timestamp: new Date(), modelId: 'typesafe-ai/jev' },
    });
    const store = inMemoryStore([makeMemory({ id: 'm1', text: 'fact' })]);
    const memory = createMemory({ store });

    const result = await memory.select({ state: 'x' });

    expect(result.scores.m1).toBeCloseTo(0.75); // 3 / (5 levels - 1)
    expect(result.memories.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('compact (evict gate)', () => {
  it('evicts memories at/above the eviction threshold and removes them from the store', async () => {
    const store = inMemoryStore([
      makeMemory({ id: 'stale', text: 'old fact' }),
      makeMemory({ id: 'fresh', text: 'current fact' }),
    ]);
    mockEvaluate({ probabilities: { stale: 0.9, fresh: 0.1 } });
    const memory = createMemory({ store, evictThreshold: 0.6 });

    const result = await memory.compact({ state: 'current turn' });

    expect(result.evicted.map((m) => m.id)).toEqual(['stale']);
    expect(result.kept.map((m) => m.id)).toEqual(['fresh']);
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]!.id).toBe('fresh');
  });

  it('never evaluates or evicts pinned memories', async () => {
    const store = inMemoryStore([
      makeMemory({ id: 'pinned-1', text: 'never evict me', pinned: true }),
      makeMemory({ id: 'stale', text: 'old fact' }),
    ]);
    mockEvaluate({ probabilities: { stale: 0.95 } });
    const memory = createMemory({ store });

    const result = await memory.compact({ state: 'x' });

    const callArgs = experimental_evaluate.mock.calls[0]![0] as { questions: Record<string, unknown> };
    expect(Object.keys(callArgs.questions)).toEqual(['stale']);
    expect(result.kept.map((m) => m.id)).toContain('pinned-1');
    expect(result.evicted.map((m) => m.id)).not.toContain('pinned-1');
    expect(await store.list()).toContainEqual(expect.objectContaining({ id: 'pinned-1' }));
  });

  it('makes zero evaluate() calls when everything is pinned', async () => {
    const store = inMemoryStore([makeMemory({ id: 'p1', pinned: true })]);
    const memory = createMemory({ store });
    const result = await memory.compact({ state: 'x' });
    expect(experimental_evaluate).not.toHaveBeenCalled();
    expect(result.evicted).toEqual([]);
    expect(result.kept.map((m) => m.id)).toEqual(['p1']);
  });
});

describe('setPinned / forget / list', () => {
  it('setPinned flips the flag deterministically, no evaluate() call', async () => {
    const store = inMemoryStore([makeMemory({ id: 'm1' })]);
    const memory = createMemory({ store });
    await memory.setPinned('m1', true);
    expect(experimental_evaluate).not.toHaveBeenCalled();
    expect((await memory.list())[0]!.pinned).toBe(true);
  });

  it('forget removes a memory unconditionally', async () => {
    const store = inMemoryStore([makeMemory({ id: 'm1' })]);
    const memory = createMemory({ store });
    await memory.forget('m1');
    expect(await memory.list()).toEqual([]);
  });
});
