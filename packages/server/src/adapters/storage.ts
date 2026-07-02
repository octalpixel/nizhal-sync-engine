import {
  type Actor,
  type BucketKey,
  type ContractSchemaSource,
  type Cursor,
  INITIAL_CURSOR,
  type MembershipQuery,
  type MutatorPredicate,
  type MutatorTx,
  type ParameterQuery,
  type PullResult,
  type Query,
  type SyncRules,
  collectSyncRuleTables,
  flattenDataQueries,
  isNizhalTable,
  schemaMergeMode,
  schemaTableName,
  tableName,
} from "@nizhal/kernel";
import type { MergeMode } from "@nizhal/kernel";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Table } from "drizzle-orm/table";
import { getTableName } from "drizzle-orm/table";
import postgres from "postgres";
import {
  type DrizzleClient,
  type NizhalDb,
  type PgliteClient,
  type PostgresClient,
  type StorageTx,
  createStorageTx,
  executeRows,
  toNizhalDb,
  whereToPredicate,
} from "../drizzle-db.js";
import {
  nizhalAuditLog,
  nizhalClientBuckets,
  nizhalClients,
  nizhalMutations,
  nizhalTombstones,
} from "../engine-tables.js";

export type { StorageTx } from "../drizzle-db.js";

export interface AuditEntry {
  rowVersion: string;
  clientMutationId: string;
  mutationName: string;
  args: unknown;
  actor: Record<string, unknown>;
  clientId: string | null;
  mutationId: number | null;
  hlc: string | null;
  affectedBuckets: string[];
  createdAt: string;
}

export interface AuditQuery {
  buckets?: string[];
  actor?: Record<string, unknown>;
  sinceVersion?: string;
  untilVersion?: string;
  limit?: number;
}

export type PendingAuditEntry = Omit<AuditEntry, "rowVersion" | "createdAt">;

/** The DB-decoupling seam. Default impl = postgresStorage; alternates (d1/sqlite/mysql) are adapters. RFC §4.6. */
export interface StorageAdapter {
  /** Scoped cursor pull over the storage-issued total-order cursor. */
  getChanges(input: {
    actor: Actor;
    syncRules: SyncRules;
    cursor: Cursor;
    deviceId?: string;
    limit?: number;
  }): Promise<PullResult>;
  getActorBuckets?(input: {
    actor: Actor;
    syncRules: SyncRules;
    tx?: StorageTx;
  }): Promise<BucketKey[]>;
  /** Run a mutator's writes atomically (one business op = one transaction). */
  transaction<T>(fn: (tx: StorageTx) => Promise<T>): Promise<T>;
  authorizeMutatorTx(input: {
    tx: StorageTx;
    mutatorTx: MutatorTx;
    actor: Actor;
    syncRules: SyncRules;
  }): Promise<MutatorTx>;
  claimMutation(tx: StorageTx, clientMutationId: string): Promise<boolean>;
  checkMutationSequence?(
    tx: StorageTx,
    input: { clientID: string; mutationID: number },
  ): Promise<"apply" | "alreadyApplied" | "outOfOrder">;
  readLastMutationId(clientID: string, tx?: StorageTx): Promise<number>;
  isApplied(clientMutationId: string, tx?: StorageTx): Promise<boolean>;
  appliedMutationError?(clientMutationId: string, tx?: StorageTx): Promise<string | null>;
  recordApplied(
    clientMutationId: string,
    map?: { clientId?: string; serverId?: string; error?: string },
    tx?: StorageTx,
  ): Promise<void>;
  appendAudit?(tx: StorageTx, entry: PendingAuditEntry): Promise<void>;
  getAuditLog?(query: AuditQuery): Promise<AuditEntry[]>;
  /** Emit columns/triggers/indexes from schema + syncRules (used by `nizhal migrate`). */
  provision(input: {
    schema: Record<string, ContractSchemaSource>;
    syncRules: SyncRules;
    audit?: boolean;
  }): Promise<void>;
  /** Drop every engine artifact and reprovision fresh at the current version (clean-slate upgrade). */
  reset?(input: {
    schema: Record<string, ContractSchemaSource>;
    syncRules: SyncRules;
    audit?: boolean;
  }): Promise<void>;
  getClient?(): PostgresClient | PgliteClient | DrizzleClient;
  /** Read an engine-meta value (`_nizhal_meta`); null if absent. Used by `nizhal migrate` (T16). */
  readEngineMeta?(key: string): Promise<string | null>;
  /** Upsert an engine-meta value (`_nizhal_meta`). Requires the engine to be provisioned. */
  writeEngineMeta?(key: string, value: string): Promise<void>;
}

export interface ProvisionPlan {
  statements: string[];
}

export interface SyncedTablePlan {
  table: string;
  bucketColumns: string[];
  merge: MergeMode;
}

export interface PostgresStorageOptions {
  connectionString: string;
  client?: PostgresClient | PgliteClient | DrizzleClient;
}

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 1_000;

