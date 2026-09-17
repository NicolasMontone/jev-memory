import type { Memory } from './types.js';
import type { Question, Answer } from './evaluate-client.js';

/**
 * Ordered lowest-to-highest, as Jev's `score` question type requires.
 * Kept short and deliberately generic (not per-domain) so the same rubric
 * works for any kind of stored fact.
 */
export const RELEVANCE_LEVELS: readonly string[] = [
  'Irrelevant: nothing about this memory matters for the current state.',
  'Tangential: loosely related, but not something the agent needs to act on right now.',
  'Useful: would help produce a better response, but is not essential.',
  'Important: materially relevant to satisfying the current turn.',
  'Critical: directly needed to respond correctly to the current turn.',
];

/**
 * Write gate: a single boolean question asking whether `text` is durable
 * enough to keep in long-term memory. `state` is passed separately as the
 * shared `evaluate()` state (typically the conversation/turn context); the
 * candidate fact itself travels inside this one question's instructions.
 */
export function buildWriteQuestion(text: string): Record<string, Question> {
  return {
    durability: {
      type: 'boolean',
      instructions: {
        task:
          "Decide whether the candidate fact below is durable enough to store in an AI agent's " +
          'long-term memory, given the surrounding state/context.',
        candidateFact: text,
      },
      criteria: {
        true:
          'The fact is a stable, reusable preference, decision, constraint, or piece of knowledge ' +
          'about the user, project, or task that will likely still be true and useful across future, ' +
          'unrelated turns.',
        false:
          'The fact is transient, task-specific chatter, small talk, already obvious or generic, ' +
          'redundant with common defaults, or unlikely to still be true or useful later.',
      },
    },
  };
}

/**
 * Retrieve gate: one `score` question per memory, all sharing the current
 * turn's `state`. This is the call site where the "one round trip for N
 * memories" property matters most -- see `evaluateInChunks`.
 */
export function buildRetrieveQuestions(memories: readonly Memory[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const memory of memories) {
    questions[memory.id] = {
      type: 'score',
      instructions: {
        task:
          'Score how relevant this stored long-term memory is to the current state, for helping an ' +
          'AI agent respond well to the current turn.',
        memory: memory.text,
      },
      criteria: [...RELEVANCE_LEVELS],
    };
  }
  return questions;
}

/**
 * Evict gate: one boolean question per memory asking whether it is stale or
 * superseded given the current state.
 */
export function buildEvictQuestions(memories: readonly Memory[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const memory of memories) {
    questions[memory.id] = {
      type: 'boolean',
      instructions: {
        task:
          'Decide whether this stored long-term memory should be evicted because it is stale, ' +
          'contradicted, or superseded by the current state.',
        memory: memory.text,
      },
      criteria: {
        true:
          'The memory is stale, out of date, contradicted, or clearly superseded by newer information ' +
          'in the current state.',
        false:
          'The memory is still accurate and potentially useful; nothing in the current state ' +
          'contradicts or supersedes it.',
      },
    };
  }
  return questions;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Normalizes a `score` answer's fractional [0, levels-1] value to [0, 1]. */
export function normalizedScore(answer: Answer, levels: number): number {
  if (answer.type !== 'score') {
    throw new Error(`jev-memory: expected a "score" answer from the retrieve gate, got "${answer.type}"`);
  }
  const denom = levels - 1;
  if (denom <= 0) return 0;
  return clamp01(answer.score / denom);
}

/** Extracts P(true) from a `boolean` answer (write/evict gates). */
export function probability(answer: Answer): number {
  if (answer.type !== 'boolean') {
    throw new Error(`jev-memory: expected a "boolean" answer, got "${answer.type}"`);
  }
  return clamp01(answer.probability);
}
