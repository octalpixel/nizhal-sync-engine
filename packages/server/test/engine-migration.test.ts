import { PGlite } from "@electric-sql/pglite";
import { type SyncRules, defineSyncRules } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { NIZHAL_ENGINE_VERSION, postgresStorage } from "../src/adapters/storage.js";

const openDbs: PGlite[] = [];
afterEach(async () => {
  await Promise.all(openDbs.splice(0).map((db) => db.close()));
});

const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body"),
});

const syncRules: SyncRules = defineSyncRules((b) => ({
  ownerBucket: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

function newDb(): { db: PGlite; storage: ReturnType<typeof postgresStorage> } {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  return { db, storage };
}

async function rows<T = Record<string, unknown>>(db: PGlite, sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}
async function udt(db: PGlite, table: string, column: string): Promise<string | undefined> {
  const r = await rows<{ udt_name: string }>(
    db,
    `select udt_name from information_schema.columns where table_name = '${table}' and column_name = '${column}'`,
  );
  return r[0]?.udt_name;
}
async function stampedVersion(db: PGlite): Promise<string | undefined> {
  const r = await rows<{ value: string }>(db, "select value from _nizhal_meta where key = 'engine_version'");
  return r[0]?.value;
}

// Hand-build a pre-versioning v1 engine: bigint row-version from a global sequence + the unique
// tombstone index — the shape provisioning produced before the xid8 fix.
async function provisionLegacyBigint(db: PGlite): Promise<void> {
  await db.exec(`
    create table notes (id text primary key, owner_id text not null, body text);
    create sequence _nizhal_row_version_seq;
    create function _nizhal_next_row_version() returns bigint language sql
      as $$ select nextval('_nizhal_row_version_seq') $$;
    create table _nizhal_tombstones (
      table_name text not null, row_id text not null, client_key text not null, bucket_key text not null,
      kind text not null default 'tombstone',
      row_version bigint not null default _nizhal_next_row_version(),
      deleted_at timestamptz not null default now(),
      primary key (table_name, row_id, bucket_key, row_version)
    );
    create unique index _nizhal_tombstones_row_version_key on _nizhal_tombstones (row_version);
    create table _nizhal_audit_log (
      row_version bigint primary key default _nizhal_next_row_version(),
      client_mutation_id text not null, mutation_name text not null, args jsonb not null,
      actor jsonb not null, client_id text, mutation_id bigint, hlc text,
      affected_buckets jsonb not null, created_at timestamptz not null default now()
    );
    alter table notes add column _nizhal_row_version bigint not null default _nizhal_next_row_version();
    insert into notes (id, owner_id, body) values ('n1', 'o1', 'first');
    insert into notes (id, owner_id, body) values ('n2', 'o1', 'second');
    insert into _nizhal_tombstones (table_name, row_id, client_key, bucket_key)
      values ('notes', 'gone', 'gone', 'o1');
  `);
}

describe("engine schema versioning + migration", () => {
  it("fresh provision creates the xid8 engine and stamps the current version", async () => {
    const { db, storage } = newDb();
    await db.exec("create table notes (id text primary key, owner_id text not null, body text)");
    await storage.provision({ schema: { notes }, syncRules });

    expect(await stampedVersion(db)).toBe(String(NIZHAL_ENGINE_VERSION));
    expect(await udt(db, "_nizhal_tombstones", "row_version")).toBe("xid8");
    expect(await udt(db, "notes", "_nizhal_row_version")).toBe("xid8");
  });

  it("re-provisioning an already-current database is idempotent", async () => {
    const { db, storage } = newDb();
    await db.exec("create table notes (id text primary key, owner_id text not null, body text)");
    await storage.provision({ schema: { notes }, syncRules });
    await storage.provision({ schema: { notes }, syncRules }); // must not throw
    expect(await stampedVersion(db)).toBe(String(NIZHAL_ENGINE_VERSION));
  });

  it("migrates a legacy bigint engine to xid8 in place, preserving rows and their order", async () => {
    const { db, storage } = newDb();
    await provisionLegacyBigint(db);
    // sanity: it really is a v1 bigint engine before migrate
    expect(await udt(db, "_nizhal_tombstones", "row_version")).toBe("int8");

    await storage.provision({ schema: { notes }, syncRules });

    // columns are now xid8, stamped v2
    expect(await stampedVersion(db)).toBe("2");
    expect(await udt(db, "notes", "_nizhal_row_version")).toBe("xid8");
    expect(await udt(db, "_nizhal_tombstones", "row_version")).toBe("xid8");
    expect(await udt(db, "_nizhal_audit_log", "row_version")).toBe("xid8");

    // no data loss + order preserved: the bigint sequence values (1,2,3) survive the numeric cast
    const preserved = await rows<{ id: string; body: string; rv: string }>(
      db,
      "select id, body, _nizhal_row_version::text as rv from notes order by _nizhal_row_version::text::bigint",
    );
    expect(preserved.map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(preserved.map((r) => r.rv)).toEqual(["1", "2"]);
    const tomb = await rows<{ rv: string }>(db, "select row_version::text as rv from _nizhal_tombstones");
    expect(tomb[0]?.rv).toBe("3");

    // the old sequence + unique index are gone; the non-unique index exists
    const seq = await rows<{ present: boolean }>(db, "select to_regclass('_nizhal_row_version_seq') is not null as present");
    expect(seq[0]?.present).toBe(false);
    const uniq = await rows<{ present: boolean }>(db, "select to_regclass('_nizhal_tombstones_row_version_key') is not null as present");
    expect(uniq[0]?.present).toBe(false);

    // new writes now allocate a real transaction id, strictly above every migrated (small) version
    await db.exec("insert into notes (id, owner_id, body) values ('n3', 'o1', 'third')");
    const fresh = await rows<{ rv: string }>(db, "select _nizhal_row_version::text as rv from notes where id = 'n3'");
    expect(BigInt(fresh[0]?.rv ?? "0")).toBeGreaterThan(3n);
  });

  it("refuses to run against a database stamped at a newer engine version", async () => {
    const { db, storage } = newDb();
    await db.exec("create table notes (id text primary key, owner_id text not null, body text)");
    await storage.provision({ schema: { notes }, syncRules });
    await db.exec("update _nizhal_meta set value = '99' where key = 'engine_version'");
    await expect(storage.provision({ schema: { notes }, syncRules })).rejects.toThrow(/newer than this server/);
  });

  it("reset drops the engine, keeps business rows, and reprovisions at the current version", async () => {
    const { db, storage } = newDb();
    await db.exec("create table notes (id text primary key, owner_id text not null, body text)");
    await storage.provision({ schema: { notes }, syncRules });
    await db.exec("insert into notes (id, owner_id, body) values ('keep', 'o1', 'survives reset')");

    if (!storage.reset) throw new Error("reset not implemented");
    await storage.reset({ schema: { notes }, syncRules });

    expect(await stampedVersion(db)).toBe(String(NIZHAL_ENGINE_VERSION));
    expect(await udt(db, "notes", "_nizhal_row_version")).toBe("xid8");
    const kept = await rows<{ id: string; body: string }>(db, "select id, body from notes");
    expect(kept).toEqual([{ id: "keep", body: "survives reset" }]);
    const tombCount = await rows<{ n: number }>(db, "select count(*)::int as n from _nizhal_tombstones");
    expect(tombCount[0]?.n).toBe(0);
  });
});
