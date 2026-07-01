// Deterministic repro of the "version-assignment-order != commit-visibility-order" silent-skip,
// using REAL Postgres + interleaved concurrent transactions (PGlite can't — single connection).
//   1. NAIVE lock-free nextval()  → a reader SKIPS a row that commits out-of-order (the RC).
//   2. SINGLETON FOR UPDATE (current Nizhal) → safe (and why it serializes all writes).
//   3. FIX: order by COMMIT timestamp (track_commit_timestamp) → lock-free AND safe.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const sql = postgres(url, { max: 8, onnotice: () => {} });

const ids = (rows) => rows.map((r) => r.id).join(",");

// ───────────────────────── 1. NAIVE lock-free nextval → SKIP ─────────────────────────
async function demoSkip() {
  await sql.unsafe(`
    drop table if exists events cascade; drop sequence if exists ver_seq;
    create sequence ver_seq;
    create table events (id text primary key, ver bigint not null default nextval('ver_seq'));
  `);
  const a = await sql.reserve();
  const b = await sql.reserve();
  const r = await sql.reserve();
  try {
    // tx A assigns a LOW version, holds the transaction open (not yet committed).
    await a.unsafe("begin");
    await a.unsafe("insert into events (id) values ('A')");
    const aVer = (await a.unsafe("select ver from events where id='A'"))[0].ver;
    // tx B assigns a HIGHER version and commits FIRST.
    await b.unsafe("begin");
    await b.unsafe("insert into events (id) values ('B')");
    const bVer = (await b.unsafe("select ver from events where id='B'"))[0].ver;
    await b.unsafe("commit");

    // reader pulls `ver > cursor`; only B is committed/visible. Cursor advances past A's version.
    let cursor = 0n;
    let page = await r.unsafe(`select id, ver from events where ver > ${cursor} order by ver`);
    for (const row of page) cursor = BigInt(row.ver) > cursor ? BigInt(row.ver) : cursor;
    console.log(`  A.ver=${aVer} (uncommitted), B.ver=${bVer} (committed first)`);
    console.log(`  reader pull#1 (cursor 0): saw [${ids(page)}], cursor → ${cursor}`);

    // NOW A commits — its LOWER version becomes visible, but the reader already moved past it.
    await a.unsafe("commit");
    page = await r.unsafe(`select id, ver from events where ver > ${cursor} order by ver`);
    console.log(`  reader pull#2 (cursor ${cursor}): saw [${ids(page) || "<nothing>"}]`);

    const skipped = !page.some((row) => row.id === "A");
    console.log(skipped ? "  🔴 SILENT SKIP: row A is committed but the reader will NEVER see it.\n" : "  ✅ no skip\n");
    return skipped;
  } finally {
    a.release(); b.release(); r.release();
  }
}

// ───────────────────────── 2. SINGLETON FOR UPDATE → safe (the lock) ─────────────────────────
async function demoSingletonSafe() {
  await sql.unsafe(`
    drop table if exists events2 cascade; drop sequence if exists ver_seq2; drop table if exists sync_control cascade;
    create sequence ver_seq2;
    create table sync_control (id bool primary key default true);
    insert into sync_control (id) values (true);
    create or replace function next_ver() returns bigint language plpgsql as $$
      begin perform 1 from sync_control where id = true for update; return nextval('ver_seq2'); end $$;
    create table events2 (id text primary key, ver bigint not null default next_ver());
  `);
  const a = await sql.reserve();
  const b = await sql.reserve();
  try {
    await a.unsafe("begin");
    await a.unsafe("insert into events2 (id) values ('A')"); // takes the singleton lock
    // B tries to insert — it BLOCKS on the singleton FOR UPDATE until A commits.
    await b.unsafe("begin");
    const bInsert = b.unsafe("insert into events2 (id) values ('B')");
    const raced = await Promise.race([
      bInsert.then(() => "b-proceeded"),
      new Promise((res) => setTimeout(() => res("b-blocked-on-lock"), 400)),
    ]);
    console.log(`  while A holds the lock, B is: ${raced}`);
    await a.unsafe("commit"); // releases the singleton lock
    await bInsert; await b.unsafe("commit");
    const rows = await sql.unsafe("select id, ver from events2 order by ver");
    console.log(`  final order by ver: [${ids(rows)}] — assignment order == commit order (serialized)`);
    console.log("  ✅ safe — but EVERY write serialized behind one lock (the throughput bottleneck)\n");
    return raced === "b-blocked-on-lock";
  } finally {
    a.release(); b.release();
  }
}

