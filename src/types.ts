/**
 * Core types for jev-memory.
 *
 * Nothing in this file talks to Jev or the AI SDK -- it describes the data
 * model only, so storage concerns stay fully independent of the evaluation
 * logic in `gates.ts` / `memory.ts`.
 */

/** JSON-serializable value, matching the shape Jev's `state`/`Input` accept. */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type JSONObject = { [key: string]: JSONValue };

/**
 * The state Jev evaluates against for a given call: a conversation transcript,
 * a structured object describing the current turn, or a list of turns/messages.
 * This mirrors Jev's `state` parameter exactly (string | JSONObject | JSONValue[]).
 */
export type JevState = string | JSONObject | JSONValue[];

/**
 * A single durable fact in long-term memory.
 *
 * `text` is the ONLY thing ever written to, read from, or removed from
 * storage. jev-memory never asks a model to summarize, paraphrase or
 * rewrite it -- see the README's "verbatim, never rewritten" section for
 * why that matters. Every operation in this package either keeps `text`
 * byte-for-byte identical or deletes the whole record.
 */
export interface Memory {
  /** Stable identifier, unique within a store. */
  id: string;
  /** The verbatim fact text. Never summarized, paraphrased, or edited in place. */
  text: string;
  /** Unix ms timestamp when the memory was first stored. */
  createdAt: number;
  /** Unix ms timestamp when the memory record was last touched (pin toggle, metadata patch, etc). Never bumped by a rewrite of `text`, because that never happens. */
  updatedAt: number;
  /**
   * Pinned memories are deterministic: they always bypass the retrieve gate
   * (always included in `select()` results, subject to budget accounting)
   * and always bypass the evict gate (never dropped by `compact()`). No
   * Jev call is made for a pinned memory in either path.
   */
  pinned?: boolean;
  /** Free-form caller metadata (e.g. source turn id, tags). Not sent to Jev. */
  metadata?: Record<string, unknown>;
}

/** Fields a caller may set when writing a new memory; the rest are derived. */
export type NewMemoryInput = Pick<Memory, 'text'> &
  Partial<Pick<Memory, 'id' | 'pinned' | 'metadata'>>;

/**
 * Pluggable persistence for memories. Implementations may be sync or async;
 * `createMemory` awaits every call. The Jev gate logic never reaches into a
 * store's internals -- it only ever calls these four methods.
 */
export interface MemoryStore {
  /** Return every memory currently in the store. */
  list(): Promise<Memory[]> | Memory[];
  /** Insert a new memory. Implementations should reject a duplicate id. */
  add(memory: Memory): Promise<void> | void;
  /** Remove a memory by id. A missing id should be a no-op, not a throw. */
  remove(id: string): Promise<void> | void;
  /** Merge `patch` into the memory with `id` (e.g. to flip `pinned`). */
  update(id: string, patch: Partial<Omit<Memory, 'id'>>): Promise<void> | void;
}

/** Usage accounting, aggregated across every `evaluate()` call a gate made (zero calls -> all zero). */
export interface AggregatedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of `evaluate()` round trips actually made (0 when a gate short-circuited, e.g. no unpinned candidates). */
  calls: number;
}

export interface RememberResult {
  /** Whether the fact passed the write gate and was persisted. */
  stored: boolean;
  /** The memory record, present only when `stored` is true. */
  memory?: Memory;
  /** P(durable) from the write gate's boolean question, in [0, 1]. 1 when `pin: true` bypassed the gate. */
  durability: number;
  /** Deterministic, non-generated explanation of the decision (never model-authored text). */
  reason: string;
  /** Usage for the (at most one) `evaluate()` call this made. */
  usage: AggregatedUsage;
  ms: number;
}

export interface ScoredDrop {
  memory: Memory;
  /** Normalized relevance score in [0, 1] that this memory received. */
  score: number;
  /** Estimated token cost, per the configured estimator. */
  tokens: number;
}

export interface SelectResult {
  /** Memories selected for this turn, highest score first (pinned facts included). */
  memories: Memory[];
  /** Normalized relevance score in [0, 1] for every memory considered (including dropped ones). */
  scores: Record<string, number>;
  /** Estimated token cost per memory id, per the configured estimator. */
  tokens: Record<string, number>;
  usage: AggregatedUsage;
  ms: number;
  /** Memories that scored above zero relevance but were left out to respect `tokenBudget`. */
  droppedForBudget: ScoredDrop[];
}

export interface CompactResult {
  evicted: Memory[];
  kept: Memory[];
  /** P(should evict) for every non-pinned memory that was evaluated. */
  evictionScores: Record<string, number>;
  usage: AggregatedUsage;
  ms: number;
}
