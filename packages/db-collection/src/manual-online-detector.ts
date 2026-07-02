import type { OnlineDetector } from "./types.js";

export interface ManualOnlineDetector extends OnlineDetector {
  /**
   * Force the client offline (`false`) or release the override (`true`). While forced offline the
   * outbox holds mutations regardless of real connectivity; releasing notifies online so the outbox
   * flushes. Use for deterministic offline→online testing and dev "simulate offline" toggles.
   */
  setOnline(online: boolean): void;
  /** Whether an offline override is currently active. */
  isForcedOffline(): boolean;
}

/**
 * Wrap an {@link OnlineDetector} with a manual override. With a base detector it follows real
 * connectivity until `setOnline(false)` forces offline; `setOnline(true)` releases the override and
 * triggers a flush. With no base it is a pure manual switch (online by default) — handy in tests.
 */
export function manualOnlineDetector(base?: OnlineDetector): ManualOnlineDetector {
  const listeners = new Set<() => void>();
  let forcedOffline = false;
  const unsubscribe = base?.subscribe(() => {
    if (!forcedOffline) for (const listener of listeners) listener();
  });
  return {
    isOnline: () => !forcedOffline && (base ? base.isOnline() : true),
    isForcedOffline: () => forcedOffline,
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    notifyOnline() {
      base?.notifyOnline();
      for (const listener of listeners) listener();
    },
    setOnline(online) {
      forcedOffline = !online;
      if (online) for (const listener of listeners) listener();
    },
    dispose() {
      listeners.clear();
      unsubscribe?.();
      base?.dispose();
    },
  };
}
