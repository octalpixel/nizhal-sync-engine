import { type Cursor, INITIAL_CURSOR, type PullResult } from "@nizhal/kernel";
import {
  type ChangeMessageOrDeleteKeyMessage,
  type Collection,
  type PendingMutation,
  type SyncConfig,
  createTransaction,
} from "@tanstack/db";
import type { NizhalClient } from "./client.js";
import type { NizhalMode } from "./types.js";

export interface NizhalSyncOptions<Row extends object> {
  syncRule: string;
  tableName: string;
  echo: NizhalClient;
  getKey: (row: Row) => string;
  bucketField?: keyof Row & string;
  mode?: NizhalMode;
}

const BUCKET_SCOPE_META_PREFIX = "bucketScope:";

export function buildNizhalSyncConfig<Row extends object>(
  opts: NizhalSyncOptions<Row>,
): SyncConfig<Row, string> {
  const { syncRule, tableName, echo, getKey, bucketField, mode = "local-first" } = opts;
  return {
    rowUpdateMode: "full",
    sync: ({ collection, begin, write, commit, markReady, metadata }) => {
      let closed = false;
      let pendingPull = false;
      let activePull: Promise<boolean> | null = null;
      const bucketScopeState: Record<string, number> = {};

      const runPull = async (): Promise<boolean> => {
        if (closed) {
          return false;
        }
        try {
          await echo.waitForLocalWritesReady?.();
          const cursorKey = `cursor:${syncRule}`;
          const pageSize = echo.getPullPageSize();
          const storedCursor = metadata?.collection.get(cursorKey);
          let cursor: Cursor =
            typeof storedCursor === "string" ? storedCursor : echo.getCursor(syncRule);

          let keepPaging = true;
          while (keepPaging) {
            const result = (await echo.pull({
              cursor,
              syncRule,
              source: "sync",
              ...(pageSize !== undefined ? { limit: pageSize } : {}),
            })) as PullResult<Row>;
            if (closed) {
              return false;
            }
            if (result.cursorReset) {
              cursor = INITIAL_CURSOR;
              metadata?.collection.set(cursorKey, INITIAL_CURSOR);
              echo.setCursor(syncRule, INITIAL_CURSOR);
            }
            let blocked = false;
            if (mode === "local-first") {
              blocked = await applyLocalFirstPullResult({
                tableName,
                result,
                collection,
                getKey,
                bucketField,
                echo,
              });
            } else {
              applyPullResult({
                tableName,
                result,
                collection,
                getKey,
                bucketField,
                begin,
                write,
                commit,
                onBeforeCommit: () => {
                  metadata?.collection.set(cursorKey, result.cursor);
                  echo.setCursor(syncRule, result.cursor);
                },
              });
            }
            if (mode === "local-first") {
              await evictTtlBucketsLocalFirst({
                echo,
                syncRule,
                collection,
                bucketField,
                bucketScopeState,
                getKey,
                tableName,
              });
            }
            if (!blocked && mode === "local-first") {
              begin({ immediate: true });
              metadata?.collection.set(cursorKey, result.cursor);
              echo.setCursor(syncRule, result.cursor);
              commit();
            }
            if (mode === "server-authoritative") {
              evictTtlBuckets({
                echo,
                syncRule,
                collection,
                bucketField,
                metadata,
                bucketScopeState,
                begin,
                write,
                commit,
                getKey,
              });
            }
            cursor = result.cursor;
            if (blocked) {
              keepPaging = false;
              continue;
            }
            if (!pageSize) {
              keepPaging = false;
              continue;
            }
            const rowCount = countPullRows(result);
            keepPaging = result.hasMore === true || rowCount >= pageSize;
          }
          return true;
        } catch (error) {
          echo.reportError("pull", error);
          return false;
        }
      };

      const startPull = (): Promise<boolean> => {
        const pull = runPull();
        activePull = pull;
        void pull.finally(() => {
          if (activePull === pull) activePull = null;
          if (!closed && pendingPull) {
            pendingPull = false;
            void requestPull();
          }
        });
        return pull;
      };

      const requestPull = (): Promise<boolean> => {
        if (activePull) {
          pendingPull = true;
          return activePull;
        }
        return startPull();
      };

      const acknowledgementPull = async (): Promise<boolean> => {
        while (activePull) await activePull;
        return startPull();
      };

      void requestPull().then((succeeded) => {
        if (succeeded || mode === "local-first") markReady();
      });

      const unsub = echo.subscribe(syncRule, () => {
        void requestPull();
      });
      const unregisterPuller = echo.registerPuller?.(tableName, syncRule, acknowledgementPull);

      const pullIntervalMs = echo.getPullIntervalMs?.();
      const intervalTimer =
        pullIntervalMs !== undefined && pullIntervalMs > 0
          ? setInterval(() => {
              void requestPull();
            }, pullIntervalMs)
          : null;
      if (intervalTimer && typeof intervalTimer === "object" && "unref" in intervalTimer) {
        intervalTimer.unref();
      }

      return () => {
        closed = true;
        pendingPull = false;
        unsub();
        unregisterPuller?.();
        if (intervalTimer) clearInterval(intervalTimer);
      };
    },
  };
}

