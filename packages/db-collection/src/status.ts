import { type Cursor, INITIAL_CURSOR } from "@nizhal/kernel";
import type { OfflineExecutor, OfflineTransaction } from "@tanstack/offline-transactions";
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

export interface NizhalStatusDeps {
  executor?: OfflineExecutor;
  deadLetter?: NizhalPoisonEntry[];
}

export function createNizhalStatus(deps: NizhalStatusDeps): NizhalStatusController {
  const executor = deps.executor;
  const deadLetter = deps.deadLetter ?? [];
  let lastPullCursor = INITIAL_CURSOR;
  let lastPulledAt: number | null = null;
  let lastError: { phase: string; message: string } | null = null;
  const listeners = new Set<(status: SyncStatus) => void>();

  function connectivity(): SyncStatus["connectivity"] {
    if (!executor) return "online";
    return executor.isOnline() ? "online" : "offline";
  }

  function buildStatus(): SyncStatus {
    return {
      connectivity: connectivity(),
      pendingMutations: executor?.getPendingCount() ?? 0,
      lastPullCursor,
      lastPulledAt,
      lastError,
      deadLettered: deadLetter.length,
    };
  }

  function notify() {
    const status = buildStatus();
    for (const listener of listeners) listener(status);
  }

  const unsubscribeOnline = executor?.getOnlineDetector().subscribe(notify);

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
        const transactions = await executor?.peekOutbox();
        return (transactions ?? []).map(mapOutboxEntry);
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

function mapOutboxEntry(tx: OfflineTransaction): OutboxEntry {
  return {
    id: tx.id,
    mutationFnName: tx.mutationFnName,
    idempotencyKey: tx.idempotencyKey,
    retryCount: tx.retryCount,
    lastError: tx.lastError ? { message: tx.lastError.message } : undefined,
    createdAt: tx.createdAt,
  };
}
