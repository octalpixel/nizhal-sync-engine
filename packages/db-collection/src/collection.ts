import { localOnlyCollectionOptions } from "@tanstack/db";
import type { Collection, CollectionConfig, SyncConfig, SyncConfigRes } from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";
import type { NizhalClient } from "./client.js";
import { buildNizhalSyncConfig } from "./sync.js";
import type { NizhalMode } from "./types.js";

export interface NizhalCollectionOptions<Row extends object> {
  name: string;
  syncRule: string;
  echo: NizhalClient;
  getKey?: (row: Row) => string;
  bucketField?: keyof Row & string;
  /** Real SQLite persistence from {@link opSqlitePersistence} or {@link waSqlitePersistence}. */
  persistence?: PersistedCollectionPersistence;
  /** Per-collection client-store schema version forwarded to TanStack DB persistence. */
  schemaVersion?: number;
  /** Defaults to the client's mode, which defaults to `local-first`. */
  mode?: NizhalMode;
}

export function nizhalCollectionOptions<Row extends object>(
  opts: NizhalCollectionOptions<Row>,
): CollectionConfig<Row, string> {
  const getKey =
    opts.getKey ??
    ((row: Row) => {
      const id = (row as { id?: string | number }).id;
      if (id === undefined || id === null) {
        throw new Error(`[@nizhal/db-collection] row missing id for collection '${opts.name}'`);
      }
      return String(id);
    });

  const mode = opts.mode ?? opts.echo.getMode?.() ?? "local-first";
  opts.echo.registerCollection?.(opts.name, opts.syncRule, mode);
  const remoteSync = buildNizhalSyncConfig<Row>({
    syncRule: opts.syncRule,
    tableName: opts.name,
    echo: opts.echo,
    getKey,
    bucketField: opts.bucketField,
    mode,
  });

  const base = {
    id: opts.name,
    getKey,
    onInsert: async () => {},
    onUpdate: async () => {},
    onDelete: async () => {},
  };

  if (mode === "server-authoritative") {
    if (opts.echo.isRemoteSyncEnabled?.() === false) {
      throw new Error("[@nizhal/db-collection] server-authoritative mode requires a server");
    }
    const serverBase: CollectionConfig<Row, string> = {
      ...base,
      sync: remoteSync,
      startSync: false,
    };
    if (opts.persistence) {
      return persistedCollectionOptions<Row, string>({
        ...serverBase,
        persistence: opts.persistence,
        ...(opts.schemaVersion !== undefined ? { schemaVersion: opts.schemaVersion } : {}),
      });
    }
    return serverBase;
  }

  const localBase = opts.persistence
    ? persistedCollectionOptions<Row, string>({
        ...base,
        persistence: opts.persistence,
        ...(opts.schemaVersion !== undefined ? { schemaVersion: opts.schemaVersion } : {}),
      })
    : localOnlyCollectionOptions<Row, string>(base);

  if (opts.echo.isRemoteSyncEnabled?.() === false) {
    return { ...localBase, startSync: false } as CollectionConfig<Row, string>;
  }

  return {
    ...localBase,
    sync: composeLocalFirstSync(localBase.sync, remoteSync),
    startSync: false,
  } as CollectionConfig<Row, string>;
}

function composeLocalFirstSync<Row extends object>(
  localSync: SyncConfig<Row, string>,
  remoteSync: SyncConfig<Row, string>,
): SyncConfig<Row, string> {
  return {
    rowUpdateMode: "full",
    sync(params) {
      let closed = false;
      let remoteResult: SyncConfigRes | undefined;
      const startRemote = () => {
        if (closed || remoteResult) return;
        remoteResult = normalizeSyncResult(remoteSync.sync(params));
      };
      const localResult = normalizeSyncResult(
        localSync.sync({
          ...params,
          markReady: () => {
            startRemote();
          },
        }),
      );

      return {
        cleanup: () => {
          closed = true;
          remoteResult?.cleanup?.();
          localResult.cleanup?.();
        },
        loadSubset: localResult.loadSubset,
        unloadSubset: localResult.unloadSubset,
      };
    },
    getSyncMetadata: localSync.getSyncMetadata,
  };
}

function normalizeSyncResult(result: unknown): SyncConfigRes {
  if (typeof result === "function") return { cleanup: result as () => void };
  if (result && typeof result === "object") return result as SyncConfigRes;
  return {};
}

export type NizhalCollection<Row extends object> = Collection<Row, string>;
