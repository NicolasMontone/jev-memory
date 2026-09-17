import { randomUUID } from 'node:crypto';
import type { Experimental_EvaluationModel } from 'ai';
import type {
  AggregatedUsage,
  CompactResult,
  JevState,
  Memory,
  MemoryStore,
  RememberResult,
  SelectResult,
} from './types.js';
import type { TokenEstimator } from './tokens.js';
import { estimateTokens } from './tokens.js';
import { evaluateInChunks } from './evaluate-client.js';
import {
  RELEVANCE_LEVELS,
  buildEvictQuestions,
  buildRetrieveQuestions,
  buildWriteQuestion,
  normalizedScore,
  probability,
} from './gates.js';
import { selectWithinBudget, type BudgetCandidate } from './budget.js';

/** The default Jev model id, resolved through the Vercel AI Gateway. */
export const DEFAULT_MODEL: Experimental_EvaluationModel = 'typesafe-ai/jev';

const ZERO_USAGE: AggregatedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };

export interface CreateMemoryOptions {
  /** Where memories are persisted. See `inMemoryStore` / `jsonFileStore`. */
  store: MemoryStore;
  /** Jev model id or instance. Defaults to `'typesafe-ai/jev'`. */
  model?: Experimental_EvaluationModel;
  /**
   * Ceiling on questions per `evaluate()` call before jev-memory splits into
   * multiple round trips. See the doc comment on `evaluateInChunks` for why
   * this exists. Default 50.
   */
  maxQuestionsPerCall?: number;
  /** Swappable token cost estimator for budget-aware `select()`. Default `estimateTokens` (~4 chars/token). */
  tokenEstimator?: TokenEstimator;
  /** Minimum P(durable) from the write gate required to store a fact. Default 0.6. */
  writeThreshold?: number;
  /** Minimum P(should evict) from the evict gate required to drop a fact. Default 0.6. */
  evictThreshold?: number;
  /** Id generator for new memories. Default `crypto.randomUUID`. */
  idGenerator?: () => string;
  /** Clock, overridable for tests. Default `Date.now`. */
  now?: () => number;
  /** Forwarded to every `evaluate()` call. Default 2 (the AI SDK's own default). */
  maxRetries?: number;
}

