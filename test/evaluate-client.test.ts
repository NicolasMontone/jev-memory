import { beforeEach, describe, expect, it, vi } from 'vitest';

const experimental_evaluate = vi.fn();
vi.mock('ai', () => ({ experimental_evaluate }));

// Imported after the mock so the module under test picks up the mocked `ai`.
const { evaluateInChunks } = await import('../src/evaluate-client.js');

function mockAnswersFor(ids: string[]) {
  return {
    answers: Object.fromEntries(ids.map((id, i) => [id, { type: 'boolean', probability: i / Math.max(1, ids.length - 1) }])),
    usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
    warnings: [],
    rounding: undefined,
    providerMetadata: undefined,
    response: { timestamp: new Date(), modelId: 'typesafe-ai/jev' },
  };
}

function question(): { type: 'boolean'; instructions: string } {
  return { type: 'boolean', instructions: 'is this durable?' };
}

beforeEach(() => {
  experimental_evaluate.mockReset();
});

describe('evaluateInChunks', () => {
  it('makes zero evaluate() calls (and never checks auth) for an empty question set', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    try {
      const { answers, usage } = await evaluateInChunks({}, 'state', {
        model: 'typesafe-ai/jev',
        maxQuestionsPerCall: 50,
      });
      expect(experimental_evaluate).not.toHaveBeenCalled();
      expect(answers).toEqual({});
      expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 });
    } finally {
      process.env.AI_GATEWAY_API_KEY = 'test-gateway-key';
    }
  });

  it('throws a clear error when neither auth env var is set and there is work to do', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    try {
      await expect(
        evaluateInChunks({ q1: question() }, 'state', { model: 'typesafe-ai/jev', maxQuestionsPerCall: 50 }),
      ).rejects.toThrow(/AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN/);
      expect(experimental_evaluate).not.toHaveBeenCalled();
    } finally {
      process.env.AI_GATEWAY_API_KEY = 'test-gateway-key';
    }
  });

  it('resolves via VERCEL_OIDC_TOKEN when AI_GATEWAY_API_KEY is absent', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.VERCEL_OIDC_TOKEN = 'fake-oidc-token';
    experimental_evaluate.mockResolvedValueOnce(mockAnswersFor(['q1']));
    try {
      await expect(
        evaluateInChunks({ q1: question() }, 'state', { model: 'typesafe-ai/jev', maxQuestionsPerCall: 50 }),
      ).resolves.toBeDefined();
      expect(experimental_evaluate).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.VERCEL_OIDC_TOKEN;
      process.env.AI_GATEWAY_API_KEY = 'test-gateway-key';
    }
  });

  it('sends N questions in exactly ONE evaluate() call when N <= maxQuestionsPerCall', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `mem-${i}`);
    const questions = Object.fromEntries(ids.map((id) => [id, question()]));
    experimental_evaluate.mockResolvedValueOnce(mockAnswersFor(ids));

    const { answers, usage } = await evaluateInChunks(questions, 'shared state', {
      model: 'typesafe-ai/jev',
      maxQuestionsPerCall: 50,
    });

    expect(experimental_evaluate).toHaveBeenCalledTimes(1);
    const callArgs = experimental_evaluate.mock.calls[0]![0];
    expect(Object.keys(callArgs.questions)).toHaveLength(12);
    expect(callArgs.state).toBe('shared state');
    expect(Object.keys(answers)).toHaveLength(12);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 1, totalTokens: 11, calls: 1 });
  });

  it('chunks into multiple calls above maxQuestionsPerCall, and merges answers + usage', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `mem-${i}`);
    const questions = Object.fromEntries(ids.map((id) => [id, question()]));

    experimental_evaluate.mockImplementation(async ({ questions: chunkQuestions }: { questions: Record<string, unknown> }) => {
      return mockAnswersFor(Object.keys(chunkQuestions));
    });

    const { answers, usage } = await evaluateInChunks(questions, 'state', {
      model: 'typesafe-ai/jev',
      maxQuestionsPerCall: 2,
    });

    // 5 questions at 2 per call -> 3 calls (2, 2, 1).
    expect(experimental_evaluate).toHaveBeenCalledTimes(3);
    const sizes = experimental_evaluate.mock.calls.map(
      (call: unknown[]) => Object.keys((call[0] as { questions: Record<string, unknown> }).questions).length,
    );
    expect(sizes.sort()).toEqual([1, 2, 2]);

    expect(Object.keys(answers).sort()).toEqual(ids.slice().sort());
    // Usage is summed across all 3 calls (10 input tokens each).
    expect(usage).toEqual({ inputTokens: 30, outputTokens: 3, totalTokens: 33, calls: 3 });
  });

  it('never splits below 1 question per call and rejects a non-positive limit', async () => {
    await expect(
      evaluateInChunks({ q1: question() }, 'state', { model: 'typesafe-ai/jev', maxQuestionsPerCall: 0 }),
    ).rejects.toThrow(/maxQuestionsPerCall/);
  });
});