function parseAuditVersion(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid audit row version '${value}'`);
  }
  return BigInt(value);
}

function normalizeAuditLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUDIT_LIMIT;
  if (!Number.isInteger(value) || value < 1)
    throw new Error("Audit limit must be a positive integer");
  return Math.min(value, MAX_AUDIT_LIMIT);
}

function asAuditActor(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Stored audit actor is not a JSON object");
  return value;
}

function asAuditBuckets(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((bucket) => typeof bucket === "string")) {
    throw new Error("Stored audit buckets are not a string array");
  }
  return value;
}

/** DEFAULT storage: any Postgres, no logical replication. (C6 provision, C7 getChanges, C8 transaction/idempotency) */
export function postgresStorage(opts: PostgresStorageOptions): StorageAdapter {
  const rawClient = opts.client ?? postgres(opts.connectionString);
  const normalized = toNizhalDb(rawClient);
  const db = normalized.db;
  return {
    async getChanges(input) {
      return getPostgresChanges(db, input);
    },
    async getActorBuckets(input) {
      const bucketRows = await resolveActorBucketRows(
        input.tx?.db ?? db,
        input.actor,
        input.syncRules,
      );
      return Array.from(collectBucketKeys(bucketRows));
    },
    async transaction(fn) {
      return db.transaction(async (tx) => fn(createStorageTx(tx)));
    },
    async authorizeMutatorTx(input) {
      const bucketRows = await resolveActorBucketRows(
        input.tx.db,
        input.actor,
        input.syncRules,
        true,
      );
      return createAuthorizedMutatorTx(input.mutatorTx, input.tx.db, bucketRows);
    },
    async claimMutation(tx, clientMutationId) {
      const rows = await tx.db
        .insert(nizhalMutations)
        .values({ clientMutationId })
        .onConflictDoNothing()
        .returning();
      return rows.length === 1;
    },
    async readLastMutationId(clientID, tx) {
      const rows = await (tx?.db ?? db)
        .select({ lastMutationId: nizhalClients.lastMutationId })
        .from(nizhalClients)
        .where(eq(nizhalClients.clientId, clientID))
        .limit(1);
      return Number(rows[0]?.lastMutationId ?? 0);
    },
    async isApplied(clientMutationId, tx) {
      const rows = await (tx?.db ?? db)
        .select({ clientMutationId: nizhalMutations.clientMutationId })
        .from(nizhalMutations)
        .where(eq(nizhalMutations.clientMutationId, clientMutationId))
        .limit(1);
      return rows.length === 1;
    },
    async appliedMutationError(clientMutationId, tx) {
      const target = tx?.db ?? db;
      const rows = await target
        .select({ error: nizhalMutations.error })
        .from(nizhalMutations)
        .where(eq(nizhalMutations.clientMutationId, clientMutationId))
        .limit(1);
      return rows[0]?.error ?? null;
    },
    async checkMutationSequence(tx, input) {
      await tx.db
        .insert(nizhalClients)
        .values({ clientId: input.clientID, lastMutationId: 0 })
        .onConflictDoNothing();
      const rows = await executeRows<{ last_mutation_id: number }>(
        tx.db,
        sql`select last_mutation_id from _nizhal_clients where client_id = ${input.clientID} for update`,
      );
      const lastMutationId = Number(rows[0]?.last_mutation_id ?? 0);
      if (input.mutationID <= lastMutationId) return "alreadyApplied";
      if (input.mutationID > lastMutationId + 1) return "outOfOrder";
      await tx.db
        .update(nizhalClients)
        .set({ lastMutationId: input.mutationID })
        .where(eq(nizhalClients.clientId, input.clientID));
      return "apply";
    },
    async recordApplied(clientMutationId, map, tx) {
      const target = tx?.db ?? db;
      await target
        .insert(nizhalMutations)
        .values({
          clientMutationId,
          clientId: map?.clientId ?? null,
          serverId: map?.serverId ?? null,
          error: map?.error ?? null,
        })
        .onConflictDoUpdate({
          target: nizhalMutations.clientMutationId,
          set: {
            clientId: map?.clientId ?? null,
            serverId: map?.serverId ?? null,
            error: map?.error ?? null,
            appliedAt: sql`now()`,
          },
        });
    },
    async appendAudit(tx, entry) {
      await tx.db.insert(nizhalAuditLog).values({
        clientMutationId: entry.clientMutationId,
        mutationName: entry.mutationName,
        args: entry.args,
        actor: entry.actor,
        clientId: entry.clientId,
        mutationId: entry.mutationId,
        hlc: entry.hlc,
        affectedBuckets: entry.affectedBuckets,
      });
    },
    async getAuditLog(query) {
      const predicates = [];
      if (query.sinceVersion !== undefined) {
        predicates.push(
          sql`${nizhalAuditLog.rowVersion} > ${parseAuditVersion(query.sinceVersion)}`,
        );
      }
      if (query.untilVersion !== undefined) {
        predicates.push(
          sql`${nizhalAuditLog.rowVersion} <= ${parseAuditVersion(query.untilVersion)}`,
        );
      }
      if (query.actor !== undefined) {
        predicates.push(sql`${nizhalAuditLog.actor} @> ${JSON.stringify(query.actor)}::jsonb`);
      }
      if (query.buckets !== undefined && query.buckets.length > 0) {
        predicates.push(
          sql`${nizhalAuditLog.affectedBuckets} ?| array[${sql.join(
            query.buckets.map((bucket) => sql`${bucket}`),
            sql`, `,
          )}]`,
        );
      }
      const rows = await db
        .select()
        .from(nizhalAuditLog)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(asc(nizhalAuditLog.rowVersion))
        .limit(normalizeAuditLimit(query.limit));
      return rows.map((row) => ({
        rowVersion: row.rowVersion.toString(),
        clientMutationId: row.clientMutationId,
        mutationName: row.mutationName,
        args: row.args,
        actor: asAuditActor(row.actor),
        clientId: row.clientId,
        mutationId: row.mutationId,
        hlc: row.hlc,
        affectedBuckets: asAuditBuckets(row.affectedBuckets),
        createdAt: row.createdAt.toISOString(),
      }));
    },
    async provision(input) {
      await provisionToCurrent(db, input);
    },
    async reset(input) {
      for (const statement of buildResetStatements(input)) await db.execute(sql.raw(statement));
      await provisionToCurrent(db, input);
    },
    getClient() {
      return rawClient;
    },
    async readEngineMeta(key) {
      try {
        const rows = await executeRows<{ value: string }>(
          db,
          sql`select value from _nizhal_meta where key = ${key}`,
        );
        return rows[0]?.value ?? null;
      } catch {
        return null; // _nizhal_meta not provisioned yet — no snapshot to compare against
      }
    },
    async writeEngineMeta(key, value) {
      await db.execute(
        sql`insert into _nizhal_meta (key, value) values (${key}, ${value})
            on conflict (key) do update set value = excluded.value, updated_at = now()`,
      );
    },
  };
}

export class WriteAuthorizationError extends Error {
  constructor(
    readonly table: string,
    readonly operation: "insert" | "update" | "delete",
  ) {
    super(`actor is not authorized to ${operation} rows in '${table}'`);
    this.name = "WriteAuthorizationError";
  }
}

function createAuthorizedMutatorTx(
  mutatorTx: MutatorTx,
  db: NizhalDb,
  bucketRows: Map<string, { rule: SyncRules[string]; rows: Record<string, unknown>[] }>,
): MutatorTx {
  const scopes = collectWriteScopes(bucketRows);

  return {
    insert(table) {
      return {
        async values(row) {
          const rows = await mutatorTx.insert(table).values(row);
          assertAuthorizedResult(table, rows, "insert", scopes);
          return rows;
        },
      };
    },
    update(table, where) {
      return {
        async set(patch) {
          const predicate = whereToPredicate(table, where);
          const before = await selectRowsForWrite(db, table, predicate);
          assertAuthorizedRows(table, before, "update", scopes);
          const rows = await mutatorTx.update(table, where).set(patch);
          assertAuthorizedResult(table, rows, "update", scopes);
          return rows;
        },
      };
    },
    async delete(table, where) {
      const predicate = whereToPredicate(table, where);
      const before = await selectRowsForWrite(db, table, predicate);
      assertAuthorizedRows(table, before, "delete", scopes);
      const rows = await mutatorTx.delete(table, where);
      assertAuthorizedResult(table, rows, "delete", scopes);
      return rows;
    },
  };
}

interface WriteScope {
  predicates: Query["predicates"];
  bucketRows: readonly Record<string, unknown>[];
}

function collectWriteScopes(
  bucketRows: Map<string, { rule: SyncRules[string]; rows: Record<string, unknown>[] }>,
): Map<string, WriteScope[]> {
  const scopes = new Map<string, WriteScope[]>();
  for (const { rule, rows } of bucketRows.values()) {
    for (const query of flattenDataQueries(rule.data(bucketProxy(rule.bucketColumns ?? [])))) {
      const tableScopes = scopes.get(query.table) ?? [];
      tableScopes.push({ predicates: query.predicates, bucketRows: rows });
      scopes.set(query.table, tableScopes);
    }
  }
  return scopes;
}

async function selectRowsForWrite<TTable extends Table>(
  db: NizhalDb,
  table: TTable,
  predicate: MutatorPredicate<TTable>,
): Promise<Record<string, unknown>[]> {
  const where = typeof predicate === "function" ? predicate(table) : predicate;
  return executeRows<Record<string, unknown>>(
    db,
    sql`select * from ${sql.identifier(getTableName(table))} where ${where} for update`,
  );
}

function assertAuthorizedRows<TTable extends Table>(
  table: TTable,
  rows: readonly unknown[],
  operation: WriteAuthorizationError["operation"],
  scopes: Map<string, WriteScope[]>,
): void {
  const tableName = getTableName(table);
  const tableScopes = scopes.get(tableName) ?? [];
  for (const value of rows) {
    if (!isRecord(value) || !tableScopes.some((scope) => rowMatchesScope(value, scope))) {
      throw new WriteAuthorizationError(tableName, operation);
    }
  }
}

function assertAuthorizedResult<TTable extends Table>(
  table: TTable,
  result: unknown,
  operation: WriteAuthorizationError["operation"],
  scopes: Map<string, WriteScope[]>,
): void {
  if (!Array.isArray(result)) {
    throw new WriteAuthorizationError(getTableName(table), operation);
  }
  assertAuthorizedRows(table, result, operation, scopes);
}

function rowMatchesScope(row: Record<string, unknown>, scope: WriteScope): boolean {
  return scope.bucketRows.some((bucketRow) =>
    scope.predicates.every((predicate) => {
      const rowValue = row[predicate.column];
      const bucketValue = bucketRow[predicate.bucket.key];
      return (
        rowValue !== undefined &&
        rowValue !== null &&
        bucketValue !== undefined &&
        bucketValue !== null &&
        String(rowValue) === String(bucketValue)
      );
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The cursor is a position in the total order (_nizhal_row_version, id). _nizhal_row_version is the
// writing transaction's xid8 (lock-free), so rows of one transaction tie on it — the id breaks the
// tie. Encoding both keeps pagination exact across tied rows.
interface CursorPosition {
  seq: bigint;
  id: string;
}

const INITIAL_POSITION: CursorPosition = { seq: 0n, id: "" };

function encodeCursor(position: CursorPosition): Cursor {
  return Buffer.from(`${position.seq.toString()}\0${position.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: Cursor): CursorPosition | null {
  if (cursor === INITIAL_CURSOR) return { ...INITIAL_POSITION };
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.indexOf("\0");
    if (sep === -1) return null;
    const seq = raw.slice(0, sep);
    if (!/^(0|[1-9][0-9]*)$/.test(seq)) return null;
    return { seq: BigInt(seq), id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

async function normalizePullCursor(
  db: NizhalDb,
  cursor: Cursor,
): Promise<{
  effective: CursorPosition;
  horizon: bigint;
  reset: boolean;
  epoch: string;
  gcHorizon: bigint | null;
}> {
  // One round-trip fetches: the settled-prefix horizon (every transaction with xid < horizon is
  // committed-or-aborted, and no future write can be assigned an xid below it — advancing the cursor
  // only up to here makes the out-of-order-commit skip structurally impossible; see
  // _nizhal_next_row_version), plus the server epoch and the tombstone GC horizon from the singleton
  // _nizhal_sync_control (folded in to avoid a second round-trip per pull).
  const rows = await executeRows<{ horizon: unknown; epoch: string; gc_horizon: unknown }>(
    db,
    sql`select pg_snapshot_xmin(pg_current_snapshot())::text as horizon,
        sc.epoch as epoch,
        sc.tombstone_horizon::text as gc_horizon
      from _nizhal_sync_control sc where sc.id = true`,
  );
  const row = rows[0];
  const horizon = bigintValue(row?.horizon) ?? 0n;
  const gcHorizon = bigintValue(row?.gc_horizon);
  const epoch = row?.epoch ?? "";
  const decoded = decodeCursor(cursor);
  // null = unparseable/legacy cursor; seq beyond the horizon = corrupt (a valid cursor only ever
  // advances over delivered rows, which are all below a past horizon). Either way, re-bootstrap.
  if (decoded === null || decoded.seq > horizon) {
    return { effective: { ...INITIAL_POSITION }, horizon, reset: true, epoch, gcHorizon };
  }
  // GC horizon: a cursor strictly older than the pruned-tombstone watermark has missed deletions
  // whose tombstones no longer exist — re-bootstrap so those rows don't resurrect. seq 0 is a fresh
  // bootstrap (nothing yet delivered, nothing to miss), so it is exempt.
  if (gcHorizon !== null && decoded.seq > 0n && decoded.seq < gcHorizon) {
    return { effective: { ...INITIAL_POSITION }, horizon, reset: true, epoch, gcHorizon };
  }
  return { effective: decoded, horizon, reset: false, epoch, gcHorizon };
}

async function getPostgresChanges(
  db: NizhalDb,
  input: {
    actor: Actor;
    syncRules: SyncRules;
    cursor: Cursor;
    deviceId?: string;
    limit?: number;
  },
): Promise<PullResult> {
  const normalized = await normalizePullCursor(db, input.cursor);
  let cursor = normalized.effective;
  const horizon = normalized.horizon;
  let cursorReset = normalized.reset;
  const syncedTables = collectSyncRuleTables(input.syncRules);
  const bucketRows = await resolveActorBucketRows(db, input.actor, input.syncRules);
  const bucketKeys = Array.from(collectBucketKeys(bucketRows));

  // G1: when the actor's bucket set GROWS (gains access to a bucket — joins a channel, is added to
  // a shop), that bucket's pre-existing rows have row_version <= the global cursor and the `> cursor`
  // filter would skip them forever. Re-bootstrap (pull from 0 + cursorReset) so the newly-visible
  // history backfills. Only for an established device — a first-time device (no stored buckets)
  // bootstraps from its initial cursor normally.
  if (input.deviceId) {
    const storedBuckets = await storedClientBuckets(
      db,
      actorScopedDeviceId(input.actor, input.deviceId),
    );
    if (storedBuckets.length > 0) {
      const known = new Set(storedBuckets.map(String));
      if (bucketKeys.some((key) => !known.has(String(key)))) {
        cursor = { ...INITIAL_POSITION };
        cursorReset = true;
      }
    }
  }

  const candidates: PullCandidate[] = [];
  const seenRows = new Set<string>();

  for (const { rule, rows } of bucketRows.values()) {
    const queries = flattenDataQueries(rule.data(bucketProxy(rule.bucketColumns ?? [])));
    for (const query of queries) {
      if (!syncedTables.has(query.table)) continue;
      if (rows.length === 0) continue;
      const queryRows = await executeRows<Record<string, unknown>>(
        db,
        buildDataQuery(query, rows, cursor, horizon),
      );
      for (const row of queryRows) {
        const rowKey = rowIdentity(query.table, row);
        if (seenRows.has(rowKey)) continue;
        seenRows.add(rowKey);
        const version = bigintValue(row._nizhal_row_version);
        if (version === null) continue;
        candidates.push({ type: "change", table: query.table, row, version });
      }
    }
  }

  candidates.push(...(await getRemovalCandidates(db, cursor, horizon, bucketKeys)));
  const visibleRemovalRows = await getVisibleRemovalRows(db, bucketRows, candidates);
  const scopedCandidates = candidates.filter(
    (candidate) =>
      candidate.type !== "bucket_exit" ||
      !visibleRemovalRows.has(`${candidate.table}:${candidate.id}`),
  );
  scopedCandidates.sort(compareCandidates);
  const limit = input.limit;
  const page =
    limit !== undefined && limit > 0 ? scopedCandidates.slice(0, limit) : scopedCandidates;
  const hasMore = limit !== undefined && limit > 0 && scopedCandidates.length > page.length;

  const changed = new Map<string, Record<string, unknown>[]>();
  const tombstoned: PullResult["tombstoned"] = [];
  const removed: NonNullable<PullResult["removed"]> = [];
  let nextPosition = cursor;
  for (const candidate of page) {
    nextPosition = { seq: candidate.version, id: candidateSortId(candidate) };
    if (candidate.type === "change") {
      const tableRows = changed.get(candidate.table) ?? [];
      tableRows.push(candidate.row);
      changed.set(candidate.table, tableRows);
      continue;
    }
    const removal = {
      table: candidate.table,
      id: candidate.id,
      ...(candidate.key !== candidate.id ? { key: candidate.key } : {}),
    };
    if (candidate.type === "tombstone") tombstoned.push(removal);
    else removed.push(removal);
  }

  const nextCursor = encodeCursor(nextPosition);
  const removedBuckets = await reconcileClientBuckets(db, {
    actor: input.actor,
    deviceId: input.deviceId,
    currentBuckets: bucketKeys,
    cursor: nextCursor,
  });
  return {
    changed: Array.from(changed, ([table, rows]) => ({ table, rows })),
    tombstoned,
    removed,
    removedBuckets,
    cursor: nextCursor,
    epoch: normalized.epoch,
    ...(cursorReset ? { cursorReset: true } : {}),
    ...(hasMore ? { hasMore: true } : {}),
  };
}

async function resolveActorBucketRows(
  db: NizhalDb,
  actor: Actor,
  rules: SyncRules,
  lockMembershipRows = false,
): Promise<
  Map<
    string,
    {
      rule: SyncRules[string];
      rows: Record<string, unknown>[];
    }
  >
> {
  const result = new Map<
    string,
    {
      rule: SyncRules[string];
      rows: Record<string, unknown>[];
    }
  >();

  for (const [name, rule] of Object.entries(rules)) {
    const parameters = rule.parameters(actor);
    result.set(name, {
      rule,
      rows: await resolveParameterRows(db, actor, parameters, lockMembershipRows),
    });
  }

  return result;
}

async function resolveParameterRows(
  db: NizhalDb,
  actor: Actor,
  parameters: ParameterQuery | Record<string, never>,
  lockMembershipRows = false,
): Promise<Record<string, unknown>[]> {
  if (isMembershipQuery(parameters)) {
    return executeRows<Record<string, unknown>>(
      db,
      buildMembershipParameterQuery(parameters, lockMembershipRows),
    );
  }
  if (!isQuery(parameters)) return [];
  if (parameters.raw) return executeRows<Record<string, unknown>>(db, sql.raw(parameters.raw));
  const bucketColumns = getBucketColumns(parameters);
  if (!bucketColumns) return [];

  const row: Record<string, unknown> = {};
  for (const [bucketKey, column] of Object.entries(bucketColumns)) {
    const value = actorValue(actor, bucketKey, column);
    if (value === undefined || value === null) return [];
    row[bucketKey] = value;
  }
  return [row];
}

function buildMembershipParameterQuery(
  parameters: MembershipQuery,
  lockRows: boolean,
): ReturnType<typeof sql> {
  const selectParts = Object.entries(parameters.bucketColumns).map(
    ([bucketKey, column]) => sql`${sql.identifier(column)} as ${sql.identifier(bucketKey)}`,
  );
  const whereParts = Object.entries(parameters.where).map(
    ([column, value]) => sql`${sql.identifier(column)} = ${value}`,
  );
  if (whereParts.length === 0) {
    throw new Error("Membership parameter query requires at least one where predicate");
  }
  const lock = lockRows ? sql` for share` : sql``;
  return sql`select ${sql.join(selectParts, sql`, `)} from ${sql.identifier(parameters.table)} where ${sql.join(whereParts, sql` and `)}${lock}`;
}

function buildDataQuery(
  query: Query,
  bucketRows: readonly Record<string, unknown>[],
  cursor: CursorPosition,
  horizon: bigint,
): ReturnType<typeof sql> {
  const source = query.raw
    ? sql`(${sql.raw(query.raw)}) as ${sql.identifier("_nizhal_source")}`
    : sql.identifier(query.table);
  const version = sql.identifier("_nizhal_row_version");
  const id = sql.identifier("id");
  const seq = cursor.seq.toString();
  const conditions = [
    // strictly after the (seq, id) frontier (rows of one txn tie on seq → id breaks the tie)…
    sql`(${version} > ${seq}::xid8 or (${version} = ${seq}::xid8 and ${id}::text > ${cursor.id}))`,
    // …and strictly below the settled-prefix horizon, so an in-flight txn's rows are never crossed.
    sql`${version} < ${horizon.toString()}::xid8`,
    sql`${sql.identifier("deleted_at")} is null`,
    buildBucketScope(query, bucketRows),
  ];
  return sql`select * from ${source}
where ${sql.join(conditions, sql` and `)}
order by ${version} asc, ${id}::text asc`;
}

function buildBucketScope(
  query: Query,
  bucketRows: readonly Record<string, unknown>[],
): ReturnType<typeof sql> {
  if (bucketRows.length === 0) {
    throw new Error("Cannot build sync-rule data query without bucket rows");
  }
  if (query.predicates.length === 1) {
    const predicate = query.predicates[0];
    if (!predicate) throw new Error("Missing sync-rule bucket predicate");
    const values = collectBucketValues(bucketRows, predicate.bucket.key);
    if (values.length === 0) {
      throw new Error(`Missing sync-rule bucket value '${predicate.bucket.key}'`);
    }
    if (values.length === 1) {
      return sql`${sql.identifier(predicate.column)} = ${values[0]}`;
    }
    return inArray(sql.identifier(predicate.column), values);
  }

  const scopes: ReturnType<typeof sql>[] = [];
  for (const bucketRow of bucketRows) {
    const predicates: ReturnType<typeof sql>[] = [];
    for (const predicate of query.predicates) {
      const value = bucketRow[predicate.bucket.key];
      if (value === undefined || value === null) {
        predicates.length = 0;
        break;
      }
      predicates.push(sql`${sql.identifier(predicate.column)} = ${value}`);
    }
    if (predicates.length === query.predicates.length) {
      scopes.push(sql`(${sql.join(predicates, sql` and `)})`);
    }
  }
  if (scopes.length === 0) {
    throw new Error("Missing sync-rule bucket values for multi-predicate query");
  }
  const [onlyScope] = scopes;
  if (scopes.length === 1 && onlyScope) return onlyScope;
  return sql`(${sql.join(scopes, sql` or `)})`;
}

function collectBucketValues(
  bucketRows: readonly Record<string, unknown>[],
  bucketKey: string,
): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const bucketRow of bucketRows) {
    const value = bucketRow[bucketKey];
    if (value === undefined || value === null) continue;
    const identity = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    values.push(value);
  }
  return values;
}

type PullCandidate =
  | {
      type: "change";
      table: string;
      row: Record<string, unknown>;
      version: bigint;
    }
  | {
      type: "tombstone" | "bucket_exit";
      table: string;
      id: string;
      key: string;
      version: bigint;
    };

async function getRemovalCandidates(
  db: NizhalDb,
  cursor: CursorPosition,
  horizon: bigint,
  bucketKeys: readonly string[],
): Promise<PullCandidate[]> {
  if (bucketKeys.length === 0) return [];
  const seq = cursor.seq.toString();
  const rows = await db
    .select({
      tableName: nizhalTombstones.tableName,
      rowId: nizhalTombstones.rowId,
      clientKey: nizhalTombstones.clientKey,
      kind: nizhalTombstones.kind,
      rowVersion: nizhalTombstones.rowVersion,
    })
    .from(nizhalTombstones)
    .where(
      sql`(${nizhalTombstones.rowVersion} > ${seq}::xid8 or (${nizhalTombstones.rowVersion} = ${seq}::xid8 and ${nizhalTombstones.rowId} > ${cursor.id})) and ${nizhalTombstones.rowVersion} < ${horizon.toString()}::xid8 and ${inArray(
        nizhalTombstones.bucketKey,
        [...bucketKeys],
      )}`,
    )
    .orderBy(asc(nizhalTombstones.rowVersion), asc(nizhalTombstones.rowId));
  const removals: PullCandidate[] = [];
  for (const row of rows) {
    removals.push({
      type: row.kind === "bucket_exit" ? "bucket_exit" : "tombstone",
      table: row.tableName,
      id: row.rowId,
      key: row.clientKey,
      version: row.rowVersion,
    });
  }
  return removals;
}

async function getVisibleRemovalRows(
  db: NizhalDb,
  bucketRows: Map<string, { rule: SyncRules[string]; rows: Record<string, unknown>[] }>,
  candidates: readonly PullCandidate[],
): Promise<Set<string>> {
  const idsByTable = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.type !== "bucket_exit") continue;
    const ids = idsByTable.get(candidate.table) ?? new Set<string>();
    ids.add(candidate.id);
    idsByTable.set(candidate.table, ids);
  }
  if (idsByTable.size === 0) return new Set();

  const visible = new Set<string>();
  for (const { rule, rows } of bucketRows.values()) {
    if (rows.length === 0) continue;
    for (const query of flattenDataQueries(rule.data(bucketProxy(rule.bucketColumns ?? [])))) {
      const ids = idsByTable.get(query.table);
      if (!ids?.size) continue;
      const queryRows = await executeRows<{ id: unknown }>(
        db,
        buildVisibleRowsQuery(query, rows, [...ids]),
      );
      for (const row of queryRows) visible.add(`${query.table}:${String(row.id)}`);
    }
  }
  return visible;
}

