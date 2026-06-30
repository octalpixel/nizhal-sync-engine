import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineMutator, defineMutators } from "@nizhal/kernel";
import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";
import { createCollection } from "@tanstack/db";
import type { SQLiteDriver } from "@tanstack/db-sqlite-persistence-core";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NizhalClient,
  type NizhalSQLitePersistence,
  createNizhalMutators,
  createSerializedWaSqliteDatabase,
  nizhalCollectionOptions,
  waSqlitePersistence,
} from "../src/index.js";
import {
  NIZHAL_CLIENT_STORE_VERSION,
  NizhalClientStoreVersionError,
  migrateClientStore,
} from "../src/persistence/migrate.js";
import { NodeFileVFS } from "./node-file-vfs.js";

interface NoteRow {
  id: string;
  body: string;
}

interface WaSqliteEnv {
  openDatabase(name: string): Promise<BrowserWASQLiteDatabase & { close(): Promise<void> }>;
  close(): Promise<void>;
  rootDir: string;
}

interface LedgerEntryRow {
  id: string;
  shop_id: string;
  customer_id: string;
  amount: string;
  reason: string | null;
  ref: string | null;
  at: Date;
  created_by: string;
  client_id: string;
}

const ledger_entries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  shop_id: text("shop_id").notNull(),
  customer_id: text("customer_id").notNull(),
  amount: text("amount").notNull(),
  reason: text("reason"),
  ref: text("ref"),
  at: text("at").notNull(),
  created_by: text("created_by").notNull(),
  client_id: text("client_id"),
});

const ledgerMutators = defineMutators({
  recordCredit: defineMutator({ parse: parseRecordCredit }, async ({ tx, actor }, args) => {
    const at = new Date(args.at ?? Date.now());
    await tx.insert(ledger_entries).values({
      id: args.clientId,
      shop_id: "shop-a",
      customer_id: args.customerId,
      amount: String(args.amount),
      reason: args.reason ?? null,
      ref: args.ref ?? null,
      at,
      created_by: actor.userId,
      client_id: args.clientId,
    });
    return { affectedBuckets: ["shop-a"] };
  }),
});

const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
});

const noteMutators = defineMutators({
  addNote: defineMutator({ parse: parseAddNote }, async ({ tx }, args) => {
    await tx.insert(notes).values({ id: args.id, body: args.body });
    return { affectedBuckets: ["owner-1"] };
  }),
});

