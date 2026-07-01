import {
  type Actor,
  type HlcClockOptions,
  type JobScheduler,
  type Mutation,
  type MutatorTx,
  createHlcClock,
  normalizeHlcNodeId,
} from "@nizhal/kernel";
import { type MutationFnParams, safeRandomUUID } from "@tanstack/db";
import type { PendingMutation } from "@tanstack/db";
import {
  type LeaderElection,
  NonRetriableError,
  type OfflineExecutor,
  type OfflineTransaction,
  type OnlineDetector,
  type StorageAdapter,
  startOfflineExecutor,
} from "@tanstack/offline-transactions";
import { getTableName } from "drizzle-orm/table";
import type { Table } from "drizzle-orm/table";
import type { NizhalClient } from "./client.js";
import { rowsFromMutations } from "./local-write-barrier.js";
import { createMemoryStorage } from "./memory-storage.js";
import {
  type MutationIdStorage,
  allocateMutationId,
  readAllocatedMutationId,
  readPersistedMutationId,
  writeAllocatedMutationId,
  writePersistedMutationId,
} from "./mutation-id.js";
import type { DeadLetterStorage } from "./persistence/dead-letter-storage.js";
import type { BufferedSQLiteOutboxStorage } from "./persistence/sqlite-storage.js";
import { classifyPushError } from "./push-errors.js";
import type { NizhalCollectionMap, NizhalMutatorDefinition, NizhalPoisonEntry } from "./types.js";

const NIZHAL_ENVELOPE_METADATA_KEY = "nizhal";

export interface NizhalEnvelopeMetadata {
  mutation: Pick<Mutation, "name" | "args" | "clientID" | "mutationID" | "hlc">;
  dependsOn?: string;
}

export interface CreateNizhalMutatorsOptions<
  M extends Record<string, NizhalMutatorDefinition<any>>,
> {
  collections: NizhalCollectionMap;
  echo: NizhalClient;
  mutators: M;
  actor: Actor;
  clientID?: string;
  outboxStorage?: StorageAdapter;
  /** Durable per-device key/value for the mutation-id high-water (persistence.metaStorage). Without
   *  it the per-client sequence cannot survive a restart and post-restart writes are dropped by the
   *  server's contiguous-sequence check — pass it for any persistent (offline-first) client. */
  mutationIdStorage?: MutationIdStorage;
  deadLetterStorage?: DeadLetterStorage;
  onPoison?: (entry: NizhalPoisonEntry) => void;
  hlcOptions?: Omit<HlcClockOptions, "nodeId">;
  /** Connectivity detector for the offline executor. Defaults to a web/node-safe detector;
   *  React Native apps should pass `reactNativeOnlineDetector()` from `@nizhal/react-native`
   *  (NetInfo-based) so the outbox auto-flushes when the network returns. */
  onlineDetector?: OnlineDetector;
  /** Cross-tab leader election. Defaults to a single-process leader (correct for RN + Node). */
  leaderElection?: LeaderElection;
}

