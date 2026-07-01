import type { Mutation } from "@nizhal/kernel";
import type { StorageAdapter } from "@tanstack/offline-transactions";
import type { NizhalClient } from "./client.js";
import {
  type MutationIdStorage,
  allocateMutationId,
  readAllocatedMutationId,
  readPersistedMutationId,
  writeAllocatedMutationId,
  writePersistedMutationId,
} from "./mutation-id.js";

// The cross-tab coordination port: who is the single flusher, and a broadcast when ANY tab enqueues a
// write so the elected leader (possibly a different tab) re-scans the shared outbox. Node uses an
// in-process fake; the browser uses Web Locks + BroadcastChannel (a later chunk). This is the seam that
// closes the dependency's gaps — it only persists/flushes for its own leader and never signals peers.
export interface NizhalCoordinator {
  isLeader(): boolean;
  onLeadershipChange(listener: (isLeader: boolean) => void): () => void;
  /** Broadcast that a write was enqueued so whichever tab is leader re-scans the shared outbox. */
  signalWrite(): void;
  /** Subscribe to write signals from any tab (including self). */
  onWriteSignal(listener: () => void): () => void;
}

export interface NizhalOnlineGate {
  isOnline(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface NizhalClientGroupDeadLetter {
  clientMutationId: string;
  mutation: SharedMutation;
  error: string;
  parkedAt: number;
}

export type SharedMutation = Pick<Mutation, "name" | "args" | "hlc" | "dependsOn">;

interface SharedOutboxEntry {
  clientMutationId: string;
  mutation: SharedMutation;
  enqueuedAt: number;
}

const OUTBOX_PREFIX = "cg:tx:";
const ORDINAL_KEY = "cg:enqueue-ordinal";

export interface OpenNizhalClientGroupOptions {
  echo: NizhalClient;
  /** Durable outbox SHARED across tabs (wa-sqlite/OPFS on web; in-memory in Node tests). */
  outbox: StorageAdapter;
  /** Durable meta store SHARED across tabs — holds the per-client mutation-id high-water. */
  meta: MutationIdStorage;
  coordinator: NizhalCoordinator;
  online: NizhalOnlineGate;
  clientID: string;
  /** Terminal errors park (dead-letter); retriable errors keep the write in the outbox and back off. */
  classifyError?: (error: Error) => "terminal" | "retriable";
  /** Backoff before re-draining after a retriable failure. Default 50ms. */
  retryDelayMs?: number;
  now?: () => number;
}

export interface NizhalClientGroup {
  /** Durably enqueue a mutation to the SHARED outbox and wake the leader (any tab can call this). */
  enqueue(clientMutationId: string, mutation: SharedMutation): Promise<void>;
  pendingCount(): Promise<number>;
  readonly deadLetter: readonly NizhalClientGroupDeadLetter[];
  dispose(): void;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function defaultClassify(error: Error): "terminal" | "retriable" {
  // A contiguous-sequence rejection or a 5xx/network error is retriable; a 4xx (except 409, handled as a
  // sequence resync in the push loop) is a permanent contract violation → terminal.
  const status = /(\b|:)([45]\d\d)\b/.exec(error.message)?.[2];
  if (status?.startsWith("4") && status !== "409") return "terminal";
  return "retriable";
}

/**
 * A Nizhal-owned, leader-gated flush loop over a SHARED durable outbox — the core of multi-tab
 * ClientGroup coordination. Any tab durably enqueues a write; exactly one elected leader drains the
 * shared outbox, pushing each entry with mutation-id resync (authoritative downward on a 409),
 * retrying transient failures, and parking only genuinely-terminal ones — so a write is never dropped
 * for having originated on a follower, and never lost to a transient error mid-flush.
 */
export function openNizhalClientGroup(opts: OpenNizhalClientGroupOptions): NizhalClientGroup {
  const classify = opts.classifyError ?? defaultClassify;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  const now = opts.now ?? (() => 0);
  const deadLetter: NizhalClientGroupDeadLetter[] = [];

  let serverHighWater = 0;
  let localHighWater = 0;
  let seeded = false;
  let flushing = false;
  let flushQueued = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  async function seed(): Promise<void> {
    if (seeded) return;
    seeded = true;
    localHighWater = await readPersistedMutationId(opts.meta);
    serverHighWater = Math.max(serverHighWater, opts.echo.getLastMutationId?.() ?? 0);
  }

  async function allocatedId(clientMutationId: string): Promise<number> {
    const existing = await readAllocatedMutationId(opts.meta, clientMutationId);
    if (existing > 0) {
      localHighWater = Math.max(localHighWater, existing);
      return existing;
    }
    const id = allocateMutationId(serverHighWater, localHighWater);
    await writeAllocatedMutationId(opts.meta, clientMutationId, id);
    localHighWater = Math.max(localHighWater, id);
    await writePersistedMutationId(opts.meta, localHighWater);
    return id;
  }

  // Server authoritatively restated its sequence on a 409 ⇒ trust it even downward (a stale/replayed
  // response must never pin the client above the server's true sequence). Mirrors the fix in mutators.ts.
  async function reallocate(
    clientMutationId: string,
    lastMutationId: number,
    authoritative: boolean,
  ): Promise<number> {
    serverHighWater = authoritative ? lastMutationId : Math.max(serverHighWater, lastMutationId);
    const id = allocateMutationId(serverHighWater, 0);
    await writeAllocatedMutationId(opts.meta, clientMutationId, id);
    localHighWater = id;
    await writePersistedMutationId(opts.meta, localHighWater);
    return id;
  }

  async function pushEntry(entry: SharedOutboxEntry): Promise<void> {
    let mutationID = await allocatedId(entry.clientMutationId);
    for (;;) {
      const result = await opts.echo.push({
        ...entry.mutation,
        clientMutationId: entry.clientMutationId,
        clientID: opts.clientID,
        mutationID,
      });
      if (isSequence(result.lastMutationId)) {
        serverHighWater = Math.max(serverHighWater, result.lastMutationId);
      }
      if (result.outOfOrder || result.accepted === false) {
        if (!isSequence(result.lastMutationId)) {
          throw new Error("[@nizhal] sequence conflict omitted lastMutationId");
        }
        mutationID = await reallocate(
          entry.clientMutationId,
          result.lastMutationId,
          result.outOfOrder === true,
        );
        continue;
      }
      return;
    }
  }

  function canFlush(): boolean {
    return !disposed && opts.coordinator.isLeader() && opts.online.isOnline();
  }

  async function drain(): Promise<void> {
    await seed();
    const keys = (await opts.outbox.keys()).filter((key) => key.startsWith(OUTBOX_PREFIX)).sort();
    for (const key of keys) {
      if (!canFlush()) return;
      const raw = await opts.outbox.get(key);
      if (!raw) continue;
      const entry = JSON.parse(raw) as SharedOutboxEntry;
      try {
        await pushEntry(entry);
        await opts.outbox.delete(key);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (classify(normalized) === "terminal") {
          deadLetter.push({
            clientMutationId: entry.clientMutationId,
            mutation: entry.mutation,
            error: normalized.message,
            parkedAt: now(),
          });
          await opts.outbox.delete(key);
          continue;
        }
        // Retriable: leave the write durably in the outbox, back off, and re-drain. Never dropped.
        scheduleRetry();
        return;
      }
    }
  }

  function scheduleRetry(): void {
    if (disposed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      scheduleFlush();
    }, retryDelayMs);
  }

  async function runFlush(): Promise<void> {
    flushing = true;
    try {
      do {
        flushQueued = false;
        if (!canFlush()) return;
        await drain();
      } while (flushQueued);
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush(): void {
    if (!canFlush()) return;
    if (flushing) {
      flushQueued = true;
      return;
    }
    void runFlush();
  }

  // A shared monotonic ordinal keys each entry so the outbox drains in FIFO enqueue order across tabs —
  // the per-client mutation sequence must be pushed in the order writes were made, not by id/uuid sort.
  // (Chunk 2 allocates this under the election mutex so concurrent cross-tab enqueues can't collide.)
  async function nextOrdinal(): Promise<string> {
    const raw = await opts.meta.get(ORDINAL_KEY);
    const next = (isSequence(Number(raw)) ? Number(raw) : 0) + 1;
    await opts.meta.set(ORDINAL_KEY, String(next));
    return String(next).padStart(16, "0");
  }

  async function enqueue(clientMutationId: string, mutation: SharedMutation): Promise<void> {
    const entry: SharedOutboxEntry = { clientMutationId, mutation, enqueuedAt: now() };
    const ordinal = await nextOrdinal();
    await opts.outbox.set(`${OUTBOX_PREFIX}${ordinal}:${clientMutationId}`, JSON.stringify(entry));
    opts.coordinator.signalWrite();
    scheduleFlush();
  }

  async function pendingCount(): Promise<number> {
    return (await opts.outbox.keys()).filter((key) => key.startsWith(OUTBOX_PREFIX)).length;
  }

  const unsubLeader = opts.coordinator.onLeadershipChange((isLeader) => {
    if (isLeader) scheduleFlush();
  });
  const unsubOnline = opts.online.subscribe(() => scheduleFlush());
  const unsubSignal = opts.coordinator.onWriteSignal(() => scheduleFlush());
  scheduleFlush();

  return {
    enqueue,
    pendingCount,
    deadLetter,
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubLeader();
      unsubOnline();
      unsubSignal();
    },
  };
}
