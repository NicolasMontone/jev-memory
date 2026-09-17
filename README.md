# jev-memory

An agent long-term-memory layer for the [Vercel AI SDK](https://ai-sdk.dev), backed by the
`typesafe-ai/jev` evaluation model via the Vercel AI Gateway.

It manages the full memory lifecycle through three gates. Every one of them is a **selection**
decision, never a generation -- so nothing is ever summarized, paraphrased or rewritten, and
nothing can be hallucinated into your memory store.

## The three gates

1. **Write gate** -- *"is this fact durable enough to store?"* Most memory systems store far too
   much junk because the write decision is made by the same LLM that is mid-task and feeling
   generous. This is the gate that matters most: a cheap, disinterested filter at write time is
   worth more than clever retrieval later, because retrieval can only ever rank what write already
   let through. Get write wrong and every later gate is scoring garbage.
2. **Retrieve gate** -- scores every stored fact against the current turn's state in **one round
   trip**, and returns the highest-value subset that fits a token budget.
3. **Evict gate** -- finds facts that are stale or superseded by the current state and drops them.
   This is context compaction, applied to long-term memory instead of a transcript.

## Verbatim, never rewritten

jev-memory stores, retrieves and evicts **exact strings**. No gate is a text-generation call; each
one asks Jev a `boolean`/`choice`/`score` question and gets back a probability, a choice, or a
score -- never new text. That means:

- What comes back from `select()` is byte-for-byte what you wrote with `remember()`.
- A memory can never quietly drift, get compressed into a lossy summary, or acquire details the
  original fact never had.
- The failure modes of summarization-based memory (hallucinated specifics, silently dropped
  nuance, unbounded compounding error across compactions) don't exist here, because the model is
  never in the text-authoring loop for a stored fact -- only in the loop for *deciding whether it
  should still exist*.

If you want summarized memory, put a summarizer in front of `remember()` yourself and pass its
output as the candidate fact. jev-memory will still refuse to alter it.

## Install

```sh
npm install jev-memory ai
```

`ai@^7.0.105` is a peer dependency -- `experimental_evaluate` (Jev's entry point) lives there.
jev-memory has no other runtime dependencies.

## Auth (two paths, handled entirely by the AI SDK)

jev-memory does **not** implement authentication. `experimental_evaluate` resolves the Jev model
through the AI SDK, which supports two credential sources:

1. **`AI_GATEWAY_API_KEY`** -- a long-lived key from the
   [Vercel AI Gateway dashboard](https://vercel.com/dashboard). Simplest for CI, scripts, and
   non-Vercel deployments.
2. **Vercel OIDC** -- if `AI_GATEWAY_API_KEY` isn't set, the SDK falls back to
   `getVercelOidcToken()`, which reads `VERCEL_OIDC_TOKEN`. Inside a Vercel-linked project, run
   `vercel env pull` to populate it. The token is short-lived (about 12h) and needs the same
   command to refresh.

Before spending a round trip, jev-memory checks that one of these is set and throws a clear error
if neither is -- so a missing credential fails fast with a useful message instead of a confusing
provider error three layers down.

## API

### `createMemory(options)`

```ts
import { createMemory, jsonFileStore } from 'jev-memory';

const memory = createMemory({
  store: jsonFileStore('./memories.json'),

  // All optional:
  model: 'typesafe-ai/jev',      // default
  maxQuestionsPerCall: 50,       // see "Why chunk at all?" below
  writeThreshold: 0.6,           // P(durable) required to store a fact
  evictThreshold: 0.6,           // P(should evict) required to drop a fact
  tokenEstimator: myTokenizer,   // default: ~4 chars/token heuristic
  maxRetries: 2,                 // forwarded to every evaluate() call
});
```

### `memory.remember(text, options)`

Runs the write gate on `text` and stores it verbatim if it passes.

```ts
const result = await memory.remember('User prefers pnpm over npm', {
  state: conversation, // string | JSONObject | JSONValue[] -- shared Jev state
});
// -> { stored: true, memory: {...}, durability: 0.91,
//      reason: 'Durability 0.91 >= write threshold 0.6.',
//      usage: { inputTokens, outputTokens, totalTokens, calls: 1 }, ms }
```

Pass `pin: true` to skip the gate (and the API call) entirely and store unconditionally:

```ts
await memory.remember('Never write to prod without a migration plan', { pin: true });
```

`RememberResult.reason` is always a deterministic string built from the threshold comparison --
never model-generated text.

### `memory.select(options)`

Runs the retrieve gate over **every** stored, non-pinned memory in a single `evaluate()` call (or
the minimum number of chunks -- see below), and returns the highest-scoring subset that fits
`tokenBudget`.

```ts
const { memories, scores, tokens, usage, ms, droppedForBudget } = await memory.select({
  state: currentTurn,
  tokenBudget: 800, // omit for "everything with score > 0", unbounded
});
```

- `memories` -- selected facts, verbatim, highest score first, pinned facts always included.
- `scores` -- normalized relevance in `[0, 1]` for **every** memory considered, including ones
  left out.
- `droppedForBudget` -- memories that scored above zero but didn't fit the budget, with their
  score and estimated token cost, so you can see what you're leaving on the table.
- `usage` / `ms` -- aggregated across every `evaluate()` call this made (zero calls if the store
  is empty or every memory is pinned).

Selection is **greedy by score-per-token density**, not top-K by raw score. Top-K can spend an
entire budget on one large, only-slightly-more-relevant memory; density-greedy tends to pack more
total relevance into a fixed budget, at the cost of not being a globally optimal knapsack solution
(that would need combinatorial search over stored facts on every turn, which doesn't scale).

### `memory.compact(options)`

Runs the evict gate over every non-pinned memory and removes the ones that fail it.

```ts
const { evicted, kept, evictionScores, usage, ms } = await memory.compact({ state: currentTurn });
```

Pinned memories are never evaluated and never evicted.

### Pinning

```ts
await memory.setPinned(id, true);  // never-evict, always-retrieve, no API call
await memory.setPinned(id, false); // back to normal gating
```

Pinning is a deterministic, local operation on the store -- it never calls Jev, either to set it
or to honor it later in `select()`/`compact()`.

### Other methods

```ts
await memory.forget(id);  // remove a memory unconditionally, no API call
await memory.list();      // every stored memory, verbatim
memory.store;             // the underlying MemoryStore, for direct access
```

## One round trip per gate

Jev answers every question in its `questions` map against one shared `state` in a single
provider call. jev-memory's entire retrieval and eviction architecture exists to exploit that:
scoring N stored memories for relevance is **one** `evaluate()` call with N questions, never N
separate calls.

### Why chunk at all above `maxQuestionsPerCall`?

Jev can, in principle, answer an arbitrary number of questions in one call. jev-memory still caps
a single call at `maxQuestionsPerCall` (default 50) because:

1. **Blast radius.** `evaluate()` retries the *whole* call on a transient failure
   (`maxRetries`, default 2). A smaller batch means a retry redoes less work, and a genuinely bad
   response only invalidates one chunk's worth of memories instead of your entire memory store.
2. **Bounded latency.** A single call's latency should stay roughly constant regardless of how
   large the memory store has grown -- which matters when `select()` sits on the hot path of
   answering a turn.
3. **Bounded request size.** Every question's `instructions`/`criteria` are tokens billed and
   transmitted on that one call; an unbounded batch turns one slow or oversized request into a
   single point of failure with no partial results.

Raise or lower it per `createMemory()` call, or per individual `select()`/`compact()` call, based
on your latency/cost/blast-radius tradeoff.

## The `MemoryStore` interface

Storage is fully independent of the Jev gating logic -- the gates only ever call these four
methods:

```ts
interface MemoryStore {
  list(): Promise<Memory[]> | Memory[];
  add(memory: Memory): Promise<void> | void;
  remove(id: string): Promise<void> | void;
  update(id: string, patch: Partial<Omit<Memory, 'id'>>): Promise<void> | void;
}
```

Two reference implementations ship in the package:

- **`inMemoryStore(initial?)`** -- non-persistent, for tests and short-lived processes.
- **`jsonFileStore(filePath)`** -- reads/writes a JSON array of `Memory` records to disk. Writes
  within one process are serialized and applied atomically (write-to-temp-then-rename); it is not
  a safe target for two processes writing concurrently.

Implement the interface yourself for Postgres, Redis, SQLite, a vector DB used purely as a K/V
store, etc. -- the gate logic in `memory.ts` never reaches into a store's internals.

## Token budgeting and the estimator

`select()`'s `tokenBudget` is enforced with a swappable estimator:

```ts
export type TokenEstimator = (text: string) => number;
```

The default, `estimateTokens`, is the ~4-characters-per-token heuristic -- cheap, dependency-free,
and good enough to keep a prompt roughly in budget. Swap in a real tokenizer (e.g. `tiktoken`, or
whatever the downstream model's provider exposes) via `tokenEstimator` on `createMemory()`:

```ts
import { encode } from 'some-tokenizer';

const memory = createMemory({
  store,
  tokenEstimator: (text) => encode(text).length,
});
```

## AI SDK integration example

```ts
import { generateText } from 'ai';
import { createMemory, jsonFileStore, selectSystemPrompt } from 'jev-memory';

const memory = createMemory({ store: jsonFileStore('./memories.json') });

async function answerTurn(conversation: string, userMessages: Array<{ role: string; content: string }>) {
  // 1. Retrieve gate: pull whatever's relevant to this turn into the system prompt.
  const { prompt: memoryBlock } = await selectSystemPrompt(memory, {
    state: conversation,
    tokenBudget: 800,
  });

  const { text } = await generateText({
    model: 'openai/gpt-4o',
    system: [
      'You are a helpful assistant.',
      memoryBlock, // '' when there's nothing relevant yet
    ].filter(Boolean).join('\n\n'),
    messages: userMessages,
  });

  // 2. Write gate: offer up whatever the turn revealed; let the gate decide
  //    what's actually worth keeping. (Extracting `candidateFacts` from the
  //    turn -- e.g. via your own generateObject call -- is up to you;
  //    jev-memory only judges durability, it doesn't extract facts.)
  for (const candidateFact of extractCandidateFacts(userMessages, text)) {
    await memory.remember(candidateFact, { state: conversation });
  }

  return text;
}

// Periodically (e.g. once a session, or on a schedule):
async function tidyMemory(conversation: string) {
  // 3. Evict gate: drop what's gone stale.
  await memory.compact({ state: conversation });
}
```

`selectSystemPrompt` is a thin convenience wrapper around `memory.select()` +
`formatMemoriesForPrompt()`; both are exported individually if you want more control over
formatting or want to log/telemetry the raw `SelectResult`.

## Engineering notes

- TypeScript, ESM, strict mode. Built with `tsup` to ESM + `.d.ts`.
- `ai` is a peer dependency; jev-memory has no other runtime dependencies.
- Unit tests (`vitest`) mock `experimental_evaluate` at the module boundary -- there is no network
  access to the AI Gateway in CI/dev for this package, so no test makes a live call.

```sh
npm install
npm run typecheck
npm test
npm run build
```