async function applyLocalFirstPullResult<Row extends object>(input: {
  tableName: string;
  result: PullResult<Row>;
  collection: Collection<Row, string>;
  getKey: (row: Row) => string;
  bucketField?: keyof Row & string;
  echo: NizhalClient;
}): Promise<boolean> {
  const { tableName, result, collection, getKey, bucketField, echo } = input;
  const upserts = new Map<string, Row>();
  const deletes = new Set<string>();
  let blocked = false;

  const stageDelete = (key: string) => {
    if (echo.isLocalWriteBlocked?.(tableName, key)) {
      blocked = true;
      echo.reportError(
        "conflict",
        new Error(`authoritative delete deferred for unacknowledged ${tableName}:${key}`),
      );
      return;
    }
    upserts.delete(key);
    deletes.add(key);
  };

  const stageUpsert = (row: Row) => {
    const key = getKey(row);
    if (echo.isLocalWriteBlocked?.(tableName, key)) {
      blocked = true;
      const pendingFields = echo.getPendingLocalFields?.(tableName, key) ?? new Set(["*"]);
      const current = collection.get(key);
      if (current && !pendingFields.has("*")) {
        const merged = { ...(row as Record<string, unknown>) };
        const currentRecord = current as Record<string, unknown>;
        for (const field of pendingFields) merged[field] = currentRecord[field];
        upserts.set(key, merged as Row);
      }
      echo.reportError(
        "conflict",
        new Error(`authoritative row deferred for unacknowledged ${tableName}:${key}`),
      );
      return;
    }
    deletes.delete(key);
    upserts.set(key, row);
  };

  if (result.removedBuckets?.length) {
    const removedBuckets = new Set(result.removedBuckets);
    for (const row of collection.toArray) {
      const bucket = bucketField ? row[bucketField] : undefined;
      if (!bucketField || (bucket !== undefined && removedBuckets.has(String(bucket)))) {
        stageDelete(getKey(row));
      }
    }
  }

  for (const batch of result.changed) {
    if (batch.table !== tableName) continue;
    for (const row of batch.rows) stageUpsert(row);
  }
  for (const tombstone of result.tombstoned) {
    if (tombstone.table === tableName) stageDelete(tombstone.key ?? tombstone.id);
  }
  for (const removal of result.removed ?? []) {
    if (removal.table === tableName) stageDelete(removal.key ?? removal.id);
  }

  await commitLocalOperations(collection, tableName, upserts, deletes);
  return blocked;
}