describe("@nizhal/db-collection persistence", () => {
  const envs: WaSqliteEnv[] = [];

  afterEach(async () => {
    for (const env of envs.splice(0)) {
      await env.close();
      await rm(env.rootDir, { recursive: true, force: true });
    }
  });

  it("test:wa-sqlite-roundtrip — synced rows and outbox survive close/reopen", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const syncedNote: NoteRow = { id: "note-synced", body: "from server pull" };

    const db1 = await env.openDatabase("roundtrip.db");
    const store1 = await waSqlitePersistence({ database: db1 });

    const echo1 = createOnlineNizhal({ syncedNotes: [syncedNote] });
    const collection1 = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        echo: echo1,
        getKey: (row) => row.id,
        persistence: store1.persistence,
      }),
    );

    await collection1.preload();
    await waitFor(() => collection1.toArray.some((n) => n.id === "note-synced"));
    expect(collection1.toArray.find((n) => n.id === "note-synced")?.body).toBe("from server pull");
    await waitForPersistedRow(store1, "note-synced");

    await collection1.cleanup();
    await db1.close();

    const db2 = await env.openDatabase("roundtrip.db");
    const store2 = await waSqlitePersistence({ database: db2 });

    const echo2 = createOfflineNizhal();
    const collection2 = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        echo: echo2,
        getKey: (row) => row.id,
        persistence: store2.persistence,
      }),
    );

    await collection2.preload();
    await waitFor(() => collection2.toArray.some((n) => n.id === "note-synced"));
    expect(collection2.toArray.find((n) => n.id === "note-synced")?.body).toBe("from server pull");

    const { mutate: mutate2, executor: executor2 } = createNizhalMutators({
      collections: { notes: collection2 },
      echo: echo2,
      actor: { userId: "user-1", ownerId: "owner-1" },
      mutators: noteMutators,
      outboxStorage: store2.outboxStorage,
      deadLetterStorage: store2.deadLetterStorage,
      clientID: store2.clientId,
    });
    await executor2.waitForInit();

    mutate2.addNote({ id: "note-1", body: "persisted across restart" });

    await waitFor(() => executor2.getPendingCount() > 0);
    expect(collection2.toArray.some((n) => n.id === "note-1")).toBe(true);
    await waitForAsyncPersist();
    await store2.flushOutbox();

    executor2.dispose();
    await collection2.cleanup();
    await db2.close();

    const db3 = await env.openDatabase("roundtrip.db");
    const store3 = await waSqlitePersistence({ database: db3 });

    const echo3 = createOfflineNizhal();
    const collection3 = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        echo: echo3,
        getKey: (row) => row.id,
        persistence: store3.persistence,
      }),
    );

    const { executor: executor3 } = createNizhalMutators({
      collections: { notes: collection3 },
      echo: echo3,
      actor: { userId: "user-1", ownerId: "owner-1" },
      mutators: noteMutators,
      outboxStorage: store3.outboxStorage,
      deadLetterStorage: store3.deadLetterStorage,
      clientID: store3.clientId,
    });

    await collection3.preload();
    await executor3.waitForInit();

    const persistedRows = await resolvePersistenceAdapter(store3).scanRows("notes");
    expect(persistedRows.some((row) => String(row.key) === "note-synced")).toBe(true);

    await waitFor(() => collection3.toArray.some((n) => n.id === "note-synced"));
    await waitFor(() => collection3.toArray.some((n) => n.id === "note-1"));
    expect(collection3.toArray.find((n) => n.id === "note-synced")?.body).toBe("from server pull");
    expect(collection3.toArray.find((n) => n.id === "note-1")?.body).toBe(
      "persisted across restart",
    );

    const outbox = await executor3.peekOutbox();
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox[0]?.mutationFnName).toBe("addNote");

    await collection3.cleanup();
    executor3.dispose();
    await db3.close();
  });

  it("test:migrate-client-store — v1→v2 preserves outbox data; forward version fails safe", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db = await env.openDatabase("migrate.db");
    const driver = createTestDriver(db);

    await migrateClientStore(driver, {
      targetVersion: 1,
      migrations: [
        {
          version: 1,
          async up(d) {
            await d.exec(
              "CREATE TABLE IF NOT EXISTS _nizhal_outbox (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            );
          },
        },
      ],
    });

    await driver.run("INSERT INTO _nizhal_outbox (key, value) VALUES (?, ?)", [
      "keep",
      JSON.stringify({ hello: "world" }),
    ]);

    await migrateClientStore(driver, {
      targetVersion: 2,
      migrations: [
        {
          version: 1,
          async up(d) {
            await d.exec(
              "CREATE TABLE IF NOT EXISTS _nizhal_outbox (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            );
          },
        },
        {
          version: 2,
          async up(d) {
            await d.exec(
              "CREATE TABLE IF NOT EXISTS _nizhal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            );
          },
        },
      ],
    });

    const rows = await driver.query<{ key: string; value: string }>(
      "SELECT key, value FROM _nizhal_outbox WHERE key = ?",
      ["keep"],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.value)).toEqual({ hello: "world" });

    const metaTables = await driver.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ["_nizhal_meta"],
    );
    expect(metaTables).toHaveLength(1);

    await expect(
      migrateClientStore(driver, {
        targetVersion: 1,
        migrations: [
          {
            version: 1,
            async up(d) {
              await d.exec(
                "CREATE TABLE IF NOT EXISTS _nizhal_outbox (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
              );
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NizhalClientStoreVersionError);

    await db.close();
  });

  it("test:wa-sqlite-outbox-burst — parallel outbox writes do not trip sqlite misuse", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db = await env.openDatabase("burst.db");
    const store = await waSqlitePersistence({ database: db });
    const { outboxStorage } = store;

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        outboxStorage.set(`tx:burst-${index}`, JSON.stringify({ index, ok: true })),
      ),
    );
    await store.flushOutbox();

    const keys = await outboxStorage.keys();
    expect(keys.filter((key) => key.startsWith("tx:burst-"))).toHaveLength(12);

    await db.close();
  });

  it("test:wa-sqlite-outbox-50-cycle — insert/delete outbox rows under serialized driver", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db = await env.openDatabase("cycle.db");
    const store = await waSqlitePersistence({ database: db });
    const { outboxStorage } = store;

    for (let i = 0; i < 50; i += 1) {
      const key = `tx:cycle-${i}`;
      await outboxStorage.set(key, JSON.stringify({ i }));
      await outboxStorage.delete(key);
    }
    await store.flushOutbox();

    const keys = await outboxStorage.keys();
    expect(keys.filter((key) => key.startsWith("tx:cycle-"))).toHaveLength(0);

    await db.close();
  });

  it("test:wa-sqlite-persist-outbox-interleave — applyCommittedTx interleaved with outbox writes", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db = await env.openDatabase("interleave.db");
    const store = await waSqlitePersistence({ database: db });
    const adapter = resolvePersistenceAdapter(store, "stock_movements");
    const { outboxStorage } = store;
    const at = new Date("2026-06-25T12:00:00.000Z");

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        (async () => {
          await adapter.applyCommittedTx("stock_movements", {
            txId: `tx-${index}`,
            term: 1,
            seq: index + 1,
            rowVersion: index + 1,
            mutations: [
              {
                type: "insert",
                key: `mov-${index}`,
                value: {
                  id: `mov-${index}`,
                  location_id: "loc-1",
                  asset_id: "asset-1",
                  qty: "-1",
                  reason: "sale",
                  ref: `sale-${index}`,
                  at,
                  client_id: `mov-${index}`,
                },
              },
            ],
          });
          const key = `tx:interleave-${index}`;
          await outboxStorage.set(key, JSON.stringify({ index }));
          await outboxStorage.delete(key);
        })(),
      ),
    );
    await store.flushOutbox();

    await db.close();
  });

  it("test:wa-sqlite-offline-50-burst — partitioned push with 50 offline writes", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db = await env.openDatabase("offline-burst.db");
    const store = await waSqlitePersistence({ database: db });
    const echo = createPartitionedNizhal();
    const collection = createCollection(
      nizhalCollectionOptions<NoteRow>({
        name: "notes",
        syncRule: "ownerBucket",
        echo,
        getKey: (row) => row.id,
        persistence: store.persistence,
      }),
    );

    await collection.preload();

    const { mutate, executor, dispose, getPendingCount } = createNizhalMutators({
      collections: { notes: collection },
      echo,
      actor: { userId: "user-1", ownerId: "owner-1" },
      mutators: noteMutators,
      outboxStorage: store.outboxStorage,
      deadLetterStorage: store.deadLetterStorage,
      clientID: store.clientId,
    });
    await executor.waitForInit();

    for (let i = 0; i < 50; i += 1) {
      mutate.addNote({ id: `note-${i}`, body: `body-${i}` });
    }

    expect(getPendingCount()).toBeGreaterThan(0);
    expect(collection.toArray).toHaveLength(50);

    await waitFor(async () => (await executor.peekOutbox()).length === 50);
    await store.flushOutbox();

    executor.dispose();
    await collection.cleanup();
    await dispose();
    await store.dispose();
    await db.close();
  });

  it("test:wa-sqlite-bind-coercion — applyCommittedTx accepts complex domain row values", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db = await env.openDatabase("bind-coercion.db");
    const store = await waSqlitePersistence({ database: db });
    const adapter = resolvePersistenceAdapter(store, "ledger_entries");
    const at = new Date("2026-06-25T12:00:00.000Z");

    await adapter.applyCommittedTx("ledger_entries", {
      txId: "tx-ledger-1",
      term: 1,
      seq: 1,
      rowVersion: 1,
      mutations: [
        {
          type: "insert",
          key: "entry-1",
          value: {
            id: "entry-1",
            shop_id: "shop-a",
            customer_id: "customer-a",
            amount: "150.5",
            reason: "goods on credit",
            ref: null,
            at,
            created_by: "user-a",
            client_id: "entry-1",
          },
        },
      ],
    });

    const rows = await adapter.scanRows("ledger_entries");
    const restored = rows.find((row) => String(row.key) === "entry-1")?.value as LedgerEntryRow;
    expect(restored.amount).toBe("150.5");
    expect(restored.reason).toBe("goods on credit");
    expect(restored.ref).toBeNull();
    expect(restored.at).toEqual(at);

    await db.close();
  });

  it("test:wa-sqlite-ledger-row — complex domain row survives offline write and restart", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db1 = await env.openDatabase("ledger.db");
    const store1 = await waSqlitePersistence({ database: db1 });

    const echo1 = createOfflineNizhal();
    const collection1 = createCollection(
      nizhalCollectionOptions<LedgerEntryRow>({
        name: "ledger_entries",
        syncRule: "shopBucket",
        echo: echo1,
        getKey: (row) => row.client_id ?? row.id,
        persistence: store1.persistence,
      }),
    );

    await collection1.preload();

    const { mutate: mutate1, executor: executor1 } = createNizhalMutators({
      collections: { ledger_entries: collection1 },
      echo: echo1,
      actor: { userId: "user-a", ownerId: "owner-a", shopId: "shop-a" },
      mutators: ledgerMutators,
      outboxStorage: store1.outboxStorage,
      deadLetterStorage: store1.deadLetterStorage,
      clientID: store1.clientId,
    });
    await executor1.waitForInit();

    mutate1.recordCredit({
      clientId: "entry-1",
      customerId: "customer-a",
      amount: 150.5,
      reason: "goods on credit",
      at: "2026-06-25T12:00:00.000Z",
    });

    await waitFor(() => executor1.getPendingCount() > 0);
    expect(collection1.toArray.some((row) => row.client_id === "entry-1")).toBe(true);
    await waitForAsyncPersist();
    await store1.flushOutbox();

    executor1.dispose();
    await collection1.cleanup();
    await db1.close();

    const db2 = await env.openDatabase("ledger.db");
    const store2 = await waSqlitePersistence({ database: db2 });
    const echo2 = createOfflineNizhal();
    const collection2 = createCollection(
      nizhalCollectionOptions<LedgerEntryRow>({
        name: "ledger_entries",
        syncRule: "shopBucket",
        echo: echo2,
        getKey: (row) => row.client_id ?? row.id,
        persistence: store2.persistence,
      }),
    );

    const { executor: executor2 } = createNizhalMutators({
      collections: { ledger_entries: collection2 },
      echo: echo2,
      actor: { userId: "user-a", ownerId: "owner-a", shopId: "shop-a" },
      mutators: ledgerMutators,
      outboxStorage: store2.outboxStorage,
      deadLetterStorage: store2.deadLetterStorage,
      clientID: store2.clientId,
    });

    await collection2.preload();
    await executor2.waitForInit();
    await waitFor(() => collection2.toArray.some((row) => row.client_id === "entry-1"));

    const restored = collection2.toArray.find((row) => row.client_id === "entry-1");
    expect(restored?.amount).toBe("150.5");
    expect(restored?.reason).toBe("goods on credit");
    expect(restored?.ref).toBeNull();
    expect(restored?.at).toEqual(new Date("2026-06-25T12:00:00.000Z"));

    executor2.dispose();
    await collection2.cleanup();
    await db2.close();
  });

  it("test:default-migrations — waSqlitePersistence stamps current version and creates outbox table", async () => {
    const env = await createWaSqliteEnv();
    envs.push(env);

    const db = await env.openDatabase("default-migrate.db");
    await waSqlitePersistence({ database: db });

    const driver = createTestDriver(db);
    const versionRows = await driver.query<{ version: number }>(
      "SELECT version FROM _nizhal_store_version WHERE id = 1",
    );
    expect(versionRows[0]?.version).toBe(NIZHAL_CLIENT_STORE_VERSION);

    const outboxRows = await driver.query<{ count: number }>(
      "SELECT count(*) as count FROM _nizhal_outbox",
    );
    expect(outboxRows[0]?.count).toBe(0);

    await db.close();
  });
});

