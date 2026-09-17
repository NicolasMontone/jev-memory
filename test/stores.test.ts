import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inMemoryStore } from '../src/store/memory-store.js';
import { jsonFileStore } from '../src/store/json-file-store.js';
import type { Memory, MemoryStore } from '../src/types.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? 'mem-1',
    text: overrides.text ?? 'User prefers pnpm over npm',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    ...(overrides.pinned !== undefined ? { pinned: overrides.pinned } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

async function roundTrip(store: MemoryStore) {
  expect(await store.list()).toEqual([]);

  const memory = makeMemory();
  await store.add(memory);
  expect(await store.list()).toEqual([memory]);

  await store.update(memory.id, { pinned: true, updatedAt: 2 });
  const afterUpdate = await store.list();
  expect(afterUpdate).toHaveLength(1);
  expect(afterUpdate[0]).toMatchObject({ id: memory.id, pinned: true, updatedAt: 2 });

  // Updating a missing id is a no-op, not a throw (works whether the store
  // implementation is sync or async).
  await store.update('does-not-exist', { pinned: true });

  await store.remove(memory.id);
  expect(await store.list()).toEqual([]);

  // Removing a missing id is a no-op, not a throw.
  await store.remove('does-not-exist');
}

/** Asserts `fn` throws or rejects, regardless of whether the store is sync or async. */
async function expectToReject(fn: () => unknown, pattern: RegExp): Promise<void> {
  await expect(async () => {
    await fn();
  }).rejects.toThrow(pattern);
}

describe('inMemoryStore', () => {
  it('round-trips add/list/update/remove', async () => {
    await roundTrip(inMemoryStore());
  });

  it('rejects adding a duplicate id', async () => {
    const store = inMemoryStore();
    await store.add(makeMemory({ id: 'dup' }));
    await expectToReject(() => store.add(makeMemory({ id: 'dup' })), /already exists/);
  });

  it('accepts seed data', async () => {
    const seed = makeMemory({ id: 'seed-1' });
    const store = inMemoryStore([seed]);
    expect(await store.list()).toEqual([seed]);
  });
});

describe('jsonFileStore', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips add/list/update/remove, persisted as JSON on disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-memory-test-'));
    const filePath = join(dir, 'nested', 'memories.json');
    const store = jsonFileStore(filePath);
    await roundTrip(store);
  });

  it('rejects adding a duplicate id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-memory-test-'));
    const store = jsonFileStore(join(dir, 'memories.json'));
    await store.add(makeMemory({ id: 'dup' }));
    await expectToReject(() => store.add(makeMemory({ id: 'dup' })), /already exists/);
  });

  it('starts empty when the file does not exist yet', async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-memory-test-'));
    const store = jsonFileStore(join(dir, 'does-not-exist.json'));
    expect(await store.list()).toEqual([]);
  });

  it('a second store instance pointed at the same file sees writes from the first', async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-memory-test-'));
    const filePath = join(dir, 'memories.json');
    const storeA = jsonFileStore(filePath);
    const storeB = jsonFileStore(filePath);

    await storeA.add(makeMemory({ id: 'shared' }));
    expect(await storeB.list()).toEqual([makeMemory({ id: 'shared' })]);
  });
});