async function commitLocalOperations<Row extends object>(
  collection: Collection<Row, string>,
  tableName: string,
  upserts: ReadonlyMap<string, Row>,
  deletes: ReadonlySet<string>,
): Promise<void> {
  if (upserts.size === 0 && deletes.size === 0) return;

  const acceptMutations = (
    collection as Collection<Row, string> & {
      utils: {
        acceptMutations(transaction: {
          mutations: Array<PendingMutation<Record<string, unknown>>>;
        }): Promise<void> | void;
      };
    }
  ).utils?.acceptMutations;
  if (typeof acceptMutations !== "function") {
    throw new Error(
      `[@nizhal/db-collection] local-first collection '${tableName}' cannot accept persisted mutations`,
    );
  }

  const transaction = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction: committed }) => {
      await acceptMutations({
        mutations: committed.mutations as Array<PendingMutation<Record<string, unknown>>>,
      });
    },
  });
  transaction.mutate(() => {
    for (const key of deletes) {
      if (collection.has(key)) collection.delete(key);
    }
    for (const [key, row] of upserts) {
      if (!collection.has(key)) {
        collection.insert(row);
        continue;
      }
      collection.update(key, (draft) => replaceRow(draft, row));
    }
  });
  await transaction.commit();
}

function replaceRow(draft: object, replacement: object): void {
  const draftRecord = draft as Record<string, unknown>;
  const replacementRecord = replacement as Record<string, unknown>;
  for (const key of Object.keys(draftRecord)) {
    if (!key.startsWith("$") && !(key in replacementRecord)) delete draftRecord[key];
  }
  Object.assign(draftRecord, replacementRecord);
}

async function evictTtlBucketsLocalFirst<Row extends object>(input: {
  echo: NizhalClient;
  syncRule: string;
  collection: Collection<Row, string>;
  bucketField?: keyof Row & string;
  bucketScopeState: Record<string, number>;
  getKey: (row: Row) => string;
  tableName: string;
}): Promise<void> {
  const ttlMs = input.echo.getBucketTtlMs();
  if (!ttlMs || !input.bucketField) return;

  const now = Date.now();
  const inScope = new Set(input.echo.getScopeBuckets(input.syncRule).map(String));
  const localBuckets = new Set<string>();
  for (const row of input.collection.toArray) {
    const bucket = row[input.bucketField];
    if (bucket !== undefined && bucket !== null) localBuckets.add(String(bucket));
  }

  for (const bucket of inScope) delete input.bucketScopeState[bucket];
  for (const bucket of localBuckets) {
    if (!inScope.has(bucket) && input.bucketScopeState[bucket] === undefined) {
      input.bucketScopeState[bucket] = now;
    }
  }

  const expired = new Set(
    Object.entries(input.bucketScopeState)
      .filter(([, since]) => now - since >= ttlMs)
      .map(([bucket]) => bucket),
  );
  if (expired.size === 0) return;

  const deletes = new Set<string>();
  for (const row of input.collection.toArray) {
    const bucket = row[input.bucketField];
    if (bucket !== undefined && bucket !== null && expired.has(String(bucket))) {
      const key = input.getKey(row);
      if (!input.echo.isLocalWriteBlocked?.(input.tableName, key)) deletes.add(key);
    }
  }
  for (const bucket of expired) delete input.bucketScopeState[bucket];
  await commitLocalOperations(input.collection, input.tableName, new Map(), deletes);
}

function countPullRows(result: PullResult | null): number {
  if (!result) return 0;
  return (
    result.changed.reduce((sum, batch) => sum + batch.rows.length, 0) +
    result.tombstoned.length +
    (result.removed?.length ?? 0)
  );
}

export function applyPullResult<Row extends object>(input: {
  tableName: string;
  result: PullResult<Row>;
  collection: Collection<Row, string>;
  getKey: (row: Row) => string;
  bucketField?: keyof Row & string;
  begin: (options?: { immediate?: boolean }) => void;
  write: (message: ChangeMessageOrDeleteKeyMessage<Row, string>) => void;
  commit: () => void;
  onBeforeCommit?: () => void;
}): void {
  const {
    tableName,
    result,
    collection,
    getKey,
    bucketField,
    begin,
    write,
    commit,
    onBeforeCommit,
  } = input;

  begin({ immediate: true });

  if (result.removedBuckets?.length) {
    purgeRemovedBuckets(collection, result.removedBuckets, bucketField, getKey, write);
  }

  for (const batch of result.changed) {
    if (batch.table !== tableName) continue;
    for (const row of batch.rows) {
      const key = getKey(row);
      const type = collection.has(key) ? "update" : "insert";
      write({ type, value: row });
    }
  }

  for (const tombstone of result.tombstoned) {
    if (tombstone.table !== tableName) continue;
    write({ type: "delete", key: tombstone.key ?? tombstone.id });
  }

  for (const removal of result.removed ?? []) {
    if (removal.table !== tableName) continue;
    write({ type: "delete", key: removal.key ?? removal.id });
  }

  onBeforeCommit?.();
  commit();
}

