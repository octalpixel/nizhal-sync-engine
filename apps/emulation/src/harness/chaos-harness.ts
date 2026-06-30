import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { NizhalClient, NizhalMutatorsResult } from "@nizhal/db-collection";
import {
  createNizhalClient,
  createNizhalMutators,
  waSqlitePersistence,
} from "@nizhal/db-collection";
import type { ContractSchemaSource, MutatorRegistry, SyncRules } from "@nizhal/kernel";
import type { JobRegistryInput, NizhalAuth } from "@nizhal/server";
import { createNizhalServer } from "@nizhal/server";
import type { RealtimeAdapter, StorageAdapter } from "@nizhal/server/adapters";
import { postgresStorage } from "@nizhal/server/adapters";
import type { OfflineExecutor } from "@tanstack/offline-transactions";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ReconnectableRealtime } from "./reconnectable-realtime.js";
import { reconnectableRealtime } from "./reconnectable-realtime.js";
import { type WaSqliteEnv, createWaSqliteEnv, destroyWaSqliteEnv } from "./wa-sqlite-env.js";

export interface ChaosDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface ChaosClientHandle {
  id: string;
  echo: NizhalClient;
  executor: OfflineExecutor;
  deadLetter: NizhalMutatorsResult<MutatorRegistry>["deadLetter"];
  mutate: NizhalMutatorsResult<MutatorRegistry>["mutate"];
  collections: Record<string, { toArray: readonly object[]; preload(): Promise<void> }>;
  getPendingCount(): number;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
  cleanup: () => Promise<void>;
  skewMs: number;
}

export interface ChaosHarnessOptions {
  schema: Record<string, ContractSchemaSource>;
  syncRules: SyncRules;
  mutatorsFactory: (poisoned: Set<string>) => MutatorRegistry;
  ddl: string;
  auth: NizhalAuth;
  seedSql?: string;
  jobs?: JobRegistryInput;
  bucketKey: string;
}

export interface ChaosHarness {
  baseUrl: string;
  db: ChaosDb;
  realtime: ReconnectableRealtime;
  clients: Map<string, ChaosClientHandle>;
  poisoned: Set<string>;
  partition(clientId: string): void;
  heal(clientId: string): void;
  restartServer(): Promise<void>;
  raceConcurrent(fns: Array<() => void | Promise<void>>): Promise<void>;
  poison(name: string): void;
  unpoison(name: string): void;
  skewClock(clientId: string, ms: number): void;
  revoke(userId: string, bucket: string): Promise<void>;
  converge(timeoutMs?: number): Promise<void>;
  assertInvariants(check: InvariantCheck): Promise<void>;
  createClient(input: CreateChaosClientInput): Promise<ChaosClientHandle>;
  close(): Promise<void>;
}

export interface CreateChaosClientInput {
  id: string;
  userId: string;
  ownerId: string;
  bucket: string;
  actorExtras?: Record<string, unknown>;
  authHeaders?: Record<string, string>;
  authRefresh?: () => Promise<Record<string, string>>;
  buildCollections: (input: {
    echo: NizhalClient;
    persistence?: Awaited<ReturnType<typeof waSqlitePersistence>>["persistence"];
  }) => Record<string, unknown>;
  mutators: MutatorRegistry;
  persist?: boolean;
  hlcSkewMs?: number;
  pullIntervalMs?: number;
}

export interface InvariantCheck {
  tables: string[];
  bucket: string;
  fold?: (rows: Record<string, readonly object[]>) => void;
}

interface ServerBundle {
  close: () => void;
  baseUrl: string;
}