export interface NizhalMutatorsResult<M extends Record<string, NizhalMutatorDefinition<any>>> {
  mutate: { [K in keyof M]: (args: MutatorArgs<M[K]>) => void };
  executor: OfflineExecutor;
  deadLetter: readonly NizhalPoisonEntry[];
  /** RFC-011 F-B: re-attempt parked writes. Omit the key to retry all. Returns how many recovered. */
  retryDeadLetter(idempotencyKey?: string): Promise<number>;
  /** RFC-011 F-B: subscribe to dead-letter changes (park/unpark/load) so a UI can react. */
  onDeadLetterChange(listener: () => void): () => void;
  getPendingCount(): number;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

type MutatorArgs<D extends NizhalMutatorDefinition> = D extends NizhalMutatorDefinition<infer A>
  ? A
  : never;

type NizhalOfflineMutationFn = (
  params: MutationFnParams & { idempotencyKey: string },
) => Promise<void>;

// RFC-011 F-D: ceiling for the best-effort post-push local-write reconciliation. Override via
// NIZHAL_ACK_TIMEOUT_MS (tests use a short value).
const DEFAULT_ACK_RECONCILE_TIMEOUT_MS = 8_000;
function ackReconcileTimeoutMs(): number {
  const raw = Number(globalThis.process?.env?.NIZHAL_ACK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACK_RECONCILE_TIMEOUT_MS;
}

class PoisonGuard {
  private readonly poisonedKeys = new Set<string>();
  readonly deadLetter: NizhalPoisonEntry[] = [];
  private loaded = false;
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private readonly deadLetterStorage: DeadLetterStorage | undefined,
    private readonly onPoison?: (entry: NizhalPoisonEntry) => void,
  ) {}

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.deadLetterStorage) {
      this.loaded = true;
      return;
    }
    const entries = await this.deadLetterStorage.list();
    for (const entry of entries) {
      this.deadLetter.push(entry);
      this.poisonedKeys.add(entry.idempotencyKey);
      if (entry.dependencyKey) this.poisonedKeys.add(entry.dependencyKey);
    }
    this.loaded = true;
    if (this.deadLetter.length > 0) this.emitChange();
  }

  isPoisoned(idempotencyKey: string): boolean {
    return this.poisonedKeys.has(idempotencyKey);
  }

  async park(
    idempotencyKey: string,
    mutation: Mutation,
    error: Error,
    dependencyKey?: string,
  ): Promise<void> {
    if (this.poisonedKeys.has(idempotencyKey)) {
      return;
    }
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
    await this.deadLetterStorage?.park(entry);
    this.onPoison?.(entry);
    this.emitChange();
  }

  // RFC-011 F-B: take a parked mutation back out so it can be retried. Durable removal first, then
  // in-memory, so a crash mid-retry never leaves a phantom dead-letter row behind.
  async unpark(idempotencyKey: string): Promise<void> {
    if (!this.poisonedKeys.has(idempotencyKey)) return;
    await this.deadLetterStorage?.remove(idempotencyKey);
    const index = this.deadLetter.findIndex((entry) => entry.idempotencyKey === idempotencyKey);
    if (index >= 0) {
      const [removed] = this.deadLetter.splice(index, 1);
      if (removed?.dependencyKey) this.poisonedKeys.delete(removed.dependencyKey);
    }
    this.poisonedKeys.delete(idempotencyKey);
    this.emitChange();
  }
}