export interface RememberOptions {
  /** The current turn/conversation state Jev evaluates the candidate fact against. Ignored when `pin: true`. */
  state?: JevState;
  /** Store the fact unconditionally, bypassing the write gate (and any API call) entirely. */
  pin?: boolean;
  /** Explicit id; default is a random UUID. */
  id?: string;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export interface SelectOptions {
  /** The current turn's state, scored against every stored memory. */
  state: JevState;
  /** Max total estimated tokens the returned memories may cost. Default: unbounded. */
  tokenBudget?: number;
  /** Overrides `createMemory`'s `maxQuestionsPerCall` for this call only. */
  maxQuestionsPerCall?: number;
  abortSignal?: AbortSignal;
}

export interface CompactOptions {
  /** The current state used to judge staleness. */
  state: JevState;
  maxQuestionsPerCall?: number;
  abortSignal?: AbortSignal;
}

export interface JevMemory {
  /** Runs the write gate and, if it passes (or `pin: true`), stores `text` verbatim. */
  remember(text: string, options?: RememberOptions): Promise<RememberResult>;
  /** Runs the retrieve gate over every stored memory in one round trip and returns the budget-fitting subset. */
  select(options: SelectOptions): Promise<SelectResult>;
  /** Runs the evict gate over every non-pinned memory and removes the ones that fail it. */
  compact(options: CompactOptions): Promise<CompactResult>;
  /** Deterministically flips a memory's pinned flag. No API call. */
  setPinned(id: string, pinned: boolean): Promise<void>;
  /** Removes a memory unconditionally. No API call. */
  forget(id: string): Promise<void>;
  /** Lists every stored memory verbatim. */
  list(): Promise<Memory[]>;
  /** The underlying store, for callers that need direct access. */
  readonly store: MemoryStore;
}

export function createMemory(options: CreateMemoryOptions): JevMemory {
  const {
    store,
    model = DEFAULT_MODEL,
    maxQuestionsPerCall: defaultMaxQuestionsPerCall = 50,
    tokenEstimator = estimateTokens,
    writeThreshold = 0.6,
    evictThreshold = 0.6,
    idGenerator = randomUUID,
    now = Date.now,
    maxRetries,
  } = options;

  async function remember(text: string, opts: RememberOptions = {}): Promise<RememberResult> {
    const start = nowMs();
    const timestamp = now();
    const id = opts.id ?? idGenerator();

    if (opts.pin) {
      const memory: Memory = {
        id,
        text,
        createdAt: timestamp,
        updatedAt: timestamp,
        pinned: true,
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      };
      await store.add(memory);
      return {
        stored: true,
        memory,
        durability: 1,
        reason: 'Pinned at write time; the write gate was bypassed entirely.',
        usage: { ...ZERO_USAGE },
        ms: nowMs() - start,
      };
    }

    if (opts.state === undefined) {
      throw new Error('jev-memory: remember() requires `state` unless `pin: true` is set.');
    }

    const questions = buildWriteQuestion(text);
    const { answers, usage } = await evaluateInChunks(questions, opts.state, {
      model,
      maxQuestionsPerCall: defaultMaxQuestionsPerCall,
      abortSignal: opts.abortSignal,
      maxRetries,
    });

    const durabilityAnswer = answers.durability;
    if (!durabilityAnswer) {
      throw new Error('jev-memory: write gate returned no answer for the durability question.');
    }
    const durability = probability(durabilityAnswer);
    const stored = durability >= writeThreshold;

    let memory: Memory | undefined;
    if (stored) {
      memory = {
        id,
        text,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      };
      await store.add(memory);
    }

    return {
      stored,
      ...(memory ? { memory } : {}),
      durability,
      reason: stored
        ? `Durability ${durability.toFixed(2)} >= write threshold ${writeThreshold}.`
        : `Durability ${durability.toFixed(2)} < write threshold ${writeThreshold}; not stored.`,
      usage,
      ms: nowMs() - start,
    };
  }

  async function select(opts: SelectOptions): Promise<SelectResult> {
    const start = nowMs();
    const tokenBudget = opts.tokenBudget ?? Number.POSITIVE_INFINITY;
    const all = await store.list();
    const pinned = all.filter((m) => m.pinned);
    const unpinned = all.filter((m) => !m.pinned);

    let usage: AggregatedUsage = { ...ZERO_USAGE };
    const scores: Record<string, number> = {};
    for (const m of pinned) scores[m.id] = 1;

    const candidates: BudgetCandidate[] = pinned.map((memory) => ({ memory, score: 1, pinned: true }));

    if (unpinned.length > 0) {
      const questions = buildRetrieveQuestions(unpinned);
      const result = await evaluateInChunks(questions, opts.state, {
        model,
        maxQuestionsPerCall: opts.maxQuestionsPerCall ?? defaultMaxQuestionsPerCall,
        abortSignal: opts.abortSignal,
        maxRetries,
      });
      usage = result.usage;

      for (const memory of unpinned) {
        const answer = result.answers[memory.id];
        const score = answer ? normalizedScore(answer, RELEVANCE_LEVELS.length) : 0;
        scores[memory.id] = score;
        candidates.push({ memory, score, pinned: false });
      }
    }

    const { selected, droppedForBudget, tokens } = selectWithinBudget(candidates, tokenBudget, tokenEstimator);

    const memories = selected.slice().sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0));

    return {
      memories,
      scores,
      tokens,
      usage,
      ms: nowMs() - start,
      droppedForBudget,
    };
  }

  async function compact(opts: CompactOptions): Promise<CompactResult> {
    const start = nowMs();
    const all = await store.list();
    const pinned = all.filter((m) => m.pinned);
    const unpinned = all.filter((m) => !m.pinned);

    if (unpinned.length === 0) {
      return {
        evicted: [],
        kept: pinned,
        evictionScores: {},
        usage: { ...ZERO_USAGE },
        ms: nowMs() - start,
      };
    }

    const questions = buildEvictQuestions(unpinned);
    const { answers, usage } = await evaluateInChunks(questions, opts.state, {
      model,
      maxQuestionsPerCall: opts.maxQuestionsPerCall ?? defaultMaxQuestionsPerCall,
      abortSignal: opts.abortSignal,
      maxRetries,
    });

    const evictionScores: Record<string, number> = {};
    const evicted: Memory[] = [];
    const kept: Memory[] = [...pinned];

    for (const memory of unpinned) {
      const answer = answers[memory.id];
      const p = answer ? probability(answer) : 0;
      evictionScores[memory.id] = p;
      if (p >= evictThreshold) {
        evicted.push(memory);
      } else {
        kept.push(memory);
      }
    }

    for (const memory of evicted) {
      await store.remove(memory.id);
    }

    return { evicted, kept, evictionScores, usage, ms: nowMs() - start };
  }

  async function setPinned(id: string, pinned: boolean): Promise<void> {
    await store.update(id, { pinned, updatedAt: now() });
  }

  async function forget(id: string): Promise<void> {
    await store.remove(id);
  }

  async function list(): Promise<Memory[]> {
    return store.list();
  }

  return { remember, select, compact, setPinned, forget, list, store };
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
