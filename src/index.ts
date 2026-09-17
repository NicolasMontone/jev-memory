export type {
  JSONValue,
  JSONObject,
  JevState,
  Memory,
  NewMemoryInput,
  MemoryStore,
  AggregatedUsage,
  RememberResult,
  ScoredDrop,
  SelectResult,
  CompactResult,
} from './types.js';

export { estimateTokens, type TokenEstimator } from './tokens.js';

export { inMemoryStore } from './store/memory-store.js';
export { jsonFileStore } from './store/json-file-store.js';

export {
  createMemory,
  DEFAULT_MODEL,
  type CreateMemoryOptions,
  type RememberOptions,
  type SelectOptions,
  type CompactOptions,
  type JevMemory,
} from './memory.js';

export {
  formatMemoriesForPrompt,
  selectSystemPrompt,
  type FormatMemoriesOptions,
  type SelectSystemPromptResult,
} from './ai-sdk.js';

// Advanced/testing surface: the gate question builders and the chunking
// evaluate wrapper, exposed for callers who want to build their own
// orchestration on top of jev-memory's primitives.
export {
  RELEVANCE_LEVELS,
  buildWriteQuestion,
  buildRetrieveQuestions,
  buildEvictQuestions,
  normalizedScore,
  probability,
} from './gates.js';
export { evaluateInChunks, type Question, type Answer } from './evaluate-client.js';
export { selectWithinBudget, type BudgetCandidate, type BudgetSelection } from './budget.js';