export function createNizhalMutators<M extends Record<string, NizhalMutatorDefinition<any>>>(
  opts: CreateNizhalMutatorsOptions<M>,
): NizhalMutatorsResult<M> {
  const poison = new PoisonGuard(opts.deadLetterStorage, opts.onPoison);
  const clientID = opts.clientID ?? safeRandomUUID();
  opts.echo.setDeviceId(clientID);
  const hlc = createHlcClock({
    nodeId: normalizeHlcNodeId(clientID),
    ...opts.hlcOptions,
  });
  let localHighWater = 0;
  let serverHighWater = 0;
  let sequenceTail = Promise.resolve();
  const pendingCommits = new Set<Promise<unknown>>();

  const baseOutboxStorage = opts.outboxStorage ?? createMemoryStorage();
  const localCommits = new LocalCommitCoordinator(opts.collections, opts.echo);
  const outboxStorage = localCommitStorage(baseOutboxStorage, localCommits);
  const bufferedOutbox =
    "flush" in baseOutboxStorage ? (baseOutboxStorage as BufferedSQLiteOutboxStorage) : undefined;
  const mutationIdStore = opts.mutationIdStorage ?? memoryMutationIdStorage();

  if (opts.outboxStorage && !opts.mutationIdStorage) {
    console.warn(
      "[@nizhal/db-collection] outboxStorage provided without mutationIdStorage: the per-client " +
        "mutation sequence cannot be recovered durably after a restart. Pass " +
        "persistence.metaStorage as mutationIdStorage.",
    );
  }

  const executorRef: { current?: OfflineExecutor } = {};

  const mutationFns: Record<string, NizhalOfflineMutationFn> = {};
  for (const [name] of Object.entries(opts.mutators) as [
    keyof M & string,
    NizhalMutatorDefinition,
  ][]) {
    mutationFns[name] = async ({ idempotencyKey, transaction }) => {
      const executor = executorRef.current;
      if (!executor) throw new Error("[@nizhal/db-collection] executor is not initialized");
      await executor.waitForInit();
      await poison.ensureLoaded();
      await bufferedOutbox?.flush();
      const envelope = readEnvelopeMetadata(transaction.metadata);
      if (!envelope) {
        throw new NonRetriableError(
          `[@nizhal/db-collection] missing canonical mutation envelope for '${name}'`,
        );
      }

      const { mutation: storedMutation, dependsOn } = envelope;
      if (dependsOn && poison.isPoisoned(dependsOn)) {
        opts.echo.reportError(
          "push",
          new Error(`cascade-cancelled: depends on poisoned ${dependsOn}`),
        );
        return;
      }
      if (poison.isPoisoned(idempotencyKey)) {
        opts.echo.reportError("push", new Error(`mutation ${idempotencyKey} is poisoned`));
        return;
      }

      await persistLocalFirstCollectionMutations(
        opts.collections,
        opts.echo,
        transaction.mutations,
      );

      if (opts.echo.isRemoteSyncEnabled?.() === false) {
        return;
      }

      try {
        await attemptPush(storedMutation, idempotencyKey, dependsOn);
        await reconcileLocalWrite(transaction.id);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (classifyPushError(normalized) === "terminal") {
          const mutationID = await readAllocatedMutationId(mutationIdStore, idempotencyKey);
          const nizhalMutation: Mutation = {
            ...storedMutation,
            clientMutationId: idempotencyKey,
            ...(mutationID > 0 ? { mutationID } : {}),
            ...(dependsOn ? { dependsOn } : {}),
          };
          await poison.park(
            idempotencyKey,
            nizhalMutation,
            normalized,
            opts.mutators[name]?.key?.(storedMutation.args),
          );
          await reconcileLocalWrite(transaction.id);
          return;
        }
        throw normalized;
      }
    };
  }

  const onlineDetector = controllableOnlineDetector(opts.onlineDetector ?? nizhalOnlineDetector());
  const executor = startOfflineExecutor({
    collections: opts.collections,
    storage: outboxStorage,
    mutationFns,
    jitter: false,
    leaderElection: opts.leaderElection ?? nodeLeaderElection(),
    onlineDetector,
  });
  executorRef.current = executor;

  attachDeadLetterBootstrap(executor, poison);
  let mutationIdLoaded: Promise<void> | undefined;
  const initBeforeMutationId = executor.waitForInit.bind(executor);
  executor.waitForInit = async () => {
    await initBeforeMutationId();
    mutationIdLoaded ??= (async () => {
      const persisted = await readPersistedMutationId(mutationIdStore);
      const pendingIds = await Promise.all(
        (await executor.peekOutbox()).map(async (tx) => {
          const allocated = await readAllocatedMutationId(mutationIdStore, tx.idempotencyKey);
          if (allocated > 0) return allocated;
          const legacy = readEnvelopeMetadata(tx.metadata)?.mutation.mutationID;
          if (!isMutationSequence(legacy) || legacy === 0) return 0;
          await writeAllocatedMutationId(mutationIdStore, tx.idempotencyKey, legacy);
          return legacy;
        }),
      );
      localHighWater = Math.max(persisted, ...pendingIds);
      serverHighWater = Math.max(serverHighWater, opts.echo.getLastMutationId?.() ?? 0);
    })();
    await mutationIdLoaded;
  };
  opts.echo.setLocalWriteBootstrap?.(executor.waitForInit().then(() => executor.peekOutbox()));

  const mutate = {} as NizhalMutatorsResult<M>["mutate"];
  for (const [name, def] of Object.entries(opts.mutators) as [
    keyof M & string,
    NizhalMutatorDefinition,
  ][]) {
    mutate[name as keyof M] = ((args: unknown) => {
      const parsedArgs = def.schema.parse(args);
      const envelope: NizhalEnvelopeMetadata = {
        mutation: {
          name,
          args: parsedArgs,
          clientID,
          hlc: hlc.send(),
        },
        ...(def.dependsOn?.(parsedArgs) ? { dependsOn: def.dependsOn(parsedArgs) } : {}),
      };

      const offlineTx = executor.createOfflineTransaction({
        mutationFnName: name,
        autoCommit: false,
        metadata: {
          [NIZHAL_ENVELOPE_METADATA_KEY]: envelope,
        },
      });

      if (!("mutate" in offlineTx) || typeof offlineTx.mutate !== "function") {
        throw new Error("[@nizhal/db-collection] offline executor is not leader");
      }

      const transaction = offlineTx.mutate(() => {
        const result = def.fn(createClientMutatorCtx(opts.collections, opts.actor), parsedArgs);
        if (isPromiseLike(result)) {
          result.catch((error) => {
            queueMicrotask(() => {
              throw error;
            });
          });
        }
      });

      const transactionMutations = transaction.mutations as Array<
        PendingMutation<Record<string, unknown>>
      >;
      localCommits.register(offlineTx.id, transactionMutations);
      if (opts.echo.isRemoteSyncEnabled?.() !== false) {
        opts.echo.registerLocalWrite?.(offlineTx.id, rowsFromMutations(transactionMutations));
      }

      const commit = offlineTx.commit();
      pendingCommits.add(commit);
      commit.then(
        () => pendingCommits.delete(commit),
        () => pendingCommits.delete(commit),
      );
    }) as NizhalMutatorsResult<M>["mutate"][keyof M];
  }

  return {
    mutate,
    executor,
    deadLetter: poison.deadLetter,
    retryDeadLetter,
    onDeadLetterChange: (listener) => poison.onChange(listener),
    getPendingCount: () =>
      pendingCommits.size + executor.getPendingCount() + executor.getRunningCount(),
    waitForIdle: () => waitForIdle(executor, pendingCommits),
    dispose: () => disposeExecutor(executor, onlineDetector, bufferedOutbox),
  };

  async function allocatedMutationId(
    storage: MutationIdStorage,
    idempotencyKey: string,
    legacyMutationId: number | undefined,
  ): Promise<number> {
    serverHighWater = Math.max(serverHighWater, opts.echo.getLastMutationId?.() ?? 0);
    const allocated = await readAllocatedMutationId(storage, idempotencyKey);
    if (allocated > 0) {
      localHighWater = Math.max(localHighWater, allocated);
      await writePersistedMutationId(storage, localHighWater);
      return allocated;
    }
    const mutationID =
      isMutationSequence(legacyMutationId) && legacyMutationId > 0
        ? legacyMutationId
        : allocateMutationId(serverHighWater, localHighWater);
    await writeAllocatedMutationId(storage, idempotencyKey, mutationID);
    localHighWater = Math.max(localHighWater, mutationID);
    await writePersistedMutationId(storage, localHighWater);
    return mutationID;
  }

  async function reallocateFromServer(
    storage: MutationIdStorage,
    idempotencyKey: string,
    lastMutationId: number,
  ): Promise<number> {
    serverHighWater = Math.max(serverHighWater, lastMutationId);
    const mutationID = allocateMutationId(serverHighWater, 0);
    await writeAllocatedMutationId(storage, idempotencyKey, mutationID);
    localHighWater = mutationID;
    await writePersistedMutationId(storage, localHighWater);
    return mutationID;
  }

  async function withSequenceLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = sequenceTail;
    let release!: () => void;
    sequenceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // RFC-011 F-D: the push already succeeded durably; acknowledging the local write (a reconciliation
  // pull + barrier) is best-effort and MUST NOT block the executor's transaction from completing. A hung
  // ack previously left the executor's single `isRunning` flag stuck true — so getNext() returned null
  // forever and every later offline write was silently stranded. Bound it: if it has not settled within
  // the timeout, complete the transaction anyway; the normal pull cycle reconciles optimistic state.
  async function reconcileLocalWrite(transactionId: string): Promise<void> {
    const ack = opts.echo.acknowledgeLocalWrite?.(transactionId);
    if (!ack) return;
    ack.catch((error) => opts.echo.reportError("reconcile", error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ackReconcileTimeoutMs());
    });
    try {
      await Promise.race([
        ack.then(
          () => undefined,
          () => undefined,
        ),
        guard,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // The push core, shared by the live mutationFn and retryDeadLetter (RFC-011 F-B): allocate the
  // per-client mutation id under the sequence lock, push, and resync-then-retry on a sequence conflict.
  // Throws on failure so the caller decides whether to park (mutationFn) or re-park (retry).
  async function attemptPush(
    storedMutation: Pick<Mutation, "name" | "args" | "clientID" | "mutationID" | "hlc">,
    idempotencyKey: string,
    dependsOn: string | undefined,
  ): Promise<void> {
    await withSequenceLock(async () => {
      let mutationID = await allocatedMutationId(
        mutationIdStore,
        idempotencyKey,
        storedMutation.mutationID,
      );
      for (;;) {
        const nizhalMutation: Mutation = {
          ...storedMutation,
          clientMutationId: idempotencyKey,
          mutationID,
          ...(dependsOn ? { dependsOn } : {}),
        };
        const response = await opts.echo.push(nizhalMutation);
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
            mutationIdStore,
            idempotencyKey,
            response.lastMutationId,
          );
          continue;
        }
        break;
      }
    });
  }

  // RFC-011 F-B: take parked writes back out and re-attempt them. Returns how many recovered. On failure
  // the write is re-parked so it stays visible — a manual retry never silently drops it.
  async function retryDeadLetter(idempotencyKey?: string): Promise<number> {
    await executor.waitForInit();
    await poison.ensureLoaded();
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
  }
}

function memoryMutationIdStorage(): MutationIdStorage {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
  };
}

function isMutationSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readEnvelopeMetadata(
  metadata: Record<string, unknown> | undefined,
): NizhalEnvelopeMetadata | undefined {
  const raw = metadata?.[NIZHAL_ENVELOPE_METADATA_KEY];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const envelope = raw as NizhalEnvelopeMetadata;
  if (
    !envelope.mutation ||
    typeof envelope.mutation !== "object" ||
    typeof envelope.mutation.name !== "string"
  ) {
    return undefined;
  }
  return envelope;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function" &&
    "catch" in value &&
    typeof (value as { catch?: unknown }).catch === "function"
  );
}

function createClientMutatorCtx(collections: NizhalCollectionMap, actor: Actor) {
  return {
    tx: collectionMutatorTx(collections),
    location: "client" as const,
    actor,
    ownerId: actor.ownerId,
    userId: actor.userId,
    locationId: typeof actor.locationId === "string" ? actor.locationId : undefined,
    now: () => Date.now(),
    newId: () => safeRandomUUID(),
    jobs: noopJobs(),
    // Provisional client-side guess (local max + 1) for the optimistic UI; the server assigns the
    // authoritative value under a lock and the row rebases to it on the next pull.
    nextInBucket: async ({
      table,
      sequenceColumn,
      scopeColumn,
      scopeValue,
    }: {
      table: string;
      sequenceColumn: string;
      scopeColumn: string;
      scopeValue: string | number;
    }) => {
      const collection = collections[table];
      if (!collection) return 1;
      let max = 0;
      for (const row of collection.toArray as Record<string, unknown>[]) {
        if (String(row[scopeColumn]) !== String(scopeValue)) continue;
        const value = Number(row[sequenceColumn]);
        if (Number.isFinite(value) && value > max) max = value;
      }
      return max + 1;
    },
  };
}