export async function createChaosHarness(opts: ChaosHarnessOptions): Promise<ChaosHarness> {
  const neonUrl = process.env.NEON_URL;
  const db = neonUrl ? await createPostgresDb(neonUrl, opts.ddl) : await createPgliteDb(opts.ddl);
  const storage = postgresStorage({
    connectionString: neonUrl ?? "postgres://unused",
    client: neonUrl ? (db as { raw: postgres.Sql }).raw : (db as { raw: PGlite }).raw,
  });
  await storage.provision({ schema: opts.schema, syncRules: opts.syncRules });
  if (opts.seedSql) await db.exec(opts.seedSql);

  const realtime = reconnectableRealtime();
  const poisoned = new Set<string>();
  const clients = new Map<string, ChaosClientHandle>();
  const partitioned = new Map<string, boolean>();
  const clockSkew = new Map<string, number>();
  let waEnv: WaSqliteEnv | null = null;
  let serverBundle = await startServer({
    db: neonUrl ?? "postgres://unused",
    schema: opts.schema,
    syncRules: opts.syncRules,
    mutators: opts.mutatorsFactory(poisoned),
    auth: opts.auth,
    storage,
    realtime,
    jobs: opts.jobs,
  });
  const serverRef = { url: serverBundle.baseUrl };

  async function close(): Promise<void> {
    for (const client of clients.values()) await client.cleanup();
    clients.clear();
    serverBundle.close();
    await db.close();
    if (waEnv) await destroyWaSqliteEnv(waEnv);
  }

  async function createClient(input: CreateChaosClientInput): Promise<ChaosClientHandle> {
    if (!waEnv && input.persist) {
      waEnv = await createWaSqliteEnv();
    }

    const partitionedFlag = { value: false };
    partitioned.set(input.id, false);

    const echo = createNizhalClient({
      server: serverRef.url,
      getServer: () => serverRef.url,
      auth: input.authHeaders
        ? { headers: input.authHeaders, refresh: input.authRefresh }
        : undefined,
      reconnect: { jitterMs: false },
      ...(input.pullIntervalMs !== undefined ? { pull: { intervalMs: input.pullIntervalMs } } : {}),
      subscribeSource: {
        subscribe: (buckets, onMessage, onReconnect) =>
          realtime.subscribe(buckets, {
            send: onMessage,
            ...(onReconnect ? { onReconnect } : {}),
          }),
      },
      bucketsForSyncRule: () => [input.bucket],
    });

    const basePull = echo.pull.bind(echo);
    const basePush = echo.push.bind(echo);
    echo.pull = async (pullInput) => {
      if (partitionedFlag.value) {
        throw new Error(`partitioned: ${input.id} pull blocked`);
      }
      return basePull(pullInput);
    };
    echo.push = async (mutation) => {
      if (partitionedFlag.value) {
        throw new Error(`partitioned: ${input.id} push blocked`);
      }
      return basePush(mutation);
    };

    let persistence: Awaited<ReturnType<typeof waSqlitePersistence>> | undefined;
    let sqliteDb: { close(): Promise<void> } | undefined;
    if (input.persist && waEnv) {
      sqliteDb = await waEnv.openDatabase(`${input.id}.db`);
      persistence = await waSqlitePersistence({ database: sqliteDb as never });
    }

    const persistenceStore = persistence;

    const collections = input.buildCollections({
      echo,
      persistence: persistence?.persistence,
    });

    const {
      mutate,
      executor,
      deadLetter,
      dispose,
      getPendingCount,
      waitForIdle: waitForMutatorsIdle,
    } = createNizhalMutators({
      collections: collections as never,
      echo,
      actor: {
        userId: input.userId,
        ownerId: input.ownerId,
        ...input.actorExtras,
      },
      mutators: input.mutators,
      outboxStorage: persistence?.outboxStorage,
      mutationIdStorage: persistence?.metaStorage,
      deadLetterStorage: persistence?.deadLetterStorage,
      clientID: persistence?.clientId,
      hlcOptions:
        (input.hlcSkewMs ?? clockSkew.get(input.id) ?? 0)
          ? { now: () => Date.now() + (input.hlcSkewMs ?? clockSkew.get(input.id) ?? 0) }
          : undefined,
    });

    const skewMs = input.hlcSkewMs ?? clockSkew.get(input.id) ?? 0;

    const collectionHandles = Object.fromEntries(
      Object.entries(collections).map(([name, collection]) => [
        name,
        collection as { toArray: readonly object[]; preload(): Promise<void> },
      ]),
    );

    const handle: ChaosClientHandle = {
      id: input.id,
      echo,
      executor,
      deadLetter,
      mutate,
      collections: collectionHandles,
      getPendingCount,
      waitForIdle: waitForMutatorsIdle,
      dispose,
      skewMs,
      cleanup: async () => {
        executor.dispose();
        for (const collection of Object.values(collections)) {
          const maybe = collection as { cleanup?: () => Promise<void> };
          await maybe.cleanup?.();
        }
        await dispose();
        await persistenceStore?.dispose();
        await sqliteDb?.close();
      },
    };

    partitioned.set(input.id, false);
    Object.defineProperty(partitionedFlag, "value", {
      get() {
        return partitioned.get(input.id) === true;
      },
      set(v: boolean) {
        partitioned.set(input.id, v);
      },
    });

    clients.set(input.id, handle);
    return handle;
  }

  return {
    get baseUrl() {
      return serverBundle.baseUrl;
    },
    db,
    realtime,
    clients,
    poisoned,
    partition(clientId) {
      partitioned.set(clientId, true);
    },
    heal(clientId) {
      partitioned.set(clientId, false);
      realtime.reconnect();
    },
    async restartServer() {
      serverBundle.close();
      serverBundle = await startServer({
        db: neonUrl ?? "postgres://unused",
        schema: opts.schema,
        syncRules: opts.syncRules,
        mutators: opts.mutatorsFactory(poisoned),
        auth: opts.auth,
        storage,
        realtime,
        jobs: opts.jobs,
      });
      serverRef.url = serverBundle.baseUrl;
    },
    async raceConcurrent(fns) {
      await Promise.all(fns.map((fn) => Promise.resolve().then(fn)));
    },
    poison(name) {
      poisoned.add(name);
    },
    unpoison(name) {
      poisoned.delete(name);
    },
    skewClock(clientId, ms) {
      clockSkew.set(clientId, ms);
      const client = clients.get(clientId);
      if (client) client.skewMs = ms;
    },
    async revoke(userId, bucket) {
      await db.exec(
        `delete from shop_members where user_id = '${userId}' and shop_id = '${bucket}'`,
      );
    },
    async converge(timeoutMs = 30_000) {
      realtime.reconnect();
      for (const id of clients.keys()) partitioned.set(id, false);
      for (const client of clients.values()) {
        await Promise.all(Object.values(client.collections).map((c) => c.preload()));
        await client.executor.waitForInit();
      }
      const bucket = opts.bucketKey;
      realtime.publish(bucket);
      await waitFor(async () => {
        for (const client of clients.values()) {
          if (client.getPendingCount() > 0) return false;
        }
        return true;
      }, timeoutMs);
      await Promise.all([...clients.values()].map((client) => client.waitForIdle()));
      realtime.publish(bucket);
      await sleep(200);
    },
    async assertInvariants(check) {
      const serverRows = await readServerTables(db, check.tables, check.bucket);
      for (const client of clients.values()) {
        if (partitioned.get(client.id)) continue;
        for (const table of check.tables) {
          const server = normalizeRows(serverRows[table] ?? []);
          await waitFor(() => {
            const currentClientRows = normalizeRows(
              (client.collections[table]?.toArray ?? []) as Record<string, unknown>[],
            );
            try {
              assertSameRows(client.id, table, currentClientRows, server);
              return true;
            } catch {
              return false;
            }
          });
          assertSameRows(
            client.id,
            table,
            normalizeRows((client.collections[table]?.toArray ?? []) as Record<string, unknown>[]),
            server,
          );
        }
      }
      if (check.fold) {
        const perClient: Record<string, readonly object[]> = {};
        for (const [table, rows] of Object.entries(serverRows)) {
          perClient[table] = rows as readonly object[];
        }
        check.fold(perClient);
      }
    },
    createClient,
    close,
  };
}

