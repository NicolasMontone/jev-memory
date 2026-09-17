import type { Memory, MemoryStore } from '../types.js';

/**
 * In-process, non-persistent reference store. Useful for tests, scripts, and
 * short-lived processes. State is lost on restart -- use `jsonFileStore` (or
 * your own `MemoryStore`) for anything that needs to survive one.
 */
export function inMemoryStore(initial: Memory[] = []): MemoryStore {
  const byId = new Map<string, Memory>(initial.map((m) => [m.id, m]));

  return {
    list(): Memory[] {
      return Array.from(byId.values());
    },
    add(memory: Memory): void {
      if (byId.has(memory.id)) {
        throw new Error(`inMemoryStore: memory with id "${memory.id}" already exists`);
      }
      byId.set(memory.id, memory);
    },
    remove(id: string): void {
      byId.delete(id);
    },
    update(id: string, patch: Partial<Omit<Memory, 'id'>>): void {
      const existing = byId.get(id);
      if (!existing) return;
      byId.set(id, { ...existing, ...patch });
    },
  };
}