async function createWaSqliteEnv(): Promise<WaSqliteEnv> {
  const rootDir = await mkdtemp(join(tmpdir(), "echo-wa-sqlite-"));

  const [{ default: SQLiteESMFactory }, SQLite] = await Promise.all([
    import("wa-sqlite/dist/wa-sqlite.mjs"),
    import("wa-sqlite"),
  ]);

  const wasmBinary = await readFile(
    new URL("../node_modules/wa-sqlite/dist/wa-sqlite.wasm", import.meta.url),
  );
  const module = await SQLiteESMFactory({ wasmBinary });
  const sqliteModule = SQLite as {
    Factory: (module: unknown) => WaSqliteApi;
    SQLITE_ROW: number;
    SQLITE_DONE: number;
  };
  const sqlite3 = sqliteModule.Factory(module);
  const vfs = new NodeFileVFS(rootDir);
  sqlite3.vfs_register(vfs, false);
  const openFlags = 0x2 | 0x4;

  return {
    async openDatabase(name) {
      const dbId = await sqlite3.open_v2(name, openFlags, vfs.name);
      return createSerializedWaSqliteDatabase({
        sqlite3,
        dbId,
        sqliteRow: sqliteModule.SQLITE_ROW,
        sqliteDone: sqliteModule.SQLITE_DONE,
      });
    },
    async close() {
      vfs.close();
    },
    rootDir,
  };
}

