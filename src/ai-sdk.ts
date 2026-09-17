import type { Memory, SelectResult } from './types.js';
import type { JevMemory, SelectOptions } from './memory.js';

export interface FormatMemoriesOptions {
  /** Heading line placed above the bullet list. Pass `''` to omit it. */
  heading?: string;
  /** Returned when there is nothing to show. Default `''`. */
  emptyText?: string;
}

const DEFAULT_HEADING = 'What you remember about this user/task (verbatim, do not contradict without reason):';

/**
 * Renders selected memories into a system-prompt-ready block. Every line is
 * the stored fact's exact text -- nothing here paraphrases or reformats the
 * fact itself, only the list wrapper around it.
 */
export function formatMemoriesForPrompt(memories: readonly Memory[], options: FormatMemoriesOptions = {}): string {
  if (memories.length === 0) return options.emptyText ?? '';
  const heading = options.heading ?? DEFAULT_HEADING;
  const lines = memories.map((m) => `- ${m.text}`);
  return heading ? [heading, ...lines].join('\n') : lines.join('\n');
}

export interface SelectSystemPromptResult {
  /** Ready to append to (or use as) a `system` prompt for `generateText`/`streamText`. */
  prompt: string;
  /** The full `select()` result, for logging/telemetry. */
  result: SelectResult;
}

/**
 * Convenience wrapper for the most common AI SDK integration: run the
 * retrieve gate for the current turn and get back a system-prompt-ready
 * string in one call.
 *
 * ```ts
 * const memory = createMemory({ store: jsonFileStore('./memories.json') });
 *
 * const { prompt } = await selectSystemPrompt(memory, {
 *   state: conversation,
 *   tokenBudget: 800,
 * });
 *
 * const { text } = await generateText({
 *   model: 'openai/gpt-4o',
 *   system: [baseSystemPrompt, prompt].filter(Boolean).join('\n\n'),
 *   messages: conversation,
 * });
 *
 * // After the turn, decide what (if anything) is worth remembering and let
 * // the write gate filter it -- see the README for the full example.
 * await memory.remember(candidateFact, { state: conversation });
 * ```
 */
export async function selectSystemPrompt(
  memory: JevMemory,
  options: SelectOptions & FormatMemoriesOptions,
): Promise<SelectSystemPromptResult> {
  const { heading, emptyText, ...selectOptions } = options;
  const result = await memory.select(selectOptions);
  return {
    prompt: formatMemoriesForPrompt(result.memories, { ...(heading !== undefined ? { heading } : {}), ...(emptyText !== undefined ? { emptyText } : {}) }),
    result,
  };
}
