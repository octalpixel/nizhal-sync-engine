import type { StorageAdapter } from "@tanstack/offline-transactions";

export function createMemoryStorage(prefix = "echo-offline:"): StorageAdapter {
  const store = new Map<string, string>();
  const key = (k: string) => `${prefix}${k}`;
  return {
    async get(k) {
      return store.get(key(k)) ?? null;
    },
    async set(k, value) {
      store.set(key(k), value);
    },
    async delete(k) {
      store.delete(key(k));
    },
    async keys() {
      return [...store.keys()].map((k) => k.slice(prefix.length));
    },
    async clear() {
      for (const k of [...store.keys()]) {
        if (k.startsWith(prefix)) store.delete(k);
      }
    },
  };
}