interface WaSqliteApi {
  vfs_register(vfs: unknown, makeDefault: boolean): void;
  open_v2(name: string, flags?: number, vfsName?: string): Promise<number>;
  close(db: number): Promise<void>;
  statements(db: number, sql: string): AsyncIterable<number>;
  bind_collection(statement: number, params: ReadonlyArray<unknown>): void;
  column_names(statement: number): ReadonlyArray<string>;
  step(statement: number): Promise<number>;
  row(statement: number): ReadonlyArray<unknown>;
}

function createTestDriver(database: BrowserWASQLiteDatabase): SQLiteDriver {
  return {
    exec: async (sql) => {
      await database.execute(sql);
    },
    query: async <T>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const rows = await database.execute<T>(sql, params);
      return rows ?? [];
    },
    run: async (sql, params = []) => {
      await database.execute(sql, params);
    },
    transaction: async <T>(fn: (driver: SQLiteDriver) => Promise<T>) => {
      await database.execute("BEGIN IMMEDIATE");
      const txDriver = createTestDriver(database);
      try {
        const result = await fn(txDriver);
        await database.execute("COMMIT");
        return result;
      } catch (error) {
        await database.execute("ROLLBACK");
        throw error;
      }
    },
  };
}

function createOfflineNizhal(): NizhalClient {
  return {
    pull: async () => ({ changed: [], tombstoned: [], cursor: "" }),
    push: () => new Promise<void>(() => {}),
    subscribe: () => () => {},
    subscribePresence: () => () => {},
    onPresence: () => () => {},
    track: () => {},
    untrack: () => {},
    presenceState: () => ({}),
    presence: () => [],
    getCursor: () => "",
    setCursor: () => {},
    getScopeBuckets: () => [],
    getPullPageSize: () => undefined,
    getBucketTtlMs: () => undefined,
    setDeviceId: () => {},
    syncStatus: () => ({
      connectivity: "offline",
      pendingMutations: 0,
      deadLettered: 0,
      lastPullCursor: "",
      lastPulledAt: null,
    }),
    onSyncStatus: () => () => {},
    outbox: {
      list: async () => [],
      deadLetter: () => [],
    },
  };
}

