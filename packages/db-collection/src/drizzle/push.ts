import type { Mutation } from "@nizhal/kernel";
import type { OnlineDetector } from "@tanstack/offline-transactions";
import { asc, eq } from "drizzle-orm";
import type { NizhalClient } from "../client.js";
import {
  type MutationIdStorage,
  allocateMutationId,
  readAllocatedMutationId,
  readPersistedMutationId,
  writeAllocatedMutationId,
  writePersistedMutationId,
} from "../mutation-id.js";
import type { DeadLetterStorage } from "../persistence/dead-letter-storage.js";
import { classifyPushError } from "../push-errors.js";
import type { NizhalMutatorDefinition, NizhalPoisonEntry } from "../types.js";
import type { WriteGate } from "./atomic.js";
import { nizhalOutbox } from "./control-schema.js";
import type { AnyDrizzleSqliteDb } from "./types.js";

// The ONE push engine (SESSION-HANDOFF caveat 1 resolved): a FIFO flush loop over the durable
// nizhal_outbox table, with the mutation-id allocation + 409 downward-resync + poison-parking
// semantics ported from the legacy createNizhalMutators (they were already collection-agnostic).

export interface OutboxEnvelope {
  name: string;
  args: unknown;
  clientID: string;
  hlc?: string;
}

export interface PushEngineOptions {
  db: AnyDrizzleSqliteDb;
  /** Serializes this engine's outbox reads/deletes against mutate/pull transactions on the
   *  shared connection — a bare statement here would otherwise join an open BEGIN IMMEDIATE.
   *  Pass gate-wrapped `meta`/`deadLetter` storages too (the store assembly does). */
  gate: WriteGate;
  echo: NizhalClient;
  meta: MutationIdStorage;
  deadLetter: DeadLetterStorage;
  mutators: Record<string, NizhalMutatorDefinition>;
  onlineDetector: OnlineDetector;
  onPoison?: (entry: NizhalPoisonEntry) => void;
  /** Transient-failure retry backoff base (doubles per attempt, capped). Tests pass a short one. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface PushEngine {
  /** Wake the loop (after enqueue, on reconnect, on poke). Safe to call anytime. */
  flush(): void;
  waitForIdle(): Promise<void>;
  getPendingCount(): Promise<number>;
  deadLetter: readonly NizhalPoisonEntry[];
  retryDeadLetter(idempotencyKey?: string): Promise<number>;
  onDeadLetterChange(listener: () => void): () => void;
  waitForInit(): Promise<void>;
  dispose(): Promise<void>;
}

class PoisonGuard {
  private readonly poisonedKeys = new Set<string>();
  readonly deadLetter: NizhalPoisonEntry[] = [];
  private loaded: Promise<void> | undefined;
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private readonly storage: DeadLetterStorage,
    private readonly onPoison?: (entry: NizhalPoisonEntry) => void,
  ) {}

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const entries = await this.storage.list();
      for (const entry of entries) {
        this.deadLetter.push(entry);
        this.poisonedKeys.add(entry.idempotencyKey);
        if (entry.dependencyKey) this.poisonedKeys.add(entry.dependencyKey);
      }
      if (this.deadLetter.length > 0) this.emitChange();
    })();
    return this.loaded;
  }

  isPoisoned(key: string): boolean {
    return this.poisonedKeys.has(key);
  }

  async park(
    idempotencyKey: string,
    mutation: Mutation,
    error: Error,
    dependencyKey?: string,
  ): Promise<void> {
    if (this.poisonedKeys.has(idempotencyKey)) return;
    const entry: NizhalPoisonEntry = {
      idempotencyKey,
      ...(dependencyKey ? { dependencyKey } : {}),
      mutation,
      error,
      parkedAt: Date.now(),
    };
    this.deadLetter.push(entry);
    this.poisonedKeys.add(idempotencyKey);
    if (dependencyKey) this.poisonedKeys.add(dependencyKey);
    await this.storage.park(entry);
    this.onPoison?.(entry);
    this.emitChange();
  }

  // Durable removal first, then in-memory, so a crash mid-retry never leaves a phantom row.
  async unpark(idempotencyKey: string): Promise<void> {
    if (!this.poisonedKeys.has(idempotencyKey)) return;
    await this.storage.remove(idempotencyKey);
    const index = this.deadLetter.findIndex((entry) => entry.idempotencyKey === idempotencyKey);
    if (index >= 0) {
      const [removed] = this.deadLetter.splice(index, 1);
      if (removed?.dependencyKey) this.poisonedKeys.delete(removed.dependencyKey);
    }
    this.poisonedKeys.delete(idempotencyKey);
    this.emitChange();
  }
}

function isMutationSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function createPushEngine(opts: PushEngineOptions): PushEngine {
  const poison = new PoisonGuard(opts.deadLetter, opts.onPoison);
  const retryBaseMs = opts.retryBaseMs ?? 500;
  const retryMaxMs = opts.retryMaxMs ?? 30_000;

  let localHighWater = 0;
  let serverHighWater = 0;
  let disposed = false;
  let running: Promise<void> | null = null;
  let pendingWake = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = retryBaseMs;
  const idleWaiters = new Set<() => void>();

  const readOutbox = <T>(fn: () => Promise<T>): Promise<T> => opts.gate.run(opts.db, fn);
  const deleteOutboxRow = (ordinal: number): Promise<unknown> =>
    opts.gate.run(opts.db, () =>
      opts.db.delete(nizhalOutbox).where(eq(nizhalOutbox.ordinal, ordinal)),
    );

  const init = (async () => {
    await poison.ensureLoaded();
    const persisted = await readPersistedMutationId(opts.meta);
    const pending = await readOutbox(() =>
      opts.db.select({ idempotencyKey: nizhalOutbox.idempotencyKey }).from(nizhalOutbox),
    );
    const pendingIds = await Promise.all(
      pending.map((row) => readAllocatedMutationId(opts.meta, row.idempotencyKey)),
    );
    localHighWater = Math.max(persisted, ...pendingIds, 0);
    serverHighWater = Math.max(serverHighWater, opts.echo.getLastMutationId?.() ?? 0);
  })();

  async function allocatedMutationId(idempotencyKey: string): Promise<number> {
    serverHighWater = Math.max(serverHighWater, opts.echo.getLastMutationId?.() ?? 0);
    const allocated = await readAllocatedMutationId(opts.meta, idempotencyKey);
    if (allocated > 0) {
      localHighWater = Math.max(localHighWater, allocated);
      await writePersistedMutationId(opts.meta, localHighWater);
      return allocated;
    }
    const mutationID = allocateMutationId(serverHighWater, localHighWater);
    await writeAllocatedMutationId(opts.meta, idempotencyKey, mutationID);
    localHighWater = Math.max(localHighWater, mutationID);
    await writePersistedMutationId(opts.meta, localHighWater);
    return mutationID;
  }

  async function reallocateFromServer(
    idempotencyKey: string,
    lastMutationId: number,
    authoritative: boolean,
  ): Promise<number> {
    // A 409 out-of-order is the server authoritatively stating its sequence position — trust it
    // even downward, or a stale response that inflated serverHighWater pins the client forever.
    serverHighWater = authoritative ? lastMutationId : Math.max(serverHighWater, lastMutationId);
    const mutationID = allocateMutationId(serverHighWater, 0);
    await writeAllocatedMutationId(opts.meta, idempotencyKey, mutationID);
    localHighWater = mutationID;
    await writePersistedMutationId(opts.meta, localHighWater);
    return mutationID;
  }

  async function attemptPush(
    stored: Pick<Mutation, "name" | "args" | "clientID" | "mutationID" | "hlc">,
    idempotencyKey: string,
    dependsOn: string | undefined,
  ): Promise<void> {
    let mutationID = await allocatedMutationId(idempotencyKey);
    for (;;) {
      const mutation: Mutation = {
        ...stored,
        clientMutationId: idempotencyKey,
        mutationID,
        ...(dependsOn ? { dependsOn } : {}),
      };
      const response = await opts.echo.push(mutation);
      if (isMutationSequence(response?.lastMutationId)) {
        serverHighWater = Math.max(serverHighWater, response.lastMutationId);
      }
      if (response?.outOfOrder || response?.accepted === false) {
        if (!isMutationSequence(response.lastMutationId)) {
          throw new Error(
            "[@nizhal/db-collection] mutation sequence conflict omitted lastMutationId",
          );
        }
        mutationID = await reallocateFromServer(
          idempotencyKey,
          response.lastMutationId,
          response?.outOfOrder === true,
        );
        continue;
      }
      return;
    }
  }

  async function drain(): Promise<void> {
    await init;
    for (;;) {
      if (disposed) return;
      if (opts.echo.isRemoteSyncEnabled?.() === false) return;
      if (!opts.onlineDetector.isOnline()) return;
      const rows = await readOutbox(() =>
        opts.db.select().from(nizhalOutbox).orderBy(asc(nizhalOutbox.ordinal)).limit(1),
      );
      const row = rows[0];
      if (!row) return;

      const envelope = row.envelope as OutboxEnvelope;
      const dependsOn = row.dependsOn ?? undefined;

      if (
        poison.isPoisoned(row.idempotencyKey) ||
        (dependsOn !== undefined && poison.isPoisoned(dependsOn))
      ) {
        if (dependsOn !== undefined && poison.isPoisoned(dependsOn)) {
          opts.echo.reportError(
            "push",
            new Error(`cascade-cancelled: depends on poisoned ${dependsOn}`),
          );
        }
        await deleteOutboxRow(row.ordinal);
        continue;
      }

      try {
        await attemptPush(envelope, row.idempotencyKey, dependsOn);
        retryDelay = retryBaseMs;
        await deleteOutboxRow(row.ordinal);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (classifyPushError(normalized) === "terminal") {
          const mutationID = await readAllocatedMutationId(opts.meta, row.idempotencyKey);
          const mutation: Mutation = {
            ...envelope,
            clientMutationId: row.idempotencyKey,
            ...(mutationID > 0 ? { mutationID } : {}),
            ...(dependsOn ? { dependsOn } : {}),
          };
          await poison.park(
            row.idempotencyKey,
            mutation,
            normalized,
            opts.mutators[envelope.name]?.key?.(envelope.args),
          );
          await deleteOutboxRow(row.ordinal);
          continue;
        }
        // Transient: keep FIFO order — stop draining and retry later with backoff.
        opts.echo.reportError("push", normalized);
        if (!disposed) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            flush();
          }, retryDelay);
          if (typeof retryTimer === "object" && "unref" in retryTimer) retryTimer.unref();
          retryDelay = Math.min(retryDelay * 2, retryMaxMs);
        }
        return;
      }
    }
  }

  function flush(): void {
    if (disposed) return;
    if (running) {
      pendingWake = true;
      return;
    }
    running = drain()
      .catch((error) => opts.echo.reportError("push", error))
      .finally(() => {
        running = null;
        if (pendingWake) {
          pendingWake = false;
          flush();
          return;
        }
        for (const waiter of idleWaiters) waiter();
        idleWaiters.clear();
      });
  }

  const unsubscribeOnline = opts.onlineDetector.subscribe(() => {
    retryDelay = retryBaseMs;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    flush();
  });

  return {
    flush,
    async waitForIdle() {
      for (;;) {
        await init;
        if (running) {
          await new Promise<void>((resolve) => idleWaiters.add(resolve));
          continue;
        }
        const pending = await readOutbox(() =>
          opts.db.select({ ordinal: nizhalOutbox.ordinal }).from(nizhalOutbox).limit(1),
        );
        if (pending.length === 0 || !opts.onlineDetector.isOnline() || retryTimer) return;
        flush();
        await new Promise<void>((resolve) => idleWaiters.add(resolve));
      }
    },
    async getPendingCount() {
      const rows = await readOutbox(() =>
        opts.db.select({ ordinal: nizhalOutbox.ordinal }).from(nizhalOutbox),
      );
      return rows.length;
    },
    deadLetter: poison.deadLetter,
    async retryDeadLetter(idempotencyKey?: string) {
      await init;
      const targets = idempotencyKey
        ? poison.deadLetter.filter((entry) => entry.idempotencyKey === idempotencyKey)
        : [...poison.deadLetter];
      let recovered = 0;
      for (const entry of targets) {
        await poison.unpark(entry.idempotencyKey);
        try {
          await attemptPush(entry.mutation, entry.idempotencyKey, entry.mutation.dependsOn);
          recovered += 1;
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          await poison.park(entry.idempotencyKey, entry.mutation, normalized);
        }
      }
      return recovered;
    },
    onDeadLetterChange: (listener) => poison.onChange(listener),
    waitForInit: () => init,
    async dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeOnline();
      while (running) await running;
    },
  };
}