async function createPgliteDb(ddl: string): Promise<ChaosDb & { raw: PGlite }> {
  const raw = new PGlite();
  await raw.exec(ddl);
  return {
    raw,
    async query(sql, params = []) {
      return raw.query(sql, params);
    },
    async exec(sql) {
      await raw.exec(sql);
    },
    async close() {
      await raw.close();
    },
  };
}

async function createPostgresDb(
  url: string,
  ddl: string,
): Promise<ChaosDb & { raw: postgres.Sql }> {
  const raw = postgres(url);
  const db = drizzlePostgres(raw);
  await db.execute(sql.raw("drop schema if exists public cascade; create schema public;"));
  await db.execute(sql.raw(ddl));
  return {
    raw,
    async query<T = Record<string, unknown>>(queryText: string, params: unknown[] = []) {
      const result = await db.execute(bindPostgresParams(queryText, params));
      const rows = rowsFromExecute(result);
      return { rows: rows as unknown as T[] };
    },
    async exec(queryText) {
      await db.execute(sql.raw(queryText));
    },
    async close() {
      await raw.end();
    },
  };
}

function bindPostgresParams(queryText: string, params: unknown[]): SQL {
  const chunks: SQL[] = [];
  let lastIndex = 0;
  const pattern = /\$(\d+)/g;
  for (const match of queryText.matchAll(pattern)) {
    if (match.index > lastIndex) {
      chunks.push(sql.raw(queryText.slice(lastIndex, match.index)));
    }
    const paramIndex = Number(match[1]) - 1;
    chunks.push(sql`${params[paramIndex]}`);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < queryText.length) {
    chunks.push(sql.raw(queryText.slice(lastIndex)));
  }
  if (chunks.length === 0) return sql.raw(queryText);
  if (chunks.length === 1) return chunks[0] as SQL;
  return sql.join(chunks, sql.raw(""));
}