function buildVisibleRowsQuery(
  query: Query,
  bucketRows: readonly Record<string, unknown>[],
  ids: readonly string[],
): ReturnType<typeof sql> {
  const source = query.raw
    ? sql`(${sql.raw(query.raw)}) as ${sql.identifier("_nizhal_source")}`
    : sql.identifier(query.table);
  return sql`select ${sql.identifier("id")} from ${source}
where ${sql.identifier("id")}::text in ${ids}
  and ${sql.identifier("deleted_at")} is null
  and ${buildBucketScope(query, bucketRows)}`;
}

function collectBucketKeys(
  bucketRows: Map<string, { rule: SyncRules[string]; rows: Record<string, unknown>[] }>,
): Set<string> {
  const keys = new Set<string>();
  for (const { rows } of bucketRows.values()) {
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value !== undefined && value !== null) keys.add(String(value));
      }
    }
  }
  return keys;
}

async function reconcileClientBuckets(
  db: NizhalDb,
  input: {
    actor: Actor;
    deviceId?: string;
    currentBuckets: readonly BucketKey[];
    cursor: Cursor;
  },
): Promise<BucketKey[]> {
  const current = new Set(input.currentBuckets.map(String));
  if (!input.deviceId) return [];
  const storageClientId = actorScopedDeviceId(input.actor, input.deviceId);
  const previous = await storedClientBuckets(db, storageClientId);
  const removed = Array.from(new Set(previous.filter((bucket) => !current.has(bucket)))).sort();

  await db.delete(nizhalClientBuckets).where(eq(nizhalClientBuckets.clientId, storageClientId));
  for (const bucket of current) {
    await db
      .insert(nizhalClientBuckets)
      .values({
        clientId: storageClientId,
        bucketKey: bucket,
        lastSeenCursor: decodeCursor(input.cursor)?.seq ?? 0n,
      })
      .onConflictDoUpdate({
        target: [nizhalClientBuckets.clientId, nizhalClientBuckets.bucketKey],
        set: {
          lastSeenCursor: decodeCursor(input.cursor)?.seq ?? 0n,
          updatedAt: sql`now()`,
        },
      });
  }

  return removed;
}