function createPartitionedNizhal(): NizhalClient {
  const offline = createOfflineNizhal();
  return {
    ...offline,
    push: async () => {
      throw new Error("partitioned: push blocked");
    },
  };
}

function createOnlineNizhal(options: { syncedNotes: NoteRow[] }): NizhalClient {
  let pullCount = 0;
  let cursor = "";

  return {
    pull: async () => {
      pullCount += 1;
      if (pullCount === 1) {
        cursor = 1;
        return {
          changed: [{ table: "notes", rows: options.syncedNotes }],
          tombstoned: [],
          cursor,
        };
      }
      return { changed: [], tombstoned: [], cursor };
    },
    push: async () => {},
    subscribe: () => () => {},
    subscribePresence: () => () => {},
    onPresence: () => () => {},
    track: () => {},
    untrack: () => {},
    presenceState: () => ({}),
    presence: () => [],
    getCursor: () => cursor,
    setCursor: (_syncRule, nextCursor) => {
      cursor = nextCursor;
    },
    getScopeBuckets: () => ["owner-1"],
    getPullPageSize: () => undefined,
    getBucketTtlMs: () => undefined,
    setDeviceId: () => {},
    syncStatus: () => ({
      connectivity: "online",
      pendingMutations: 0,
      deadLettered: 0,
      lastPullCursor: cursor,
      lastPulledAt: new Date(),
    }),
    onSyncStatus: () => () => {},
    outbox: {
      list: async () => [],
      deadLetter: () => [],
    },
  };
}

