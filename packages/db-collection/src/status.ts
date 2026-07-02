import { type Cursor, INITIAL_CURSOR } from "@nizhal/kernel";
import type { OutboxTransactionLike } from "./types.js";
import type { NizhalPoisonEntry } from "./types.js";

export interface SyncStatus {
  connectivity: "online" | "offline" | "connecting";
  pendingMutations: number;
  lastPullCursor: Cursor;
  lastPulledAt: number | null;
  lastError: { phase: string; message: string } | null;
  deadLettered: number;
}

export interface OutboxEntry {
  id: string;
  mutationFnName: string;
  idempotencyKey?: string;
  retryCount: number;
  lastError?: { message: string };
  createdAt: Date;
}

export interface NizhalStatus {
  syncStatus(): SyncStatus;
  onSyncStatus(callback: (status: SyncStatus) => void): () => void;
  outbox: {
    list(): Promise<OutboxEntry[]>;
    deadLetter(): NizhalPoisonEntry[];
  };
}

export interface NizhalStatusController extends NizhalStatus {
  setCursor(cursor: Cursor): void;
  setError(phase: string, error: unknown): void;
  notify(): void;
}

export function createNoopNizhalStatus(): NizhalStatus {
  return {
    syncStatus() {
      return {
        connectivity: "online",
        pendingMutations: 0,
        lastPullCursor: INITIAL_CURSOR,
        lastPulledAt: null,
        lastError: null,
        deadLettered: 0,
      };
    },
    onSyncStatus() {
      return () => {};
    },
    outbox: {
      async list() {
        return [];
      },
      deadLetter() {
        return [];
      },
    },
  };
}

export function createNoopNizhalStatusController(): NizhalStatusController {
  return {
    ...createNoopNizhalStatus(),
    setCursor() {},
    setError() {},
    notify() {},
  };
}

/** Source-agnostic view onto whatever sync engine backs the store (the drizzle-native one). */
export interface NizhalStatusSource {
  isOnline(): boolean;
  subscribeOnline(callback: () => void): () => void;
  getPendingCount(): number | Promise<number>;
  listOutbox(): Promise<OutboxEntry[]>;
}

export interface NizhalStatusDeps {
  source?: NizhalStatusSource;
  deadLetter?: readonly NizhalPoisonEntry[];
}

export function createNizhalStatus(deps: NizhalStatusDeps): NizhalStatusController {
  const source = deps.source;
  const deadLetter = deps.deadLetter ?? [];
  let lastPullCursor = INITIAL_CURSOR;
  let lastPulledAt: number | null = null;
  let lastError: { phase: string; message: string } | null = null;
  let pendingMutations = 0;
  const listeners = new Set<(status: SyncStatus) => void>();

  function buildStatus(): SyncStatus {
    return {
      connectivity: !source || source.isOnline() ? "online" : "offline",
      pendingMutations,
      lastPullCursor,
      lastPulledAt,
      lastError,
      deadLettered: deadLetter.length,
    };
  }

  function notify() {
    const pending = source?.getPendingCount() ?? 0;
    const settle = (count: number) => {
      pendingMutations = count;
      const status = buildStatus();
      for (const listener of listeners) listener(status);
    };
    if (typeof pending === "number") settle(pending);
    else void pending.then(settle);
  }

  const unsubscribeOnline = source?.subscribeOnline(notify);

  return {
    syncStatus: buildStatus,
    onSyncStatus(callback) {
      listeners.add(callback);
      callback(buildStatus());
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) unsubscribeOnline?.();
      };
    },
    outbox: {
      async list() {
        return (await source?.listOutbox()) ?? [];
      },
      deadLetter() {
        return deadLetter.slice();
      },
    },
    setCursor(cursor) {
      lastPullCursor = cursor;
      lastPulledAt = Date.now();
      notify();
    },
    setError(phase, error) {
      lastError = {
        phase,
        message: error instanceof Error ? error.message : String(error),
      };
      notify();
    },
    notify,
  };
}