function collectionMutatorTx(collections: NizhalCollectionMap): MutatorTx {
  return {
    insert(table) {
      return {
        async values(row) {
          collectionForTable(collections, table).insert(row as object);
          return [row];
        },
      };
    },
    update(table, where) {
      return {
        async set(patch) {
          const collection = collectionForTable(collections, table);
          for (const key of keysMatchingWhere(collection, where)) {
            collection.update(key, (draft) => {
              Object.assign(draft, patch);
            });
          }
          return [];
        },
      };
    },
    async delete(table, where) {
      const collection = collectionForTable(collections, table);
      for (const key of keysMatchingWhere(collection, where)) {
        collection.delete(key);
      }
      return [];
    },
  };
}

// Optimistic client update/delete: find the local rows matching the structured `where` and act on them
// by key. No drizzle-predicate reflection — the row key comes straight off the row (collections key by
// `id`), so this is engine/bundler-agnostic (the old queryChunks/brand/encoder path is gone).
function keysMatchingWhere(
  collection: NizhalCollectionMap[string],
  where: Record<string, unknown>,
): string[] {
  const clauses = Object.entries(where);
  const keys: string[] = [];
  for (const row of collection.toArray as Record<string, unknown>[]) {
    if (clauses.every(([field, value]) => row[field] === value)) {
      const id = row.id;
      if (id !== undefined && id !== null) keys.push(String(id));
    }
  }
  return keys;
}

function collectionForTable(collections: NizhalCollectionMap, table: Table) {
  const name = getTableName(table);
  const collection = collections[name];
  if (!collection) {
    throw new Error(`[@nizhal/db-collection] missing collection for table '${name}'`);
  }
  return collection;
}

function noopJobs(): JobScheduler {
  return {
    enqueue() {},
    scheduleAt() {},
  };
}