function rowsFromExecute(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

async function startServer(input: {
  db: string;
  schema: Record<string, ContractSchemaSource>;
  syncRules: SyncRules;
  mutators: MutatorRegistry;
  auth: NizhalAuth;
  storage: StorageAdapter;
  realtime: RealtimeAdapter;
  jobs?: JobRegistryInput;
}): Promise<ServerBundle> {
  const server = createNizhalServer({
    db: input.db,
    schema: input.schema,
    mutators: input.mutators,
    syncRules: input.syncRules,
    auth: input.auth,
    storage: input.storage,
    realtime: input.realtime,
    jobs: input.jobs,
    limits: { rateLimit: false },
  });
  return serveFetch(server.app.fetch.bind(server.app) as typeof fetch);
}

function serveFetch(fetchFn: typeof fetch): Promise<ServerBundle> {
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = `http://${host}${req.url ?? "/"}`;
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const init: RequestInit = { method, headers: req.headers as HeadersInit };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fetchFn(new Request(url, init))
        .then(async (response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((error: Error) => {
          res.statusCode = 500;
          res.end(error.message);
        });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

async function readServerTables(
  db: ChaosDb,
  tables: string[],
  bucket: string,
): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    const bucketColumn =
      table === "assets" || table.startsWith("stock_") ? "location_id" : "shop_id";
    const result = await db.query(`select * from ${table} where ${bucketColumn} = $1 order by id`, [
      bucket,
    ]);
    out[table] = result.rows;
  }
  return out;
}

const IGNORED_COMPARE_FIELDS = new Set([
  "updated_at",
  "created_at",
  "at",
  "flagged_at",
  "scheduled_at",
  "sent_at",
  "_meta",
  "_nizhal_row_version",
]);

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows
    .map((row) => {
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (key.startsWith("$")) continue;
        if (IGNORED_COMPARE_FIELDS.has(key)) continue;
        copy[key] = value;
      }
      return copy;
    })
    .sort((a, b) => String(a.id ?? a.client_id).localeCompare(String(b.id ?? b.client_id)));
}

function assertSameRows(
  clientId: string,
  table: string,
  clientRows: Record<string, unknown>[],
  serverRows: Record<string, unknown>[],
) {
  if (clientRows.length !== serverRows.length) {
    throw new Error(
      `INV-1 convergence failed for ${clientId}/${table}: client=${clientRows.length} server=${serverRows.length}`,
    );
  }
  for (let i = 0; i < clientRows.length; i += 1) {
    const left = JSON.stringify(clientRows[i]);
    const right = JSON.stringify(serverRows[i]);
    if (left !== right) {
      throw new Error(
        `INV-1 convergence failed for ${clientId}/${table} row ${i}: ${left} !== ${right}`,
      );
    }
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
