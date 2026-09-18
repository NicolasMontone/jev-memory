import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/memory.js';
import { inMemoryStore } from '../src/store/memory-store.js';

// test/setup.ts unconditionally sets a fake AI_GATEWAY_API_KEY for every test
// file in this suite (so unit tests never hit assertAuthConfigured()). That
// fake key would silently shadow a real one here, so drop it and fall back to
// VERCEL_OIDC_TOKEN, which the fixture never touches.
if (process.env.AI_GATEWAY_API_KEY === 'test-gateway-key') {
  delete process.env.AI_GATEWAY_API_KEY;
}

const hasCreds = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);

describe.skipIf(!hasCreds)('live Jev call (AI Gateway)', () => {
  it('writes a durable fact through the real write gate', async () => {
    const memory = createMemory({ store: inMemoryStore() });
    const result = await memory.remember('The user is allergic to peanuts.', {
      state: { task: 'General assistant conversation.' },
    });
    expect(result.stored).toBe(true);
    expect(result.durability).toBeGreaterThan(0.5);
  }, 30_000);

  it('rejects an ephemeral, non-durable statement', async () => {
    const memory = createMemory({ store: inMemoryStore() });
    const result = await memory.remember('lol ok one sec', {
      state: { task: 'General assistant conversation.' },
    });
    expect(result.stored).toBe(false);
  }, 30_000);
});
