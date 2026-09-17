import { describe, expect, it } from 'vitest';
import {
  RELEVANCE_LEVELS,
  buildEvictQuestions,
  buildRetrieveQuestions,
  buildWriteQuestion,
  normalizedScore,
  probability,
} from '../src/gates.js';
import type { Answer } from '../src/evaluate-client.js';
import type { Memory } from '../src/types.js';

function makeMemory(id: string, text: string): Memory {
  return { id, text, createdAt: 0, updatedAt: 0 };
}

describe('buildWriteQuestion', () => {
  it('builds exactly one boolean question, carrying the candidate fact verbatim', () => {
    const questions = buildWriteQuestion('User prefers pnpm over npm');
    expect(Object.keys(questions)).toEqual(['durability']);
    const q = questions.durability!;
    expect(q.type).toBe('boolean');
    expect(JSON.stringify(q.instructions)).toContain('User prefers pnpm over npm');
  });
});

describe('buildRetrieveQuestions', () => {
  it('builds one score question per memory, keyed by memory id, text carried verbatim', () => {
    const memories = [makeMemory('a', 'fact A'), makeMemory('b', 'fact B')];
    const questions = buildRetrieveQuestions(memories);
    expect(Object.keys(questions).sort()).toEqual(['a', 'b']);
    for (const [id, memory] of [
      ['a', memories[0]!],
      ['b', memories[1]!],
    ] as const) {
      const q = questions[id]!;
      expect(q.type).toBe('score');
      if (q.type === 'score') {
        expect(q.criteria.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(q.instructions)).toContain(memory.text);
      }
    }
  });

  it('uses the same ordered rubric (>= 2 levels, lowest to highest) for every question', () => {
    expect(RELEVANCE_LEVELS.length).toBeGreaterThanOrEqual(2);
    const questions = buildRetrieveQuestions([makeMemory('a', 'x')]);
    const q = questions.a!;
    if (q.type === 'score') {
      expect(q.criteria).toEqual(RELEVANCE_LEVELS);
    }
  });
});

describe('buildEvictQuestions', () => {
  it('builds one boolean question per memory, keyed by memory id', () => {
    const memories = [makeMemory('a', 'stale fact'), makeMemory('b', 'fresh fact')];
    const questions = buildEvictQuestions(memories);
    expect(Object.keys(questions).sort()).toEqual(['a', 'b']);
    expect(questions.a!.type).toBe('boolean');
    expect(questions.b!.type).toBe('boolean');
  });
});

describe('normalizedScore', () => {
  it('normalizes a fractional score into [0, 1] using levels-1 as the denominator', () => {
    expect(normalizedScore({ type: 'score', score: 0 }, 5)).toBe(0);
    expect(normalizedScore({ type: 'score', score: 4 }, 5)).toBe(1);
    expect(normalizedScore({ type: 'score', score: 2 }, 5)).toBe(0.5);
  });

  it('does not require `probabilities` to be present (optional per the Jev contract)', () => {
    const answer: Answer = { type: 'score', score: 3 };
    expect(() => normalizedScore(answer, 5)).not.toThrow();
    expect(normalizedScore(answer, 5)).toBeCloseTo(0.75);
  });

  it('throws on a non-score answer', () => {
    expect(() => normalizedScore({ type: 'boolean', probability: 0.5 }, 5)).toThrow(/expected a "score" answer/);
  });
});

describe('probability', () => {
  it('reads P(true) directly off a boolean answer', () => {
    expect(probability({ type: 'boolean', probability: 0.82 })).toBe(0.82);
  });

  it('clamps out-of-range values into [0, 1]', () => {
    expect(probability({ type: 'boolean', probability: 1.4 })).toBe(1);
    expect(probability({ type: 'boolean', probability: -0.2 })).toBe(0);
  });

  it('throws on a non-boolean answer', () => {
    expect(() => probability({ type: 'score', score: 1 })).toThrow(/expected a "boolean" answer/);
  });

  it('does not require `probabilities` to be present on a choice answer it is never asked to read', () => {
    // Choice answers aren't used by any gate today, but the contract says
    // `probabilities` is optional there too -- confirm the type accepts it.
    const answer: Answer = { type: 'choice', choice: 'yes' };
    expect(answer.probabilities).toBeUndefined();
  });
});