async function storedClientBuckets(db: NizhalDb, clientId: string): Promise<string[]> {
  const rows = await db
    .select({ bucketKey: nizhalClientBuckets.bucketKey })
    .from(nizhalClientBuckets)
    .where(eq(nizhalClientBuckets.clientId, clientId))
    .orderBy(asc(nizhalClientBuckets.bucketKey));
  return rows.map((row) => row.bucketKey);
}

function actorScopedDeviceId(actor: Actor, deviceId: string): string {
  return JSON.stringify(["actor-device", actor.ownerId, actor.userId, deviceId]);
}

function rowIdentity(table: string, row: Record<string, unknown>): string {
  return `${table}:${row.id === undefined || row.id === null ? JSON.stringify(row) : String(row.id)}`;
}

// The id used to break ties within one transaction's rows (same xid8). MUST stay consistent with the
// SQL frontier/order-by (`id::text` / `row_id`) or paging could skip or duplicate a tied row.
function candidateSortId(candidate: PullCandidate): string {
  if (candidate.type !== "change") return candidate.id;
  const id = candidate.row.id;
  return id === undefined || id === null ? "" : String(id);
}

function compareCandidates(left: PullCandidate, right: PullCandidate): number {
  if (left.version !== right.version) return left.version < right.version ? -1 : 1;
  const leftId = candidateSortId(left);
  const rightId = candidateSortId(right);
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

function bigintValue(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}

function actorValue(actor: Actor, bucketKey: string, column: string): unknown {
  if (bucketKey in actor) return actor[bucketKey];
  const camelColumn = snakeToCamel(column);
  if (camelColumn in actor) return actor[camelColumn];
  if (column in actor) return actor[column];
  return undefined;
}

function snakeToCamel(value: string): string {
  return value.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function getBucketColumns(query: Query): Record<string, string> | null {
  const candidate = query as Query & { bucketColumns?: Record<string, string> };
  return candidate.bucketColumns ?? null;
}

function isMembershipQuery(value: unknown): value is MembershipQuery {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as MembershipQuery).kind === "echo-membership" &&
    typeof (value as MembershipQuery).table === "string" &&
    typeof (value as MembershipQuery).where === "object" &&
    (value as MembershipQuery).where !== null &&
    typeof (value as MembershipQuery).bucketColumns === "object" &&
    (value as MembershipQuery).bucketColumns !== null
  );
}

