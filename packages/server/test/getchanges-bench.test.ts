import { PGlite } from "@electric-sql/pglite";
import type { Actor, ContractSchemaSource, PullResult } from "@nizhal/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresStorage } from "../src/adapters/storage.js";
import { CREDIT_LEDGER_DDL, creditLedgerSchema } from "./fixtures/credit-ledger-schema.js";
import { creditLedgerSyncRules } from "./fixtures/credit-ledger-sync-rules.js";

const openDbs: PGlite[] = [];

const BENCH_SHOPS = 50;
const BENCH_ROWS_PER_TABLE = 200;
const SYNCED_TABLE_COUNT = 3;

const benchActor: Actor = { userId: "bench-user", ownerId: "bench-owner" };

describe("getChanges scale benchmark", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(openDbs.splice(0).map((db) => db.close()));
  });

  it("batches data queries to O(T) instead of O(M*T)", async () => {
    const { storage } = await createSeededCreditLedgerStorage();
    const executeSpy = vi.spyOn(await import("../src/drizzle-db.js"), "executeRows");

    const started = performance.now();
    const result = await storage.getChanges({
      actor: benchActor,
      syncRules: creditLedgerSyncRules,
      cursor: "",
    });
    const elapsedMs = performance.now() - started;

    const dataQueryCalls = executeSpy.mock.calls.length;
    const expectedBatchedCalls = 2 + SYNCED_TABLE_COUNT;

    console.log(
      `[getchanges-bench] shops=${BENCH_SHOPS} rowsPerTable=${BENCH_ROWS_PER_TABLE} ` +
        `executeRows=${dataQueryCalls} latencyMs=${elapsedMs.toFixed(1)} ` +
        `changedTables=${result.changed.length}`,
    );

    expect(dataQueryCalls).toBe(expectedBatchedCalls);
    expect(dataQueryCalls).toBeLessThan(2 + BENCH_SHOPS * SYNCED_TABLE_COUNT);
    expect(result.changed).toHaveLength(SYNCED_TABLE_COUNT);
    for (const table of result.changed) {
      expect(table.rows.length).toBeGreaterThanOrEqual(BENCH_SHOPS * BENCH_ROWS_PER_TABLE - 1);
    }
  }, 120_000);

  it("returns deterministic batched results for identical databases", async () => {
    const { storage: firstStorage } = await createSeededCreditLedgerStorage({
      seed: 42,
      shops: 8,
      rowsPerTable: 12,
    });
    const { storage: secondStorage } = await createSeededCreditLedgerStorage({
      seed: 42,
      shops: 8,
      rowsPerTable: 12,
    });
    const first = await firstStorage.getChanges({
      actor: benchActor,
      syncRules: creditLedgerSyncRules,
      cursor: "",
      deviceId: "equiv-client",
    });
    const second = await secondStorage.getChanges({
      actor: benchActor,
      syncRules: creditLedgerSyncRules,
      cursor: "",
      deviceId: "equiv-client",
    });

    expect(normalizePullResult(first)).toEqual(normalizePullResult(second));
  }, 120_000);
});

async function createSeededCreditLedgerStorage(opts?: {
  seed?: number;
  shops?: number;
  rowsPerTable?: number;
}) {
  const shopCount = opts?.shops ?? BENCH_SHOPS;
  const rowsPerTable = opts?.rowsPerTable ?? BENCH_ROWS_PER_TABLE;
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({
    connectionString: "postgres://unused",
    client: db,
  });

  await db.exec(CREDIT_LEDGER_DDL);
  await storage.provision({
    schema: creditLedgerSchema as Record<string, ContractSchemaSource>,
    syncRules: creditLedgerSyncRules,
  });

  const shopValues: string[] = [];
  const memberValues: string[] = [];
  const customerValues: string[] = [];
  const ledgerValues: string[] = [];
  const reminderValues: string[] = [];

  for (let shopIndex = 0; shopIndex < shopCount; shopIndex += 1) {
    const shopId = `shop-${shopIndex}`;
    shopValues.push(`('${shopId}', 'Shop ${shopIndex}', 'bench-owner')`);
    memberValues.push(`('${shopId}', 'bench-user', 'member')`);

    for (let rowIndex = 0; rowIndex < rowsPerTable; rowIndex += 1) {
      const salt = opts?.seed ?? 0;
      const customerId = `cust-${shopIndex}-${rowIndex}`;
      const entryId = `entry-${shopIndex}-${rowIndex}`;
      const reminderId = `rem-${shopIndex}-${rowIndex}`;
      const updatedAt = `to_timestamp(${(salt + shopIndex * 1_000 + rowIndex) / 1000.0})`;
      customerValues.push(
        `('${customerId}', '${shopId}', 'Customer ${rowIndex}', null, null, null, ${updatedAt})`,
      );
      ledgerValues.push(
        `('${entryId}', '${shopId}', '${customerId}', '10.00', null, null, now(), 'bench-user', null, ${updatedAt})`,
      );
      reminderValues.push(
        `('${reminderId}', '${shopId}', '${customerId}', '${entryId}', now(), 'sms', 'pending', null, now(), ${updatedAt})`,
      );
    }
  }

  await db.exec(`
    insert into shops (id, name, owner_id) values ${shopValues.join(", ")};
    insert into shop_members (shop_id, user_id, role) values ${memberValues.join(", ")};
  `);
  for (const chunk of chunkValues(customerValues, 250)) {
    await db.exec(
      `insert into customers (id, shop_id, name, phone, note, client_id, updated_at) values ${chunk.join(", ")}`,
    );
  }
  for (const chunk of chunkValues(ledgerValues, 250)) {
    await db.exec(
      `insert into ledger_entries (id, shop_id, customer_id, amount, reason, ref, at, created_by, client_id, updated_at) values ${chunk.join(", ")}`,
    );
  }
  for (const chunk of chunkValues(reminderValues, 250)) {
    await db.exec(
      `insert into reminders (id, shop_id, customer_id, entry_id, scheduled_at, channel, status, sent_at, created_at, updated_at) values ${chunk.join(", ")}`,
    );
  }

  return { db, storage };
}

function chunkValues(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizePullResult(result: PullResult) {
  return {
    changed: [...result.changed]
      .map((entry) => ({
        table: entry.table,
        rowIds: entry.rows.map((row) => String(row.id ?? "")).sort(),
      }))
      .sort((left, right) => left.table.localeCompare(right.table)),
    tombstoned: [...result.tombstoned].sort((left, right) =>
      `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`),
    ),
    removed: [...(result.removed ?? [])].sort((left, right) =>
      `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`),
    ),
    removedBuckets: [...(result.removedBuckets ?? [])].sort(),
    hasMore: result.hasMore ?? false,
    cursor: result.cursor,
  };
}