function parseAddNote(input: unknown): { id: string; body: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { id?: unknown }).id === "string" &&
    typeof (input as { body?: unknown }).body === "string"
  ) {
    return input as { id: string; body: string };
  }
  throw new Error("invalid addNote input");
}

function parseRecordCredit(input: unknown): {
  clientId: string;
  customerId: string;
  amount: number;
  reason?: string;
  ref?: string;
  at?: string;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("invalid recordCredit input");
  }
  const value = input as {
    clientId?: unknown;
    customerId?: unknown;
    amount?: unknown;
    reason?: unknown;
    ref?: unknown;
    at?: unknown;
  };
  if (
    typeof value.clientId !== "string" ||
    typeof value.customerId !== "string" ||
    typeof value.amount !== "number"
  ) {
    throw new Error("invalid recordCredit input");
  }
  return {
    clientId: value.clientId,
    customerId: value.customerId,
    amount: value.amount,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.at === "string" ? { at: value.at } : {}),
  };
}

function resolvePersistenceAdapter(store: NizhalSQLitePersistence, collectionId = "notes") {
  return (
    store.persistence.resolvePersistenceForCollection?.({
      collectionId,
      mode: "sync-present",
    })?.adapter ?? store.persistence.adapter
  );
}

async function waitForAsyncPersist() {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function waitForPersistedRow(
  store: NizhalSQLitePersistence,
  key: string,
  collectionId = "notes",
) {
  const adapter = resolvePersistenceAdapter(store, collectionId);
  await waitFor(async () => {
    const rows = await adapter.scanRows(collectionId);
    return rows.some((row) => String(row.key) === key);
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