function isQuery(value: unknown): value is Query {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Query).kind === "nizhal-query" &&
    typeof (value as Query).table === "string" &&
    Array.isArray((value as Query).predicates)
  );
}

function bucketProxy(
  keys: readonly string[],
): Record<string, { kind: "bucket-column"; key: string }> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (keys.length > 0 && !keys.includes(property)) {
          throw new Error(`Unknown sync-rule bucket key '${property}'`);
        }
        return { kind: "bucket-column", key: property };
      },
    },
  );
}

/**
 * Current engine schema version. Bump when the `_nizhal_*` infrastructure changes shape, and add a
 * migration to {@link engineMigrations} that carries an existing DB from the prior version to this one.
 *   v1 — bigint row-version from a global sequence (`_nizhal_row_version_seq`) under a singleton lock.
 *   v2 — xid8 row-version = `pg_current_xact_id()`, lock-free + no-skip (commit b46af0-era xid8 fix).
 */
export const NIZHAL_ENGINE_VERSION = 2;

type ProvisionInput = {
  schema: Record<string, ContractSchemaSource>;
  syncRules: SyncRules;
  audit?: boolean;
};

interface EngineMigration {
  /** The engine version this migration produces (its predecessor is `to - 1`). */
  to: number;
  statements(input: ProvisionInput): string[];
}

