import {
  type Actor,
  type DeriveSqliteSchemaOptions,
  type DerivedSqliteSchema,
  type SyncRules,
  createHlcClock,
  deriveSqliteSchema,
  describeSyncedTables,
  normalizeHlcNodeId,
} from "@nizhal/kernel";
import { createTableWatcher, deriveQueryTables } from "@nizhal/local";
import type { LiveResult, TableChangeSource, WatchOptions } from "@nizhal/local";
import type { OnlineDetector } from "@tanstack/offline-transactions";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { Table, is } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { NizhalClient } from "../client.js";
import { manualOnlineDetector } from "../manual-online-detector.js";
import type { MutationIdStorage } from "../mutation-id.js";
import type { DeadLetterStorage } from "../persistence/dead-letter-storage.js";
import type { NizhalMutatorDefinition, NizhalPoisonEntry } from "../types.js";
import { type WriteGate, createWriteGate } from "./atomic.js";
import { CONTROL_TABLE_DDL, nizhalMeta, nizhalOutbox } from "./control-schema.js";
import { createDeadLetterStore, createMetaStore } from "./meta.js";
import { createDrizzleClientMutatorCtx } from "./mutator-tx.js";
import { type PullLoop, createPullLoop } from "./pull.js";
import { type PushEngine, createPushEngine } from "./push.js";
import type { AnyDrizzleSqliteDb, DerivedTableMap } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: mutator arg types are per-definition; the map is heterogeneous.
type AnyMutators = Record<string, NizhalMutatorDefinition<any>>;

export interface OpenNizhalStoreOptions<
  Schema extends Record<string, unknown>,
  M extends AnyMutators,
> {
  echo: NizhalClient;
  /** The drizzle PG schema module — the ONE schema definition; client tables are derived. */
  schema: Schema;
  syncRules: SyncRules;
  mutators: M;
  actor: Actor;
  /** Any drizzle SQLite database (expo-sqlite / op-sqlite / wa-sqlite proxy / better-sqlite3). */
  database: AnyDrizzleSqliteDb;
  /** Platform change feed (update hooks) for out-of-band writes; the store's own writes notify
   *  watchers directly, so this is optional belt-and-braces. */
  changes?: TableChangeSource;
  onlineDetector?: OnlineDetector;
  derive?: DeriveSqliteSchemaOptions;
  onPoison?: (entry: NizhalPoisonEntry) => void;
  /** Transient push retry backoff base (tests pass a short one). */
  retryBaseMs?: number;
}

export interface NizhalStore<Schema extends Record<string, unknown>, M extends AnyMutators> {
  /** The real drizzle database — the full native query surface over the synced tables. */
  db: AnyDrizzleSqliteDb;
  /** Derived client tables, keyed by schema export name — use in the query builder. */
  tables: DerivedSqliteSchema<Schema>;
  mutate: { [K in keyof M]: (args: Parameters<M[K]["fn"]>[1]) => void };
  /** Live query: run now, re-run when watched tables change. Same contract as @nizhal/local. */
  watch<T>(
    query: PromiseLike<T>,
    onResult: (result: LiveResult<T>) => void,
    options?: WatchOptions,
  ): () => void;
  onlineDetector: OnlineDetector;
  deadLetter: readonly NizhalPoisonEntry[];
  retryDeadLetter(idempotencyKey?: string): Promise<number>;
  onDeadLetterChange(listener: () => void): () => void;
  getPendingCount(): Promise<number>;
  waitForIdle(): Promise<void>;
  /** First pull attempt for every sync rule has settled (local data is usable regardless). */
  ready(): Promise<void>;
  /** Pull every sync rule now (pull-to-refresh) and flush the outbox. */
  pullNow(): Promise<void>;
  dispose(): Promise<void>;
}

const SQLITE_TYPE_BY_COLUMN: Record<string, string> = {
  SQLiteText: "text",
  SQLiteTextJson: "text",
  SQLiteInteger: "integer",
  SQLiteTimestamp: "integer",
  SQLiteBoolean: "integer",
  SQLiteReal: "real",
  SQLiteNumeric: "numeric",
  SQLiteBigInt: "blob",
  SQLiteBlobJson: "blob",
  SQLiteBlobBuffer: "blob",
};