async function persistLocalFirstCollectionMutations(
  collections: NizhalCollectionMap,
  echo: NizhalClient,
  mutations: ReadonlyArray<PendingMutation<Record<string, unknown>>>,
): Promise<void> {
  const byCollection = new Map<string, Array<PendingMutation<Record<string, unknown>>>>();
  for (const mutation of mutations) {
    const collectionId = mutation.collection?.id;
    if (!collectionId) continue;
    const group = byCollection.get(collectionId) ?? [];
    group.push(mutation);
    byCollection.set(collectionId, group);
  }

  for (const [collectionId, collectionMutations] of byCollection) {
    const collection = collections[collectionId];
    if (!collection) continue;
    if (echo.isCollectionLocalFirst?.(collectionId) === false) continue;

    const acceptMutations = (
      collection as {
        utils?: { acceptMutations?: (transaction: { mutations: unknown[] }) => Promise<void> };
      }
    ).utils?.acceptMutations;
    if (!acceptMutations) {
      throw new Error(
        `[@nizhal/db-collection] local-first collection '${collectionId}' cannot accept mutations`,
      );
    }
    await acceptMutations({ mutations: [...collectionMutations] });
  }
}

async function disposeExecutor(
  executor: OfflineExecutor,
  onlineDetector: ControllableOnlineDetector,
  outboxStorage: BufferedSQLiteOutboxStorage | undefined,
): Promise<void> {
  onlineDetector.stop();
  executor.dispose();
  while (executor.getRunningCount() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await outboxStorage?.flush();
}

async function waitForIdle(
  executor: OfflineExecutor,
  pendingCommits: ReadonlySet<Promise<unknown>>,
): Promise<void> {
  for (;;) {
    const commits = [...pendingCommits];
    if (commits.length > 0) {
      await Promise.allSettled(commits);
      continue;
    }
    if (executor.getPendingCount() === 0 && executor.getRunningCount() === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function attachDeadLetterBootstrap(executor: OfflineExecutor, poison: PoisonGuard): void {
  const waitForInit = executor.waitForInit.bind(executor);
  executor.waitForInit = async () => {
    await waitForInit();
    await poison.ensureLoaded();
  };
}

class LocalCommitCoordinator {
  private readonly pending = new Map<
    string,
    ReadonlyArray<PendingMutation<Record<string, unknown>>>
  >();

  constructor(
    private readonly collections: NizhalCollectionMap,
    private readonly echo: NizhalClient,
  ) {}

  register(
    transactionId: string,
    mutations: ReadonlyArray<PendingMutation<Record<string, unknown>>>,
  ): void {
    this.pending.set(transactionId, mutations);
  }

  async commit(transactionId: string): Promise<void> {
    const mutations = this.pending.get(transactionId);
    if (!mutations) return;
    await persistLocalFirstCollectionMutations(this.collections, this.echo, mutations);
    this.pending.delete(transactionId);
  }
}

function localCommitStorage(
  storage: StorageAdapter,
  localCommits: LocalCommitCoordinator,
): StorageAdapter {
  return {
    get: (key) => storage.get(key),
    async set(key, value) {
      await storage.set(key, value);
      if (key.startsWith("tx:")) await localCommits.commit(key.slice(3));
    },
    delete: (key) => storage.delete(key),
    keys: () => storage.keys(),
    clear: () => storage.clear(),
  };
}

function nodeLeaderElection(): LeaderElection {
  return {
    requestLeadership: () => Promise.resolve(true),
    releaseLeadership: () => {},
    isLeader: () => true,
    onLeadershipChange: () => () => {},
  };
}

function nizhalOnlineDetector(): OnlineDetector {
  const listeners = new Set<() => void>();
  return {
    isOnline() {
      if (typeof navigator === "undefined") {
        return true;
      }
      if (typeof navigator.onLine === "boolean") {
        return navigator.onLine;
      }
      return true;
    },
    subscribe(callback) {
      listeners.add(callback);
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        const handler = () => callback();
        window.addEventListener("online", handler);
        return () => {
          listeners.delete(callback);
          window.removeEventListener("online", handler);
        };
      }
      return () => {
        listeners.delete(callback);
      };
    },
    notifyOnline() {
      for (const listener of listeners) {
        listener();
      }
    },
    dispose() {
      listeners.clear();
    },
  };
}

interface ControllableOnlineDetector extends OnlineDetector {
  stop(): void;
}

function controllableOnlineDetector(source: OnlineDetector): ControllableOnlineDetector {
  const listeners = new Set<() => void>();
  let stopped = false;
  const unsubscribe = source.subscribe(() => {
    for (const listener of listeners) listener();
  });
  return {
    isOnline: () => !stopped && source.isOnline(),
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    notifyOnline() {
      source.notifyOnline();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const listener of listeners) listener();
    },
    dispose() {
      stopped = true;
      listeners.clear();
      unsubscribe();
      source.dispose();
    },
  };
}
