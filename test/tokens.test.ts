import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up and never estimates a non-empty string as 0 tokens', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
  });

  it('uses roughly 4 characters per token', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('a'.repeat(41))).toBe(11);
  });

  it('is a pure function of length only (swap-in point for a real tokenizer)', () => {
    const a = estimateTokens('xxxxxxxx');
    const b = estimateTokens('yyyyyyyy');
    expect(a).toBe(b);
  });
});
