import type { StorageAdapter } from "@tanstack/offline-transactions";
import type { NizhalCoordinator, NizhalOnlineGate } from "./client-group.js";
import type { MutationIdStorage } from "./mutation-id.js";

// Production NizhalCoordinator for the browser: the Web Locks API elects exactly one leader across tabs
// (the tab holding the exclusive lock — the browser hands it to a waiting tab when the holder closes),
// and BroadcastChannel carries the cross-tab "write enqueued" signal so the leader re-scans the shared
// outbox even when a follower tab made the write. Requires navigator.locks + BroadcastChannel.
export function browserCoordinator(groupName: string): NizhalCoordinator & { dispose(): void } {
  const channel = new BroadcastChannel(`nizhal-cg:${groupName}`);
  const writeListeners = new Set<() => void>();
  const leaderListeners = new Set<(isLeader: boolean) => void>();
  let isLeaderState = false;
  let releaseLock: (() => void) | undefined;

  channel.onmessage = (event) => {
    if (event.data === "write") for (const listener of [...writeListeners]) listener();
  };

  // Hold the exclusive lock for this tab's lifetime; the callback stays pending (never resolves) so the
  // lock is retained until the tab closes or dispose() releases it — at which point a waiting tab wins.
  void navigator.locks.request(
    `nizhal-cg-leader:${groupName}`,
    { mode: "exclusive" },
    () =>
      new Promise<void>((resolve) => {
        releaseLock = resolve;
        isLeaderState = true;
        for (const listener of [...leaderListeners]) listener(true);
      }),
  );

  return {
    isLeader: () => isLeaderState,
    onLeadershipChange: (listener) => {
      leaderListeners.add(listener);
      return () => leaderListeners.delete(listener);
    },
    signalWrite: () => channel.postMessage("write"),
    onWriteSignal: (listener) => {
      writeListeners.add(listener);
      return () => writeListeners.delete(listener);
    },
    dispose: () => {
      releaseLock?.();
      channel.close();
    },
  };
}

/** Online gate over the browser's connectivity events. */
export function browserOnlineGate(): NizhalOnlineGate {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  globalThis.addEventListener?.("online", notify);
  globalThis.addEventListener?.("offline", notify);
  return {
    isOnline: () => globalThis.navigator?.onLine ?? true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * A `localStorage`-backed StorageAdapter — same-origin tabs share it natively, so it is a valid shared
 * cross-tab outbox for the coordinator. (wa-sqlite/OPFS is the durable production store; localStorage is
 * the simplest correct shared store and is used to exercise the cross-tab coordination directly.)
 */
export function localStorageOutbox(prefix: string): StorageAdapter {
  const scoped = (key: string) => `${prefix}${key}`;
  const store = () => globalThis.localStorage;
  return {
    get: async (key) => store().getItem(scoped(key)),
    set: async (key, value) => store().setItem(scoped(key), value),
    delete: async (key) => store().removeItem(scoped(key)),
    keys: async () =>
      Object.keys(store())
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    clear: async () => {
      for (const key of Object.keys(store())) {
        if (key.startsWith(prefix)) store().removeItem(key);
      }
    },
  };
}

/** A `localStorage`-backed meta KV (shared per-client mutation-id high-water across tabs). */
export function localStorageMeta(prefix: string): MutationIdStorage {
  const store = () => globalThis.localStorage;
  return {
    get: async (key) => store().getItem(`${prefix}${key}`),
    set: async (key, value) => store().setItem(`${prefix}${key}`, value),
  };
}
