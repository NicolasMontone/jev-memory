import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inMemoryStore } from '../src/store/memory-store.js';
import { formatMemoriesForPrompt } from '../src/ai-sdk.js';
import type { Memory } from '../src/types.js';

const experimental_evaluate = vi.fn();
vi.mock('ai', () => ({ experimental_evaluate }));

const { createMemory } = await import('../src/memory.js');
const { selectSystemPrompt } = await import('../src/ai-sdk.js');

function makeMemory(id: string, text: string): Memory {
  return { id, text, createdAt: 0, updatedAt: 0, pinned: true };
}

beforeEach(() => {
  experimental_evaluate.mockReset();
});

describe('formatMemoriesForPrompt', () => {
  it('renders each memory verbatim as a bullet, under a default heading', () => {
    const prompt = formatMemoriesForPrompt([makeMemory('a', 'User prefers pnpm over npm')]);
    expect(prompt).toContain('User prefers pnpm over npm');
    expect(prompt.split('\n')).toHaveLength(2); // heading + one bullet
  });

  it('returns emptyText (default "") for no memories', () => {
    expect(formatMemoriesForPrompt([])).toBe('');
    expect(formatMemoriesForPrompt([], { emptyText: 'nothing yet' })).toBe('nothing yet');
  });

  it('never alters the fact text itself', () => {
    const text = 'Weird "quoted" text -- with -- dashes  and   spacing';
    const prompt = formatMemoriesForPrompt([makeMemory('a', text)]);
    expect(prompt).toContain(text);
  });
});

describe('selectSystemPrompt', () => {
  it('runs select() and formats the result into a prompt string', async () => {
    const store = inMemoryStore([makeMemory('p1', 'Always use TypeScript strict mode')]);
    const memory = createMemory({ store });

    const { prompt, result } = await selectSystemPrompt(memory, { state: 'current turn' });

    expect(experimental_evaluate).not.toHaveBeenCalled(); // pinned-only store
    expect(prompt).toContain('Always use TypeScript strict mode');
    expect(result.memories).toHaveLength(1);
  });
});
