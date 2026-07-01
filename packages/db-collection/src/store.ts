import { type Actor, type SyncRules, describeSyncedTables } from "@nizhal/kernel";
import { createCollection } from "@tanstack/db";
import type { OnlineDetector } from "@tanstack/offline-transactions";
import { Table, getTableName, is } from "drizzle-orm";
import type { NizhalClient } from "./client.js";
import { type NizhalCollection, nizhalCollectionOptions } from "./collection.js";
import { manualOnlineDetector } from "./manual-online-detector.js";
import { type NizhalMutatorsResult, createNizhalMutators } from "./mutators.js";
import type { NizhalSQLitePersistence } from "./persistence/migrate.js";
import type { NizhalMutatorDefinition } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: mutator arg types are per-definition; the map is heterogeneous.
type AnyMutators = Record<string, NizhalMutatorDefinition<any>>;

type SchemaRow<T> = T extends { $inferSelect: infer R } ? (R extends object ? R : never) : never;

/** The synced-table subset of a drizzle schema, each as a live collection keyed by its export name. */
export type NizhalStoreCollections<Schema> = {
  [K in keyof Schema as SchemaRow<Schema[K]> extends never ? never : K]: NizhalCollection<
    SchemaRow<Schema[K]>
  >;
};

export interface OpenNizhalStoreOptions<
  Schema extends Record<string, unknown>,
  M extends AnyMutators,
> {
  echo: NizhalClient;
  /** The drizzle schema module. Every table export it holds must be covered by a sync rule. */
  schema: Schema;
  syncRules: SyncRules;
  mutators: M;
  actor: Actor;
  /** Real SQLite persistence bundle (op-sqlite / wa-sqlite). Omit for an in-memory client. */
  persistence?: NizhalSQLitePersistence;
  /** Defaults to a manual detector; pass the platform detector (NetInfo / browser) for auto-flush. */
  onlineDetector?: OnlineDetector;
  clientID?: string;
}

export interface NizhalStore<Schema extends Record<string, unknown>, M extends AnyMutators> {
  collections: NizhalStoreCollections<Schema>;
  mutate: NizhalMutatorsResult<M>["mutate"];
  onlineDetector: OnlineDetector;
  dispose(): Promise<void>;
}

/**
 * Assemble a ready offline-first client store from the same three things the server is defined by —
 * the schema, the sync rules, and the mutators — so an app writes zero collection/outbox/executor
 * wiring. Derives one collection per synced table (rule + bucket column read from the sync rules),
 * preloads them, and wires the outbox / mutation-id / dead-letter stores + online detector.
 */
export async function openNizhalStore<
  Schema extends Record<string, unknown>,
  M extends AnyMutators,
>(opts: OpenNizhalStoreOptions<Schema, M>): Promise<NizhalStore<Schema, M>> {
  const synced = describeSyncedTables(opts.syncRules);
  const persistence = opts.persistence?.persistence;

  // One collection per synced table, keyed twice: by schema export name (the public `collections`
  // view the app reads) and by SQL table name (the key the mutator layer resolves tables by).
  const byExport: Record<string, NizhalCollection<object>> = {};
  const byTable: Record<string, NizhalCollection<object>> = {};
  for (const [exportKey, value] of Object.entries(opts.schema)) {
    if (!is(value, Table)) continue;
    const tableName = getTableName(value);
    const info = synced.get(tableName);
    if (!info) {
      throw new Error(
        `[@nizhal] openNizhalStore: table '${tableName}' is in the store schema but no sync rule covers it — remove it from the client schema or add it to a sync rule`,
      );
    }
    const bucketField = info.bucketColumns[0];
    const collection = createCollection(
      nizhalCollectionOptions<Record<string, unknown>>({
        name: tableName,
        syncRule: info.syncRule,
        echo: opts.echo,
        ...(bucketField ? { bucketField } : {}),
        persistence,
      }),
    ) as unknown as NizhalCollection<object>;
    byExport[exportKey] = collection;
    byTable[tableName] = collection;
  }

  await Promise.all(Object.values(byTable).map((collection) => collection.preload()));

  const onlineDetector = opts.onlineDetector ?? manualOnlineDetector();
  const mutators = createNizhalMutators({
    collections: byTable,
    echo: opts.echo,
    actor: opts.actor,
    mutators: opts.mutators,
    outboxStorage: opts.persistence?.outboxStorage,
    mutationIdStorage: opts.persistence?.metaStorage,
    deadLetterStorage: opts.persistence?.deadLetterStorage,
    clientID: opts.clientID ?? opts.persistence?.clientId,
    onlineDetector,
  });
  await mutators.executor.waitForInit();

  return {
    collections: byExport as unknown as NizhalStoreCollections<Schema>,
    mutate: mutators.mutate,
    onlineDetector,
    dispose: mutators.dispose,
  };
}