function evictTtlBuckets<Row extends object>(input: {
  echo: NizhalClient;
  syncRule: string;
  collection: Collection<Row, string>;
  bucketField?: keyof Row & string;
  metadata?: {
    collection: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
  };
  bucketScopeState: Record<string, number>;
  begin: (options?: { immediate?: boolean }) => void;
  write: (message: ChangeMessageOrDeleteKeyMessage<Row, string>) => void;
  commit: () => void;
  getKey: (row: Row) => string;
}): void {
  const ttlMs = input.echo.getBucketTtlMs();
  if (!ttlMs || !input.bucketField) return;

  const scopeKey = `${BUCKET_SCOPE_META_PREFIX}${input.syncRule}`;
  const now = Date.now();
  const inScope = new Set(input.echo.getScopeBuckets(input.syncRule).map(String));
  const tracked = readBucketScopeState(input.metadata, scopeKey, input.bucketScopeState);
  const nextTracked: Record<string, number> = { ...tracked };

  for (const bucket of inScope) {
    delete nextTracked[bucket];
  }

  const localBuckets = new Set<string>();
  for (const row of input.collection.toArray) {
    const bucket = row[input.bucketField];
    if (bucket !== undefined && bucket !== null) localBuckets.add(String(bucket));
  }

  for (const bucket of localBuckets) {
    if (inScope.has(bucket)) continue;
    if (nextTracked[bucket] === undefined) {
      nextTracked[bucket] = now;
    }
  }

  const expired = Object.entries(nextTracked).filter(([, since]) => now - since >= ttlMs);
  if (expired.length === 0) {
    input.begin({ immediate: true });
    writeBucketScopeState(input.metadata, scopeKey, nextTracked, input.bucketScopeState);
    input.commit();
    return;
  }

  const evict = new Set(expired.map(([bucket]) => bucket));
  input.begin({ immediate: true });
  for (const row of input.collection.toArray) {
    const bucket = row[input.bucketField];
    if (bucket !== undefined && bucket !== null && evict.has(String(bucket))) {
      input.write({ type: "delete", key: input.getKey(row) });
    }
  }
  for (const [bucket] of expired) {
    delete nextTracked[bucket];
  }
  writeBucketScopeState(input.metadata, scopeKey, nextTracked, input.bucketScopeState);
  input.commit();
}

function readBucketScopeState(
  metadata: { collection: { get: (key: string) => unknown } } | undefined,
  scopeKey: string,
  fallback: Record<string, number>,
): Record<string, number> {
  const stored = metadata?.collection.get(scopeKey) as Record<string, number> | undefined;
  if (stored) return { ...stored, ...fallback };
  return { ...fallback };
}

function writeBucketScopeState(
  metadata: { collection: { set: (key: string, value: unknown) => void } } | undefined,
  scopeKey: string,
  state: Record<string, number>,
  fallback: Record<string, number>,
): void {
  for (const key of Object.keys(fallback)) {
    delete fallback[key];
  }
  Object.assign(fallback, state);
  metadata?.collection.set(scopeKey, state);
}

function purgeRemovedBuckets<Row extends object>(
  collection: Collection<Row, string>,
  removedBuckets: string[],
  bucketField: (keyof Row & string) | undefined,
  getKey: (row: Row) => string,
  write: (message: ChangeMessageOrDeleteKeyMessage<Row, string>) => void,
): void {
  if (!bucketField) {
    for (const row of collection.toArray) {
      write({ type: "delete", key: getKey(row) });
    }
    return;
  }

  const removed = new Set(removedBuckets);
  for (const row of collection.toArray) {
    const bucket = row[bucketField];
    if (bucket !== undefined && bucket !== null && removed.has(String(bucket))) {
      write({ type: "delete", key: getKey(row) });
    }
  }
}