// ───────────────────────── 3. FIX: order by COMMIT timestamp (lock-free + safe) ─────────────────────────
async function demoCommitTsFix() {
  await sql.unsafe(`
    drop table if exists events3 cascade; drop sequence if exists ver_seq3;
    create sequence ver_seq3;
    create table events3 (id text primary key, ver bigint not null default nextval('ver_seq3'));
  `);
  const a = await sql.reserve();
  const b = await sql.reserve();
  const r = await sql.reserve();
  try {
    // Same out-of-order interleave as demo 1, but the cursor is a COMMIT timestamp, not the assigned ver.
    await a.unsafe("begin");
    await a.unsafe("insert into events3 (id) values ('A')");
    await b.unsafe("begin");
    await b.unsafe("insert into events3 (id) values ('B')");
    await b.unsafe("commit");

    // commit-ts cursor: rows where commit_ts > cursor, ordered by commit_ts. (xmin → commit timestamp.)
    const ctsSql = `select id, pg_xact_commit_timestamp(xmin) as cts from events3
                    where pg_xact_commit_timestamp(xmin) is not null`;
    let page = (await r.unsafe(ctsSql)).filter((row) => row.cts !== null).sort((x, y) => (x.cts < y.cts ? -1 : 1));
    let cursor = page.length ? page[page.length - 1].cts : new Date(0);
    console.log(`  reader pull#1 (commit-ts): saw [${ids(page)}], cursor → ${cursor.toISOString?.() ?? cursor}`);

    await a.unsafe("commit"); // A commits LATER → gets a LATER commit timestamp
    page = (await r.unsafe(`${ctsSql} and pg_xact_commit_timestamp(xmin) > '${cursor.toISOString?.() ?? cursor}'`))
      .sort((x, y) => (x.cts < y.cts ? -1 : 1));
    console.log(`  reader pull#2 (cursor advanced): saw [${ids(page) || "<nothing>"}]`);
    const recovered = page.some((row) => row.id === "A");
    console.log(recovered ? "  ✅ FIX WORKS: A is delivered after its (later) commit — no skip, no global lock.\n" : "  🔴 still skipped\n");
    return recovered;
  } finally {
    a.release(); b.release(); r.release();
  }
}

// ─────────── 4. RECOMMENDED FIX: write-time xid8 + reader advances only to snapshot xmin ───────────
async function demoXidHorizon() {
  await sql.unsafe(`
    drop table if exists events4 cascade;
    create table events4 (id text primary key, _seq xid8 not null default pg_current_xact_id());
  `);
  const a = await sql.reserve();
  const b = await sql.reserve();
  const r = await sql.reserve();
  try {
    await a.unsafe("begin");
    await a.unsafe("insert into events4 (id) values ('A')"); // low xid, held open
    await b.unsafe("begin");
    await b.unsafe("insert into events4 (id) values ('B')"); // higher xid
    await b.unsafe("commit");

    let cursor = "0";
    let horizon = (await r.unsafe("select pg_snapshot_xmin(pg_current_snapshot())::text h"))[0].h;
    let page = await r.unsafe(
      `select id from events4 where _seq >= '${cursor}'::xid8 and _seq < '${horizon}'::xid8 order by _seq, id`,
    );
    console.log(
      `  pull#1: horizon=${horizon}, saw [${ids(page) || "<nothing>"}] — B HELD (its txn sits above the horizon while A is in-flight)`,
    );
    cursor = horizon;

    await a.unsafe("commit"); // A commits → horizon advances past BOTH
    horizon = (await r.unsafe("select pg_snapshot_xmin(pg_current_snapshot())::text h"))[0].h;
    page = await r.unsafe(
      `select id from events4 where _seq >= '${cursor}'::xid8 and _seq < '${horizon}'::xid8 order by _seq, id`,
    );
    console.log(`  pull#2: horizon=${horizon}, saw [${ids(page) || "<nothing>"}] — both delivered in commit order, none skipped`);
    const bothSeen = page.some((x) => x.id === "A") && page.some((x) => x.id === "B");
    console.log(bothSeen ? "  ✅ RECOMMENDED FIX: lock-free (writers never blocked) AND no skip; a long txn only stalls the reader's advance.\n" : "  🔴 skip/order wrong\n");
    return bothSeen;
  } finally {
    a.release(); b.release(); r.release();
  }
}

console.log("=== 1. NAIVE lock-free nextval() (the RC) ===");
const skip = await demoSkip();
console.log("=== 2. SINGLETON FOR UPDATE (current Nizhal) ===");
const safe = await demoSingletonSafe();
console.log("=== 3. order by commit timestamp (lock-free, but weak) ===");
const fixed = await demoCommitTsFix();
console.log("=== 4. RECOMMENDED: write-time xid8 + reader-side snapshot-xmin horizon ===");
const horizonFix = await demoXidHorizon();
console.log("──────── RESULT ────────");
console.log(`naive nextval silently skips a row:           ${skip ? "🔴 CONFIRMED (the RC)" : "not reproduced"}`);
console.log(`singleton FOR UPDATE prevents skip (locks):   ${safe ? "✅ safe but serializes ALL writes" : "?"}`);
console.log(`commit-timestamp cursor: lock-free + safe:    ${fixed ? "✅ works (but non-unique/unindexable)" : "🔴 no"}`);
console.log(`xid8 + snapshot-xmin horizon (RECOMMENDED):   ${horizonFix ? "✅ lock-free AND exact, stock Postgres" : "🔴 no"}`);
await sql.end({ timeout: 5 });
process.exit(0);