function tableDdl(table: SQLiteTable): string {
  const name = getTableName(table);
  const columns = Object.values(getTableColumns(table) as Record<string, SQLiteColumn>).map(
    (column) => {
      const sqlType = SQLITE_TYPE_BY_COLUMN[column.columnType];
      if (!sqlType) {
        throw new Error(
          `[@nizhal/db-collection] no SQLite DDL mapping for column type '${column.columnType}' on '${name}.${column.name}'`,
        );
      }
      const constraints = column.primary ? " PRIMARY KEY" : column.notNull ? " NOT NULL" : "";
      return `"${column.name}" ${sqlType}${constraints}`;
    },
  );
  return `CREATE TABLE IF NOT EXISTS "${name}" (${columns.join(", ")})`;
}

/**
 * The drizzle-native sync client (rfc-drizzle-native-sync-client): ONE SQLite file holding the
 * derived real tables + the outbox/meta/dead-letter control tables, so optimistic apply + enqueue
 * and pull-apply + cursor advance are each a single transaction. The query surface is drizzle
 * itself; reactivity is table-granular watch; the wire protocol (echo push/pull/subscribe) is the
 * proven engine, unchanged.
 */
export async function openNizhalStore<
  Schema extends Record<string, unknown>,
  M extends AnyMutators,