const META_TABLE_DDL = `create table if not exists _nizhal_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
)`;

function stampEngineVersionStatement(version: number): string {
  return `insert into _nizhal_meta (key, value) values ('engine_version', '${version}')
on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/**
 * The engine version a database is currently at: `0` = fresh (no engine tables), otherwise the stamped
 * `_nizhal_meta.engine_version`, or — for a pre-versioning legacy install with no stamp — inferred from
 * the `_nizhal_tombstones.row_version` column type (xid8 ⇒ v2, bigint ⇒ v1).
 */
async function detectEngineVersion(db: NizhalDb): Promise<number> {
  const stamped = await executeRows<{ value: string }>(
    db,
    sql`select value from _nizhal_meta where key = 'engine_version'`,
  );
  const raw = stamped[0]?.value;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const present = await executeRows<{ present: boolean }>(
    db,
    sql`select to_regclass('_nizhal_tombstones') is not null as present`,
  );
  if (!present[0]?.present) return 0;
  const type = await executeRows<{ udt_name: string }>(
    db,
    sql`select udt_name from information_schema.columns
        where table_name = '_nizhal_tombstones' and column_name = 'row_version'`,
  );
  return type[0]?.udt_name === "xid8" ? 2 : 1;
}

// v1 → v2: bigint sequence row-version → xid8 `pg_current_xact_id()`. Existing bigint versions cast to
// xid8 numerically (small values that sort strictly below any real transaction id), so row order — and
// therefore every client's cursor position — is preserved with no re-sync and no data loss.
function bigintToXid8Statements(input: ProvisionInput): string[] {
  const tables = syncedTablePlans(input.schema, input.syncRules);
  const withAudit = input.audit !== false;
  const stmts: string[] = [];

  // 1. Drop the defaults that hard-depend on the bigint version function so it can be replaced.
  for (const t of tables) {
    stmts.push(
      `alter table ${quoteIdentifier(t.table)} alter column _nizhal_row_version drop default`,
    );
  }
  stmts.push("alter table _nizhal_tombstones alter column row_version drop default");
  if (withAudit) stmts.push("alter table _nizhal_audit_log alter column row_version drop default");

  // 2. Swap the version function to xid8 (return-type change ⇒ drop + create, not replace). plpgsql
  //    trigger bodies resolve it at runtime, so they need no dependency handling here.
  stmts.push("drop function if exists _nizhal_next_row_version()");
  stmts.push(`create function _nizhal_next_row_version()
returns xid8
language sql
as $$ select pg_current_xact_id() $$`);

  // 3. Convert every row-version column bigint → xid8 (numeric text is a valid xid8 literal) + re-default.
  for (const t of tables) {
    const n = quoteIdentifier(t.table);
    stmts.push(
      `alter table ${n} alter column _nizhal_row_version type xid8 using _nizhal_row_version::text::xid8`,
    );
    stmts.push(
      `alter table ${n} alter column _nizhal_row_version set default _nizhal_next_row_version()`,
    );
  }
  stmts.push(
    "alter table _nizhal_tombstones alter column row_version type xid8 using row_version::text::xid8",
  );
  stmts.push(
    "alter table _nizhal_tombstones alter column row_version set default _nizhal_next_row_version()",
  );
  if (withAudit) {
    stmts.push(
      "alter table _nizhal_audit_log alter column row_version type xid8 using row_version::text::xid8",
    );
    stmts.push(
      "alter table _nizhal_audit_log alter column row_version set default _nizhal_next_row_version()",
    );
  }

  // 4. Retire the global sequence and the UNIQUE tombstone index (rows of one txn now share its xid).
  stmts.push("drop sequence if exists _nizhal_row_version_seq");
  stmts.push("drop index if exists _nizhal_tombstones_row_version_key");
  stmts.push("drop index if exists _nizhal_tombstones_row_version_idx");
  stmts.push(
    "create index if not exists _nizhal_tombstones_row_version_idx on _nizhal_tombstones (row_version)",
  );
  return stmts;
}

const engineMigrations: EngineMigration[] = [{ to: 2, statements: bigintToXid8Statements }];

/**
 * Bring a database to {@link NIZHAL_ENGINE_VERSION}: provision fresh, run ordered migrations for an
 * older install, or idempotently refresh a current one — then stamp the version. Throws if the database
 * is at a NEWER engine version than this server (roll the server forward first).
 */
async function provisionToCurrent(db: NizhalDb, input: ProvisionInput): Promise<void> {
  await db.execute(sql.raw(META_TABLE_DDL));
  const from = await detectEngineVersion(db);
  if (from > NIZHAL_ENGINE_VERSION) {
    throw new Error(
      `[@nizhal] database engine is v${from}, newer than this server (v${NIZHAL_ENGINE_VERSION}) — upgrade the server before running migrate`,
    );
  }
  if (from > 0 && from < NIZHAL_ENGINE_VERSION) {
    for (const migration of engineMigrations) {
      if (migration.to > from && migration.to <= NIZHAL_ENGINE_VERSION) {
        for (const statement of migration.statements(input)) await db.execute(sql.raw(statement));
      }
    }
  }
  const plan = buildPostgresProvisionPlan(input);
  for (const statement of plan.statements) await db.execute(sql.raw(statement));
  await db.execute(sql.raw(stampEngineVersionStatement(NIZHAL_ENGINE_VERSION)));
}

/**
 * Drop every engine artifact (`_nizhal_*` tables/functions/sequence + the per-synced-table row-version
 * columns, triggers, and bucket indexes) then reprovision fresh at the current version. The clean-slate
 * upgrade path — for alpha, where discarding local replicas and re-syncing is acceptable.
 */
export function buildResetStatements(input: ProvisionInput): string[] {
  const tables = syncedTablePlans(input.schema, input.syncRules);
  const stmts: string[] = [];
  for (const t of tables) {
    const n = quoteIdentifier(t.table);
    stmts.push(`drop trigger if exists ${quoteIdentifier(`_nizhal_touch_${t.table}`)} on ${n}`);
    for (const bucketColumn of t.bucketColumns) {
      stmts.push(
        `drop trigger if exists ${quoteIdentifier(`_nizhal_remove_${t.table}_${bucketColumn}_trg`)} on ${n}`,
      );
      stmts.push(
        `drop function if exists ${quoteIdentifier(`_nizhal_remove_${t.table}_${bucketColumn}`)}()`,
      );
      stmts.push(
        `drop index if exists ${quoteIdentifier(`_nizhal_${t.table}_${bucketColumn}_row_version_idx`)}`,
      );
    }
    stmts.push(`alter table ${n} drop column if exists _nizhal_row_version`);
    if (t.merge === "field") stmts.push(`alter table ${n} drop column if exists _meta`);
  }
  for (const table of [
    "_nizhal_audit_log",
    "_nizhal_jobs",
    "_nizhal_client_buckets",
    "_nizhal_tombstones",
    "_nizhal_sync_control",
    "_nizhal_clients",
    "_nizhal_mutations",
    "_nizhal_meta",
  ]) {
    stmts.push(`drop table if exists ${table} cascade`);
  }
  stmts.push("drop function if exists _nizhal_touch_updated_at() cascade");
  stmts.push("drop function if exists _nizhal_next_row_version() cascade");
  stmts.push("drop sequence if exists _nizhal_row_version_seq");
  return stmts;
}

export function buildPostgresProvisionPlan(input: {
  schema: Record<string, ContractSchemaSource>;
  syncRules: SyncRules;
  audit?: boolean;
}): ProvisionPlan {
  const tablePlans = syncedTablePlans(input.schema, input.syncRules);
  return {
    statements: [
      ...engineStatements(),
      ...(input.audit !== false ? auditStatements() : []),
      ...tablePlans.flatMap(tableStatements),
    ],
  };
}

function auditStatements(): string[] {
  return [
    `create table if not exists _nizhal_audit_log (
  row_version xid8 primary key default _nizhal_next_row_version(),
  client_mutation_id text not null,
  mutation_name text not null,
  args jsonb not null,
  actor jsonb not null,
  client_id text,
  mutation_id bigint,
  hlc text,
  affected_buckets jsonb not null,
  created_at timestamptz not null default now()
)`,
    "create index if not exists _nizhal_audit_log_created_at_idx on _nizhal_audit_log (created_at)",
    "create index if not exists _nizhal_audit_log_actor_idx on _nizhal_audit_log using gin (actor)",
    "create index if not exists _nizhal_audit_log_buckets_idx on _nizhal_audit_log using gin (affected_buckets)",
  ];
}

function syncedTablePlans(
  schema: Record<string, ContractSchemaSource>,
  syncRules: SyncRules,
): SyncedTablePlan[] {
  const schemaTables = new Map<string, string>();
  const schemaMerge = new Map<string, MergeMode>();
  for (const [fallbackName, source] of Object.entries(schema)) {
    const resolvedName = isNizhalTable(source)
      ? tableName(source)
      : schemaTableName(source, fallbackName);
    schemaTables.set(resolvedName, resolvedName);
    schemaTables.set(fallbackName, resolvedName);
    schemaMerge.set(resolvedName, schemaMergeMode(source));
  }
  const plans = new Map<string, SyncedTablePlan>();
  for (const table of collectSyncRuleTables(syncRules).values()) {
    const resolvedTable = schemaTables.get(table.table) ?? table.table;
    plans.set(resolvedTable, {
      table: resolvedTable,
      bucketColumns: Array.from(table.bucketColumns).sort(),
      merge: schemaMerge.get(resolvedTable) ?? "lww",
    });
  }
  for (const [table, merge] of schemaMerge) {
    if (merge !== "field" || plans.has(table)) continue;
    plans.set(table, { table, bucketColumns: [], merge });
  }
  return Array.from(plans.values());
}

function engineStatements(): string[] {
  return [
    `create table if not exists _nizhal_mutations (
  client_mutation_id text primary key,
  client_id text,
  server_id text,
  error text,
  applied_at timestamptz not null default now()
)`,
    `create table if not exists _nizhal_clients (
  client_id text primary key,
  last_mutation_id bigint not null default 0
)`,
    `create table if not exists _nizhal_sync_control (
  id boolean primary key default true,
  suppress_notify boolean not null default false,
  epoch text not null default gen_random_uuid()::text,
  tombstone_horizon xid8,
  updated_at timestamptz not null default now(),
  constraint _nizhal_sync_control_singleton check (id)
)`,
    "insert into _nizhal_sync_control (id) values (true) on conflict (id) do nothing",
    // Additive evolution for installs provisioned before epochs/GC-horizon existed. epoch is minted
    // once here (stable across re-provisions — only `nizhal reset` drops the row → new epoch).
    "alter table _nizhal_sync_control add column if not exists epoch text",
    "alter table _nizhal_sync_control alter column epoch set default gen_random_uuid()::text",
    "update _nizhal_sync_control set epoch = gen_random_uuid()::text where epoch is null",
    "alter table _nizhal_sync_control alter column epoch set not null",
    "alter table _nizhal_sync_control add column if not exists tombstone_horizon xid8",
    // Lock-free, commit-ordered watermark: the writing transaction's monotonic 64-bit id. Replaces a
    // singleton FOR UPDATE (which serialized ALL writes to force assignment-order == commit-order).
    // Readers stay no-skip by only advancing their cursor to pg_snapshot_xmin (the settled-prefix
    // horizon) — see getPostgresChanges. Rows of one transaction share its id (tiebreak by pk/id).
    `create or replace function _nizhal_next_row_version()
returns xid8
language sql
as $$ select pg_current_xact_id() $$`,
    `create table if not exists _nizhal_tombstones (
  table_name text not null,
  row_id text not null,
  client_key text not null,
  bucket_key text not null,
  kind text not null default 'tombstone',
  row_version xid8 not null default _nizhal_next_row_version(),
  deleted_at timestamptz not null default now(),
  primary key (table_name, row_id, bucket_key, row_version)
)`,
    "alter table _nizhal_tombstones add column if not exists client_key text",
    "update _nizhal_tombstones set client_key = row_id where client_key is null",
    "alter table _nizhal_tombstones alter column client_key set not null",
    "alter table _nizhal_tombstones add column if not exists kind text not null default 'tombstone'",
    "alter table _nizhal_tombstones add column if not exists row_version xid8",
    "alter table _nizhal_tombstones alter column row_version set default _nizhal_next_row_version()",
    "update _nizhal_tombstones set row_version = _nizhal_next_row_version() where row_version is null",
    "alter table _nizhal_tombstones alter column row_version set not null",
    // non-unique: rows of one transaction share its xid (no longer a globally-unique sequence).
    "create index if not exists _nizhal_tombstones_row_version_idx on _nizhal_tombstones (row_version)",
    `create table if not exists _nizhal_client_buckets (
  client_id text not null,
  bucket_key text not null,
  last_seen_cursor bigint not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, bucket_key)
)`,
    `create table if not exists _nizhal_jobs (
  id bigserial primary key,
  task_slug text not null,
  input jsonb not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)`,
    "create index if not exists _nizhal_jobs_due_idx on _nizhal_jobs (status, run_at, id)",
    `create or replace function _nizhal_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new._nizhal_row_version = _nizhal_next_row_version();
  return new;
