import { type Cursor, INITIAL_CURSOR, type PullResult } from "@nizhal/kernel";
import type { Actor } from "@nizhal/kernel";
import { asc, eq, getTableColumns, getTableName, inArray } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { NizhalClient } from "../client.js";
import type { NizhalMutatorDefinition } from "../types.js";
import type { WriteGate } from "./atomic.js";
import { nizhalOutbox } from "./control-schema.js";
import type { NizhalMetaStore } from "./meta.js";
import { createDrizzleClientMutatorCtx } from "./mutator-tx.js";
import type { OutboxEnvelope } from "./push.js";
import type { AnyDrizzleSqliteDb, DerivedTableMap } from "./types.js";

// Pull-apply on the drizzle-native plane. Stronger than the legacy per-collection commit: ONE
// gated SQLite transaction applies every table's upserts + tombstones + bucket evictions, advances
// the cursor, AND replays the pending outbox on top (D6: direct-apply + replay-rebase — the
// authoritative state lands first, then deterministic mutator replay re-establishes optimistic
// writes; the UI never observes a frame where its pending write vanished). Invariant H2: the apply
// is upsert-only; the only destructive path is bucket eviction/tombstones the server ordered.

export interface PullLoopOptions {
  db: AnyDrizzleSqliteDb;
  gate: WriteGate;
  echo: NizhalClient;
  meta: NizhalMetaStore;
  tables: DerivedTableMap;
  mutators: Record<string, NizhalMutatorDefinition>;
  actor: Actor;
  /** table name → bucket column name (from describeSyncedTables), for removedBuckets eviction. */
  bucketColumns: Record<string, string | undefined>;
  syncRules: readonly string[];
  onTablesChanged(tables: ReadonlySet<string>): void;
}

export interface PullLoop {
  /** Coalesced pull for one rule (poke handler). Resolves when the triggered pull settles. */
  requestPull(syncRule: string): Promise<boolean>;
  /** First pull attempt for every rule has settled (local-first ready semantics). */
  ready(): Promise<void>;
  dispose(): void;
}

function pk(table: SQLiteTable): SQLiteColumn {
  const primaries = Object.values(getTableColumns(table) as Record<string, SQLiteColumn>).filter(
    (column) => column.primary,
  );
  const first = primaries[0];
  if (!first)
    throw new Error(`[@nizhal/db-collection] '${getTableName(table)}' has no primary key`);
  return first;
}

export function createPullLoop(opts: PullLoopOptions): PullLoop {
  let closed = false;
  const active = new Map<string, Promise<boolean>>();
  const pending = new Set<string>();

  async function applyResult(result: PullResult<Record<string, unknown>>): Promise<Set<string>> {
    const touched = new Set<string>();
    for (const batch of result.changed) {
      const table = opts.tables[batch.table];
      if (!table || batch.rows.length === 0) continue;
      touched.add(batch.table);
      const pkColumn = pk(table);
      const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
      for (const row of batch.rows) {
        // Server rows carry engine columns (_nizhal_row_version, …) the client schema doesn't —
        // keep only declared columns.
        const filtered: Record<string, unknown> = {};
        const set: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!columns[key]) continue;
          filtered[key] = value;
          if (columns[key] !== pkColumn) set[key] = value;
        }
        const insert = opts.db.insert(table).values(filtered);
        await (Object.keys(set).length > 0
          ? insert.onConflictDoUpdate({ target: pkColumn, set })
          : insert.onConflictDoNothing());
      }
    }

    const deletesByTable = new Map<string, string[]>();
    for (const tombstone of [...result.tombstoned, ...(result.removed ?? [])]) {
      const key = tombstone.key ?? tombstone.id;
      if (key === undefined) continue;
      const group = deletesByTable.get(tombstone.table) ?? [];
      group.push(String(key));
      deletesByTable.set(tombstone.table, group);
    }
    for (const [tableName, keys] of deletesByTable) {
      const table = opts.tables[tableName];
      if (!table) continue;
      touched.add(tableName);
      await opts.db.delete(table).where(inArray(pk(table), keys));
    }

    if (result.removedBuckets?.length) {
      for (const [tableName, table] of Object.entries(opts.tables)) {
        const bucketColumnName = opts.bucketColumns[tableName];
        if (!bucketColumnName) continue; // cannot attribute rows to the revoked bucket — never blind-purge
        const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
        const bucketColumn = Object.values(columns).find(
          (column) => column.name === bucketColumnName,
        );
        if (!bucketColumn) continue;
        touched.add(tableName);
        await opts.db.delete(table).where(inArray(bucketColumn, result.removedBuckets));
      }
    }
    return touched;
  }

  // D6 replay-rebase: after authoritative rows land, re-run every pending outbox mutation in
  // ordinal order. MutatorTx writes are upserts, so replay is idempotent under re-execution.
  async function replayOutbox(): Promise<void> {
    const rows = await opts.db.select().from(nizhalOutbox).orderBy(asc(nizhalOutbox.ordinal));
    for (const row of rows) {
      const envelope = row.envelope as OutboxEnvelope;
      const def = opts.mutators[envelope.name];
      if (!def) continue;
      const ctx = createDrizzleClientMutatorCtx(opts.db, opts.tables, opts.actor);
      await def.fn(ctx, envelope.args);
    }
  }

  async function runPull(syncRule: string): Promise<boolean> {
    if (closed) return false;
    try {
      const pageSize = opts.echo.getPullPageSize();
      let cursor: Cursor = (await opts.meta.getCursor(syncRule)) ?? opts.echo.getCursor(syncRule);
      let keepPaging = true;
      while (keepPaging && !closed) {
        const result = (await opts.echo.pull({
          cursor,
          syncRule,
          source: "sync",
          ...(pageSize !== undefined ? { limit: pageSize } : {}),
        })) as PullResult<Record<string, unknown>>;
        if (closed) return false;
        if (result.cursorReset) {
          cursor = INITIAL_CURSOR;
        }

        const touched = await opts.gate.run(opts.db, async () => {
          const changed = await applyResult(result);
          if (changed.size > 0) await replayOutbox();
          await opts.meta.setCursor(opts.db, syncRule, result.cursor);
          return changed;
        });
        opts.echo.setCursor(syncRule, result.cursor);
        if (touched.size > 0) opts.onTablesChanged(touched);

        cursor = result.cursor;
        if (!pageSize) break;
        const rowCount =
          result.changed.reduce((sum, batch) => sum + batch.rows.length, 0) +
          result.tombstoned.length +
          (result.removed?.length ?? 0);
        keepPaging = result.hasMore === true || rowCount >= pageSize;
      }
      return true;
    } catch (error) {
      opts.echo.reportError("pull", error);
      return false;
    }
  }

  function requestPull(syncRule: string): Promise<boolean> {
    const current = active.get(syncRule);
    if (current) {
      pending.add(syncRule);
      return current;
    }
    const pull = runPull(syncRule).finally(() => {
      active.delete(syncRule);
      if (!closed && pending.has(syncRule)) {
        pending.delete(syncRule);
        void requestPull(syncRule);
      }
    });
    active.set(syncRule, pull);
    return pull;
  }

  const initialPulls = Promise.allSettled(opts.syncRules.map((rule) => requestPull(rule)));

  return {
    requestPull,
    ready: async () => {
      await initialPulls;
    },
    dispose() {
      closed = true;
      pending.clear();
    },
  };
}