>(opts: OpenNizhalStoreOptions<Schema, M>): Promise<NizhalStore<Schema, M>> {
  const db = opts.database;
  const derived = deriveSqliteSchema(opts.schema, opts.derive);
  const byName: DerivedTableMap = {};
  for (const table of Object.values(derived)) {
    byName[getTableName(table as SQLiteTable)] = table as DerivedTableMap[string];
  }

  // Every table in the client schema must be covered by a sync rule (same gate as the legacy
  // store) — a table the server never syncs would just silently stay empty.
  const synced = describeSyncedTables(opts.syncRules);
  const bucketColumns: Record<string, string | undefined> = {};
  for (const [exportKey, value] of Object.entries(opts.schema)) {
    if (!is(value, Table)) continue;
    const tableName = getTableName(value);
    const info = synced.get(tableName);
    if (!info) {
      throw new Error(
        `[@nizhal/db-collection] openNizhalStore: table '${tableName}' (export '${exportKey}') has no sync rule — remove it from the schema or add a rule`,
      );
    }
    bucketColumns[tableName] = info.bucketColumns[0];
  }
  const syncRuleNames = [...new Set([...synced.values()].map((info) => info.syncRule))];

  // Bootstrap DDL (additive-only; schema evolution at alpha = re-derive + re-bootstrap).
  for (const ddl of CONTROL_TABLE_DDL) await db.run(sql.raw(ddl));
  for (const table of Object.values(byName)) await db.run(sql.raw(tableDdl(table)));

  // H1 canary: prove the full driver path reads back what it writes — a driver-shape mismatch
  // must be a loud boot error, never a silently-empty database.
  const canary = `canary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db
    .insert(nizhalMeta)
    .values({ key: "canary", value: canary })
    .onConflictDoUpdate({ target: nizhalMeta.key, set: { value: canary } });
  const canaryRow = await db
    .select({ value: nizhalMeta.value })
    .from(nizhalMeta)
    .where(sql`${nizhalMeta.key} = 'canary'`);
  if (canaryRow[0]?.value !== canary) {
    throw new Error(
      "[@nizhal/db-collection] startup canary failed — the SQLite driver did not read back a written row (H1)",
    );
  }

  const gate = createWriteGate();
  const meta = createMetaStore(db);
  const clientID = await meta.getOrCreateClientId();
  opts.echo.setDeviceId(clientID);
  const hlc = createHlcClock({ nodeId: normalizeHlcNodeId(clientID) });

  const gatedMeta: MutationIdStorage = {
    get: (key) => gate.run(db, () => meta.get(key)),
    set: (key, value) => gate.run(db, () => meta.set(key, value)),
  };
  const rawDeadLetter = createDeadLetterStore(db);
  const gatedDeadLetter: DeadLetterStorage = {
    list: () => gate.run(db, () => rawDeadLetter.list()),
    park: (entry) => gate.run(db, () => rawDeadLetter.park(entry)),
    remove: (key) => gate.run(db, () => rawDeadLetter.remove(key)),
    dispose: () => rawDeadLetter.dispose(),
  };

  const onlineDetector = opts.onlineDetector ?? manualOnlineDetector();
  const watcher = createTableWatcher();
  const stopChanges = opts.changes?.subscribe((table) => watcher.notify(table));

  const engine: PushEngine = createPushEngine({
    db,
    gate,
    echo: opts.echo,
    meta: gatedMeta,
    deadLetter: gatedDeadLetter,
    mutators: opts.mutators,
    onlineDetector,
    ...(opts.onPoison ? { onPoison: opts.onPoison } : {}),
    ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}),
  });

  const remoteEnabled = opts.echo.isRemoteSyncEnabled?.() !== false;
  let pull: PullLoop | undefined;
  const pokeUnsubs: Array<() => void> = [];
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  if (remoteEnabled) {
    pull = createPullLoop({
      db,
      gate,
      echo: opts.echo,
      meta,
      tables: byName,
      mutators: opts.mutators,
      actor: opts.actor,
      bucketColumns,
      syncRules: syncRuleNames,
      onTablesChanged: (tables) => {
        for (const table of tables) watcher.notify(table);
      },
    });
    for (const rule of syncRuleNames) {
      pokeUnsubs.push(
        opts.echo.subscribe(rule, () => {
          void pull?.requestPull(rule);
          engine.flush();
        }),
      );
    }
    const pullIntervalMs = opts.echo.getPullIntervalMs?.();
    if (pullIntervalMs !== undefined && pullIntervalMs > 0) {
      intervalTimer = setInterval(() => {
        for (const rule of syncRuleNames) void pull?.requestPull(rule);
        engine.flush();
      }, pullIntervalMs);
      if (typeof intervalTimer === "object" && "unref" in intervalTimer) intervalTimer.unref();
    }
    const flushOnOnline = onlineDetector.subscribe(() => {
      for (const rule of syncRuleNames) void pull?.requestPull(rule);
    });
    pokeUnsubs.push(flushOnOnline);
  }

  const pendingCommits = new Set<Promise<unknown>>();
  const mutate = {} as NizhalStore<Schema, M>["mutate"];
  for (const [name, def] of Object.entries(opts.mutators) as [
    keyof M & string,
    NizhalMutatorDefinition,
  ][]) {
    mutate[name as keyof M] = ((args: unknown) => {
      const parsedArgs = def.schema.parse(args);
      const idempotencyKey = crypto.randomUUID();
      const dependsOn = def.dependsOn?.(parsedArgs);
      const touched = new Set<string>();
      const commit = gate
        .run(db, async () => {
          const ctx = createDrizzleClientMutatorCtx(db, byName, opts.actor, (table) =>
            touched.add(table),
          );
          await def.fn(ctx, parsedArgs);
          if (remoteEnabled) {
            await db.insert(nizhalOutbox).values({
              idempotencyKey,
              envelope: { name, args: parsedArgs, clientID, hlc: hlc.send() },
              dependsOn: dependsOn ?? null,
              enqueuedAt: Date.now(),
            });
          }
        })
        .then(() => {
          for (const table of touched) watcher.notify(table);
          if (remoteEnabled) engine.flush();
        })
        .catch((error) => {
          opts.echo.reportError("push", error);
          throw error;
        });
      pendingCommits.add(commit);
      commit.then(
        () => pendingCommits.delete(commit),
        () => pendingCommits.delete(commit),
      );
    }) as NizhalStore<Schema, M>["mutate"][keyof M];
  }

  function watch<T>(
    query: PromiseLike<T>,
    onResult: (result: LiveResult<T>) => void,
    options?: WatchOptions,
  ): () => void {
    const tables = options?.tables ?? deriveQueryTables(query);
    let closedWatch = false;
    const run = () => {
      query.then(
        (data) => {
          if (!closedWatch) onResult({ data, error: undefined, updatedAt: new Date() });
        },
        (error: unknown) => {
          if (closedWatch) return;
          onResult({
            data: undefined,
            error: error instanceof Error ? error : new Error(String(error)),
            updatedAt: new Date(),
          });
        },
      );
    };
    run();
    const unsubscribe = watcher.subscribe(tables ? new Set(tables) : undefined, run);
    return () => {
      closedWatch = true;
      unsubscribe();
    };
  }

  await engine.waitForInit();
  if (remoteEnabled) engine.flush();

  return {
    db,
    tables: derived,
    mutate,
    watch,
    onlineDetector,
    deadLetter: engine.deadLetter,
    retryDeadLetter: (key) => engine.retryDeadLetter(key),
    onDeadLetterChange: (listener) => engine.onDeadLetterChange(listener),
    getPendingCount: () => engine.getPendingCount(),
    waitForIdle: async () => {
      while (pendingCommits.size > 0) await Promise.allSettled([...pendingCommits]);
      await engine.waitForIdle();
    },
    ready: async () => {
      await pull?.ready();
    },
    pullNow: async () => {
      engine.flush();
      await Promise.allSettled(syncRuleNames.map((rule) => pull?.requestPull(rule)));
    },
    dispose: async () => {
      pull?.dispose();
      for (const unsub of pokeUnsubs) unsub();
      if (intervalTimer) clearInterval(intervalTimer);
      stopChanges?.();
      await engine.dispose();
    },
  };
}