end;
$$`,
  ];
}

function tableStatements(table: SyncedTablePlan): string[] {
  const tableNameSql = quoteIdentifier(table.table);
  return [
    `alter table ${tableNameSql} add column if not exists updated_at timestamptz not null default now()`,
    `alter table ${tableNameSql} add column if not exists deleted_at timestamptz`,
    `alter table ${tableNameSql} add column if not exists _nizhal_row_version xid8 not null default _nizhal_next_row_version()`,
    `alter table ${tableNameSql} alter column _nizhal_row_version set default _nizhal_next_row_version()`,
    ...(table.merge === "field"
      ? [
          `alter table ${tableNameSql} add column if not exists _meta jsonb not null default '{}'::jsonb`,
        ]
      : []),
    `drop trigger if exists ${quoteIdentifier(`_nizhal_touch_${table.table}`)} on ${tableNameSql}`,
    `create trigger ${quoteIdentifier(`_nizhal_touch_${table.table}`)}
before update on ${tableNameSql}
for each row
execute function _nizhal_touch_updated_at()`,
    ...table.bucketColumns.flatMap((bucketColumn) => bucketStatements(table.table, bucketColumn)),
  ];
}

function bucketStatements(table: string, bucketColumn: string): string[] {
  const tableNameSql = quoteIdentifier(table);
  const columnNameSql = quoteIdentifier(bucketColumn);
  const indexName = quoteIdentifier(`_nizhal_${table}_${bucketColumn}_row_version_idx`);
  const removalFunction = quoteIdentifier(`_nizhal_remove_${table}_${bucketColumn}`);
  const removalTrigger = quoteIdentifier(`_nizhal_remove_${table}_${bucketColumn}_trg`);
  return [
    `create index if not exists ${indexName} on ${tableNameSql} (${columnNameSql}, _nizhal_row_version)`,
    `create or replace function ${removalFunction}()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    insert into _nizhal_tombstones
      (table_name, row_id, client_key, bucket_key, kind, row_version, deleted_at)
    values (
      ${sqlLiteral(table)},
      old.id::text,
      coalesce(to_jsonb(old)->>'client_id', old.id::text),
      old.${columnNameSql}::text,
      'tombstone',
      _nizhal_next_row_version(),
      now()
    );
    return old;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    insert into _nizhal_tombstones
      (table_name, row_id, client_key, bucket_key, kind, row_version, deleted_at)
    values (
      ${sqlLiteral(table)},
      old.id::text,
      coalesce(to_jsonb(old)->>'client_id', old.id::text),
      old.${columnNameSql}::text,
      'tombstone',
      _nizhal_next_row_version(),
      now()
    );
  elsif old.${columnNameSql} is distinct from new.${columnNameSql} then
    insert into _nizhal_tombstones
      (table_name, row_id, client_key, bucket_key, kind, row_version, deleted_at)
    values (
      ${sqlLiteral(table)},
      old.id::text,
      coalesce(to_jsonb(old)->>'client_id', old.id::text),
      old.${columnNameSql}::text,
      'bucket_exit',
      _nizhal_next_row_version(),
      now()
    );
  end if;
  return new;
end;
$$`,
    `drop trigger if exists ${quoteIdentifier(`_nizhal_tombstone_${table}_${bucketColumn}_trg`)} on ${tableNameSql}`,
    `drop trigger if exists ${removalTrigger} on ${tableNameSql}`,
    `create trigger ${removalTrigger}
after update or delete on ${tableNameSql}
for each row
execute function ${removalFunction}()`,
  ];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid Postgres identifier '${identifier}'`);
  }
  return `"${identifier}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
