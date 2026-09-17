import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Memory, MemoryStore } from '../types.js';

/**
 * Reads/writes an array of `Memory` records to a single JSON file. Suitable
 * for local scripts, CLIs, and single-process servers. It is NOT a
 * concurrent-writer-safe database: writes within one process are serialized
 * (see `queue` below) but two separate processes racing on the same path can
 * still clobber each other. Reach for a real database-backed `MemoryStore`
 * if you need that.
 */
export function jsonFileStore(filePath: string): MemoryStore {
  // Serializes reads/writes within this process so concurrent calls (e.g.
  // `remember()` and `compact()` overlapping) don't interleave file writes.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    // Swallow rejections in the chain itself so one failed op doesn't wedge
    // the queue for everyone after it; the caller's own promise still rejects.
    queue = result.catch(() => undefined);
    return result;
  };

  async function readAll(): Promise<Memory[]> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      if (raw.trim() === '') return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`jsonFileStore: expected an array in ${filePath}, got ${typeof parsed}`);
      }
      return parsed as Memory[];
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async function writeAll(memories: Memory[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(memories, null, 2), 'utf-8');
    await rename(tmpPath, filePath);
  }

  return {
    list(): Promise<Memory[]> {
      return enqueue(readAll);
    },
    add(memory: Memory): Promise<void> {
      return enqueue(async () => {
        const memories = await readAll();
        if (memories.some((m) => m.id === memory.id)) {
          throw new Error(`jsonFileStore: memory with id "${memory.id}" already exists`);
        }
        memories.push(memory);
        await writeAll(memories);
      });
    },
    remove(id: string): Promise<void> {
      return enqueue(async () => {
        const memories = await readAll();
        await writeAll(memories.filter((m) => m.id !== id));
      });
    },
    update(id: string, patch: Partial<Omit<Memory, 'id'>>): Promise<void> {
      return enqueue(async () => {
        const memories = await readAll();
        const index = memories.findIndex((m) => m.id === id);
        if (index === -1) return;
        const existing = memories[index] as Memory;
        memories[index] = { ...existing, ...patch };
        await writeAll(memories);
      });
    },
  };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
