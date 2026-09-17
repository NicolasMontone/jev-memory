import {
  experimental_evaluate,
  type Experimental_EvaluationQuestion,
  type Experimental_EvaluationModel,
} from 'ai';
import type { AggregatedUsage, JevState } from './types.js';
import { assertAuthConfigured } from './env.js';

/** Re-exported verbatim from `ai` -- see the Jev API contract in the README. */
export type Question = Experimental_EvaluationQuestion;

export interface BooleanAnswer {
  type: 'boolean';
  probability: number;
}
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities?: Record<string, number>;
}
export type Answer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;

export interface EvaluateInChunksOptions {
  model: Experimental_EvaluationModel;
  /**
   * Maximum number of questions sent in a single `evaluate()` call.
   *
   * Jev supports arbitrarily many questions in one round trip in principle,
   * but jev-memory still caps it, because:
   *   1. Every question's instructions/criteria are tokens billed on that one
   *      call; an unbounded batch turns one slow/expensive request into a
   *      single point of failure with no partial results.
   *   2. `evaluate()` retries the WHOLE call on a transient provider error
   *      (`maxRetries`, default 2) -- a smaller batch means a retry re-does
   *      less work and a genuinely bad response only invalidates one chunk's
   *      worth of memories, not the entire retrieval/eviction pass.
   *   3. It keeps a single call's latency roughly bounded regardless of how
   *      large the memory store has grown, which matters for anything on the
   *      hot path of answering a turn (i.e. `select()`).
   * Override via `maxQuestionsPerCall` on `createMemory()` or per call.
   */
  maxQuestionsPerCall: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}

export interface EvaluateInChunksResult {
  answers: Record<string, Answer>;
  usage: AggregatedUsage;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('jev-memory: maxQuestionsPerCall must be >= 1');
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Runs one `evaluate()` call per chunk of at most `maxQuestionsPerCall`
 * questions, all against the same shared `state`, and merges the answers and
 * usage back together. Makes zero calls (and never touches auth) when
 * `questions` is empty -- callers rely on that to keep pinned-only or
 * empty-store paths fully deterministic and offline.
 */
export async function evaluateInChunks(
  questions: Record<string, Question>,
  state: JevState,
  options: EvaluateInChunksOptions,
): Promise<EvaluateInChunksResult> {
  const ids = Object.keys(questions);
  const usage: AggregatedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
  const answers: Record<string, Answer> = {};

  if (ids.length === 0) {
    return { answers, usage };
  }

  assertAuthConfigured();

  const idChunks = chunk(ids, options.maxQuestionsPerCall);

  for (const idChunk of idChunks) {
    const chunkQuestions: Record<string, Question> = {};
    for (const id of idChunk) {
      chunkQuestions[id] = questions[id] as Question;
    }

    const result = await experimental_evaluate({
      model: options.model,
      state,
      questions: chunkQuestions,
      abortSignal: options.abortSignal,
      maxRetries: options.maxRetries,
    });

    usage.calls += 1;
    usage.inputTokens += result.usage.inputTokens ?? 0;
    usage.outputTokens += result.usage.outputTokens ?? 0;
    usage.totalTokens += result.usage.totalTokens ?? 0;

    for (const id of idChunk) {
      answers[id] = result.answers[id] as unknown as Answer;
    }
  }

  return { answers, usage };
}
