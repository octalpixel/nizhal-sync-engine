// Core contracts for Nizhal. Implemented against by @nizhal/server and @nizhal/db-collection.
// See rfcs/RFC-001-nizhal.md §4 (interfaces) and §3 (REQs).

import type { SQL } from "drizzle-orm/sql";
import type { Table } from "drizzle-orm/table";

/** A zod-compatible / standard-schema-compatible validator. Codex may swap to @standard-schema/spec. */
export type Schema<T> = { parse: (input: unknown) => T };

/** Authenticated, un-spoofable principal resolved server-side from the session. */
export interface Actor {
  userId: string;
  ownerId: string;
  [key: string]: unknown;
}

export interface JobScheduler {
  enqueue(
    taskSlug: string,
    input: unknown,
    opts?: { maxAttempts?: number; delayMs?: number },
  ): void;
  scheduleAt(at: number, taskSlug: string, input: unknown): void;
}

type TableInsert<TTable extends Table> = TTable["$inferInsert"];
type TablePatch<TTable extends Table> = Partial<TTable["$inferInsert"]>;
export type MutatorPredicate<TTable extends Table> = SQL | ((table: TTable) => SQL);

export interface MutatorTx {
  insert<TTable extends Table>(
    table: TTable,
  ): {
    values(row: TableInsert<TTable>): Promise<unknown>;
  };
  update<TTable extends Table>(
    table: TTable,
  ): {
    set(patch: TablePatch<TTable>): {
      where(predicate: MutatorPredicate<TTable>): Promise<unknown>;
    };
  };
  delete<TTable extends Table>(
    table: TTable,
  ): {
    where(predicate: MutatorPredicate<TTable>): Promise<unknown>;
  };
}

/**
 * Context handed to a mutator. On the client `location:"client"` (optimistic);
 * on the server `location:"server"` (authoritative, inside one transaction).
 * `tx` is implemented by @nizhal/server and @nizhal/db-collection over the same Drizzle tables.
 */
export interface MutatorCtx {
  tx: MutatorTx;
  location: "client" | "server";
  actor: Actor;
  ownerId: string;
  userId: string;
  locationId?: string;
  now: () => number;
  newId: () => string;
  jobs: JobScheduler;
  /**
   * Server-authoritative, per-bucket monotonic assignment: the next `sequenceColumn` value for the
   * rows of `table` scoped to `scopeColumn = scopeValue`. Computed under a per-scope lock on the
   * server so two offline clients can never collide (e.g. two invoice #1s). On the client it returns
   * a provisional local guess that rebases to the authoritative value on the next pull — never
   * compute a server-meaningful sequence client-side and trust it.
   */
  nextInBucket?: (input: {
    table: string;
    sequenceColumn: string;
    scopeColumn: string;
    scopeValue: string | number;
  }) => Promise<number>;
}

export type MutatorFn<A> = (ctx: MutatorCtx, args: A) => Promise<unknown> | unknown;

export interface MutatorDef<A = unknown> {
  name: string;
  schema: Schema<A>;
  fn: MutatorFn<A>;
}

export type MutatorRegistry = Record<string, MutatorDef>;

// ── Sync rules (declarative, server-evaluated, no-leak-linted) ──────────────
/** A query expression. Codex wires this to the StorageAdapter's query builder (Drizzle by default). */
export interface BucketColumnRef<Key extends string = string> {
  readonly kind: "bucket-column";
  readonly key: Key;
}

export interface QueryPredicate<BucketKey extends string = string> {
  readonly column: string;
  readonly operator: "=";
  readonly bucket: BucketColumnRef<BucketKey>;
}

export interface Query<BucketKey extends string = string> {
  readonly kind: "nizhal-query";
  readonly table: string;
  readonly predicates: readonly QueryPredicate<BucketKey>[];
  readonly raw?: string;
  readonly related?: readonly Query<BucketKey>[];
}

export interface MembershipQuery<Columns extends Record<string, string> = Record<string, string>> {
  readonly kind: "echo-membership";
  readonly table: string;
  readonly where: Readonly<Record<string, unknown>>;
  readonly bucketColumns: Columns;
}

export type ParameterQuery = Query | MembershipQuery;

export interface SyncRuleDef<Bucket = Record<string, unknown>> {
  /** Returns the set of bucket parameter rows this actor may see. */
  parameters: (ctx: Actor) => ParameterQuery;
  /** For each bucket instance, the rows that belong in it. */
  data: (bucket: Bucket) => readonly Query[];
  readonly bucketColumns?: readonly string[];
}

export type SyncRules = Record<string, SyncRuleDef>;

// ── Sync wire types ────────────────────────────────────────────────────────
export type Cursor = string;
export const INITIAL_CURSOR: Cursor = "";
export type BucketKey = string;

export type ChangeMessage<T = unknown> =
  | { type: "insert" | "update"; value: T }
  | { type: "delete"; key: string };

export interface PullResult<T = unknown> {
  changed: { table: string; rows: T[] }[];
  tombstoned: { table: string; id: string; key?: string }[];
  /** Rows that left the client's bucket scope but still exist elsewhere. */
  removed?: { table: string; id: string; key?: string }[];
  /** Buckets the client must purge locally (access-revocation eviction, REQ-14). */
  removedBuckets?: BucketKey[];
  cursor: Cursor;
  /** True when the server clamped an invalid/future cursor to 0 (full re-bootstrap). */
  cursorReset?: boolean;
  /** True when a page limit truncated the result and another pull is needed. */
  hasMore?: boolean;
  /** Server-authoritative mutation sequence for the requesting client. */
  lastMutationId?: number;
}

export interface Mutation {
  name: string;
  args: unknown;
  clientMutationId: string;
  clientID?: string;
  mutationID?: number;
  hlc?: string;
  dependsOn?: string;
}

export type MergeMode = "lww" | "field" | "crdt";
export type MergePolicy = MergeMode | Record<string, MergeMode>;

// ── Contract artifact (GET /nizhal/contract; consumed by `nizhal gen`) ──────────
export interface NizhalContract {
  openapi: string;
  info: { title: string; version: string };
  components: { schemas: Record<string, unknown> };
  "x-echo": {
    collections: string[];
    merge: Record<string, MergePolicy>;
    mutators: Record<string, { input: unknown }>;
    syncRules: string[];
  };
}
