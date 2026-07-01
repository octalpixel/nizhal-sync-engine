// Runtime validation of the static bug-hunt findings against the REAL Nizhal client+server over PGlite
// (zero external infra). Each scenario is an executable repro with a hard assertion.
//   G1 — gaining access to a channel that already has history → the history is NOT backfilled.
//   B1 — a realtime publish failure after commit → the write is durable but never broadcast live.
// Run: cd playground/chat-nizhal && pnpm exec tsx examples/bug-repro.ts
import { PGlite } from "@electric-sql/pglite";
import { issueBearerToken } from "@nizhal/server";
import { inProcessRealtime, postgresStorage } from "@nizhal/server/adapters";
import type { RealtimeAdapter } from "@nizhal/server/adapters";
import postgres from "postgres";
import { createChatClient } from "../src/client.js";
import { CHAT_DDL, chatSchema, chatSyncRules } from "../src/domain.js";
import { createChatServer } from "../src/server.js";

// DB-pluggable: real hosted Postgres (Neon) when DATABASE_URL is set, else in-process PGlite.
// Real Postgres exercises true concurrency / FOR-UPDATE / LISTEN-NOTIFY that PGlite (single serialized
// in-process connection) cannot — so the concurrency-sensitive findings can only be trusted here.
// SAFETY: each scenario DROPs+recreates the chat tables, so DATABASE_URL must be a DEDICATED chat DB.
const USING_REAL_PG = !!process.env.DATABASE_URL;

interface TestDb {
  exec(textSql: string): Promise<unknown>;
  query<T>(textSql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
  storage: ReturnType<typeof postgresStorage>;
}

async function openDb(): Promise<TestDb> {
  if (USING_REAL_PG) {
    const url = process.env.DATABASE_URL as string;
    const sql = postgres(url, { max: 8, onnotice: () => {} });
    return {
      exec: (textSql) => sql.unsafe(textSql),
      query: async <T>(textSql: string, params: unknown[] = []) => ({
        rows: (await sql.unsafe(textSql, params as never)) as unknown as T[],
      }),
      close: async () => {
        await sql.end({ timeout: 5 });
      },
      storage: postgresStorage({ connectionString: url }),
    };
  }
  const db = new PGlite();
  return {
    exec: (textSql) => db.exec(textSql),
    query: <T>(textSql: string, params: unknown[] = []) =>
      db.query<T>(textSql, params) as Promise<{ rows: T[] }>,
    close: () => db.close(),
    storage: postgresStorage({ connectionString: "postgres://unused", client: db }),
  };
}

async function provisionChat(db: TestDb): Promise<void> {
  // Idempotent on a dedicated chat DB: drop business tables, recreate, then layer the engine.
  await db.exec("drop table if exists reactions, messages, channel_members, channels cascade");
  await db.exec(CHAT_DDL);
  await db.storage.provision({ schema: chatSchema, syncRules: chatSyncRules });
}

const SECRET = "bug-repro-secret";
const WS = "ws-1";
const A = "user-a";
const B = "user-b";
const CH_X = "channel-x"; // B is a member from the start (advances B's channel cursor)
const CH_Y = "channel-y"; // B joins LATER; it already holds history

function realtimeSource(realtime: RealtimeAdapter) {
  return {
    subscribe: (buckets: string[], onMessage: (m: string) => void) =>
      realtime.subscribe(buckets, { send: onMessage }),
  };
}

async function pullChannel(device: Awaited<ReturnType<typeof createChatClient>>) {
  // Deterministic pull+apply of the "channel" sync rule with the device's current channelIds.
  await device.echo.pull({ cursor: device.echo.getCursor("channel"), syncRule: "channel" });
}

function channelMessages(
  device: Awaited<ReturnType<typeof createChatClient>>,
  channelId: string,
): string[] {
  return device.messages.toArray
    .filter((m) => m.channel_id === channelId && m.deleted_at == null)
    .map((m) => m.id)
    .sort();
}

// ───────────────────────────── G1 ─────────────────────────────
async function reproG1(): Promise<boolean> {
  console.log("\n=== G1: join a channel with existing history → backfill? ===");
  const db = await openDb();
  const storage = db.storage;
  const realtime = inProcessRealtime();
  await provisionChat(db);
  const server = createChatServer({ db: process.env.DATABASE_URL ?? "postgres://unused", secret: SECRET, storage, realtime });
  const listener = server.listen(0);
  await new Promise<void>((r) => listener.once("listening", () => r()));
  const port = (listener.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const src = realtimeSource(realtime);
  const tokenA = issueBearerToken({ secret: SECRET, userId: A, ownerId: WS });
  const tokenB = issueBearerToken({ secret: SECRET, userId: B, ownerId: WS });

  // A owns both channels (so A may post to both); B starts a member of X only.
  const admin = await createChatClient({
    server: baseUrl, token: tokenA, userId: A, workspaceId: WS, channelIds: [CH_X, CH_Y], subscribeSource: src,
  });
  admin.mutate.createChannel({ id: CH_X, workspaceId: WS, name: "x" });
  admin.mutate.createChannel({ id: CH_Y, workspaceId: WS, name: "y" });
  admin.mutate.joinChannel({ workspaceId: WS, channelId: CH_X, userId: B });
  await admin.waitForIdle();

  // Y already has history (LOW row_versions) — created BEFORE the X message B will pull.
  admin.mutate.sendMessage({ id: "y1", channelId: CH_Y, body: "old history 1" });
  admin.mutate.sendMessage({ id: "y2", channelId: CH_Y, body: "old history 2" });
  await admin.waitForIdle();
  // Then an X message (HIGHER row_version) that B pulls → B's channel cursor advances past y1,y2.
  admin.mutate.sendMessage({ id: "x1", channelId: CH_X, body: "x message" });
  await admin.waitForIdle();

  // B joins with a MUTABLE channelIds array so "joining Y" doesn't reset the cursor.
  const bChannels = [CH_X];
  const deviceB = await createChatClient({
    server: baseUrl, token: tokenB, userId: B, workspaceId: WS, channelIds: bChannels, subscribeSource: src,
  });
  await pullChannel(deviceB); // B (member of X) pulls → gets x1 → cursor now > y1,y2 versions
  const beforeJoin = channelMessages(deviceB, CH_Y);
  console.log(`  B sees in X: [${channelMessages(deviceB, CH_X)}], in Y (not yet joined): [${beforeJoin}]`);

  // ── B JOINS Y (membership added server-side; client adds Y to its synced buckets) ──
  admin.mutate.joinChannel({ workspaceId: WS, channelId: CH_Y, userId: B });
  await admin.waitForIdle();
  bChannels.push(CH_Y);
  await pullChannel(deviceB); // pull with buckets [X,Y], cursor already past y1,y2

  const afterJoin = channelMessages(deviceB, CH_Y);
  console.log(`  After joining Y, B sees history in Y: [${afterJoin}]  (expected: [y1,y2])`);

  // Strengthen: a NEW message in Y (version > cursor) — does the new one arrive while history doesn't?
  admin.mutate.sendMessage({ id: "y3", channelId: CH_Y, body: "new after join" });
  await admin.waitForIdle();
  await pullChannel(deviceB);
  const finalY = channelMessages(deviceB, CH_Y);
  console.log(`  After a NEW Y message, B sees in Y: [${finalY}]  (expected: [y1,y2,y3])`);

  // Ground truth: the server DOES have y1,y2,y3 (so any miss is a sync bug, not missing data).
  const serverY = await db.query<{ id: string }>(
    "select id from messages where channel_id = $1 order by id", [CH_Y],
  );
  console.log(`  Server has in Y: [${serverY.rows.map((r) => r.id).join(",")}]`);

  await Promise.all([admin.dispose(), deviceB.dispose()]);
  listener.close();
  await db.close();

  const historyBackfilled = finalY.includes("y1") && finalY.includes("y2");
  if (historyBackfilled) {
    console.log("  ✅ G1 NOT reproduced — history WAS backfilled on join.");
    return false;
  }
  console.log("  🔴 G1 CONFIRMED — B joined Y, sees the NEW message but NOT the existing history.");
  return true;
}

// ───────────────────────────── B1 ─────────────────────────────
async function reproB1(): Promise<boolean> {
  console.log("\n=== B1: realtime publish throws after commit → live broadcast lost? ===");
  const db = await openDb();
  const storage = db.storage;
  const base = inProcessRealtime();
  // Realtime whose publish THROWS once (a transient Cloudflare DO/bridge failure), then recovers.
  let failNext = false;
  const realtime: RealtimeAdapter = {
    publish(bucket) {
      if (failNext) {
        failNext = false;
        throw new Error("simulated transient realtime publish failure");
      }
      return base.publish(bucket);
    },
    subscribe: (buckets, socket) => base.subscribe(buckets, socket),
  };
  await provisionChat(db);
  const server = createChatServer({ db: process.env.DATABASE_URL ?? "postgres://unused", secret: SECRET, storage, realtime });
  const listener = server.listen(0);
  await new Promise<void>((r) => listener.once("listening", () => r()));
  const port = (listener.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const src = realtimeSource(realtime);
  const tokenA = issueBearerToken({ secret: SECRET, userId: A, ownerId: WS });

  const admin = await createChatClient({
    server: baseUrl, token: tokenA, userId: A, workspaceId: WS, channelIds: [CH_X], subscribeSource: src,
  });
  admin.mutate.createChannel({ id: CH_X, workspaceId: WS, name: "x" });
  admin.mutate.joinChannel({ workspaceId: WS, channelId: CH_X, userId: B });
  await admin.waitForIdle();

  const deviceA = await createChatClient({
    server: baseUrl, token: tokenA, userId: A, workspaceId: WS, channelIds: [CH_X], subscribeSource: src,
  });
  const deviceB = await createChatClient({
    server: baseUrl, token: tokenA, userId: B, workspaceId: WS, channelIds: [CH_X], subscribeSource: src,
  });
  await pullChannel(deviceA);
  await pullChannel(deviceB);

  // The next publish (for this sendMessage) throws AFTER the row commits.
  failNext = true;
  let pushError: unknown = null;
  try {
    deviceA.mutate.sendMessage({ id: "m-fail", channelId: CH_X, body: "publish will throw" });
    await deviceA.waitForIdle();
  } catch (e) {
    pushError = e;
  }
  // Give realtime a beat to (not) deliver.
  await new Promise((r) => setTimeout(r, 300));

  const onServer = await db.query<{ count: number }>(
    "select count(*)::int as count from messages where id = $1", ["m-fail"],
  );
  const committed = (onServer.rows[0]?.count ?? 0) === 1;
  const bGotItLive = deviceB.messages.toArray.some((m) => m.id === "m-fail");
  console.log(`  committed on server: ${committed}; B received it LIVE (no manual pull): ${bGotItLive}; push surfaced error: ${pushError !== null}`);

  // Now prove it's recoverable only by an INDEPENDENT pull (eventual consistency), not the live path.
  await pullChannel(deviceB);
  const bAfterPull = deviceB.messages.toArray.some((m) => m.id === "m-fail");
  console.log(`  B sees it only after an explicit pull: ${bAfterPull}`);

  await Promise.all([admin.dispose(), deviceA.dispose(), deviceB.dispose()]);
  listener.close();
  await db.close();

  if (committed && !bGotItLive) {
    console.log("  🔴 B1 CONFIRMED — write committed but the live broadcast was dropped (recovered only by a later pull).");
    return true;
  }
  console.log("  ✅ B1 NOT reproduced — the live broadcast survived a publish failure.");
  return false;
}

// ───────────────────────────── C1 ─────────────────────────────
async function reproC1(): Promise<boolean> {
  console.log("\n=== C1: a failed post-push reconcile pull freezes the collection cursor? ===");
  const db = await openDb();
  const storage = db.storage;
  const realtime = inProcessRealtime();
  await provisionChat(db);
  const server = createChatServer({ db: process.env.DATABASE_URL ?? "postgres://unused", secret: SECRET, storage, realtime });
  const listener = server.listen(0);
  await new Promise<void>((r) => listener.once("listening", () => r()));
  const port = (listener.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const src = realtimeSource(realtime);
  const tokenA = issueBearerToken({ secret: SECRET, userId: A, ownerId: WS });

  const admin = await createChatClient({
    server: baseUrl, token: tokenA, userId: A, workspaceId: WS, channelIds: [CH_X], subscribeSource: src,
  });
  admin.mutate.createChannel({ id: CH_X, workspaceId: WS, name: "x" });
  admin.mutate.joinChannel({ workspaceId: WS, channelId: CH_X, userId: B });
  await admin.waitForIdle();

  const deviceA = await createChatClient({
    server: baseUrl, token: tokenA, userId: A, workspaceId: WS, channelIds: [CH_X], subscribeSource: src,
  });
  const deviceB = await createChatClient({
    server: baseUrl, token: tokenA, userId: B, workspaceId: WS, channelIds: [CH_X], subscribeSource: src,
  });
  await pullChannel(deviceA);
  await pullChannel(deviceB);

  // Simulate a network blip on the post-push reconcile pull: fail acknowledgeLocalWrite exactly once.
  const realAck = deviceA.echo.acknowledgeLocalWrite?.bind(deviceA.echo);
  let failAckOnce = true;
  deviceA.echo.acknowledgeLocalWrite = async (txId: string) => {
    if (failAckOnce) {
      failAckOnce = false;
      throw new Error("simulated failed reconcile pull (network blip right after push)");
    }
    return realAck?.(txId);
  };

  deviceA.mutate.sendMessage({ id: "a-stuck", channelId: CH_X, body: "my own write, ack pull fails" });
  await deviceA.waitForIdle();
  await new Promise((r) => setTimeout(r, 200));

  // Now drive new authoritative traffic from B and see if A's cursor can still advance.
  const cursorBefore = String(deviceA.echo.getCursor("channel"));
  for (let i = 0; i < 4; i++) {
    deviceB.mutate.sendMessage({ id: `b-${i}`, channelId: CH_X, body: `from B ${i}` });
    await deviceB.waitForIdle();
    await pullChannel(deviceA);
  }
  const cursorAfter = String(deviceA.echo.getCursor("channel"));

  // Control: a fresh, un-blocked device pulls the same channel and its cursor advances normally.
  const control = await createChatClient({
    server: baseUrl, token: tokenA, userId: B, workspaceId: WS, channelIds: [CH_X], subscribeSource: src,
  });
  await pullChannel(control);
  const controlCursor = String(control.echo.getCursor("channel"));

  console.log(`  A cursor before B's traffic: ${cursorBefore}`);
  console.log(`  A cursor after 4 new B messages + 4 pulls: ${cursorAfter}  (frozen if unchanged)`);
  console.log(`  control (un-blocked) cursor: ${controlCursor}  (this is where a healthy cursor lands)`);

  await Promise.all([admin.dispose(), deviceA.dispose(), deviceB.dispose(), control.dispose()]);
  listener.close();
  await db.close();

  const frozen = cursorAfter === cursorBefore && controlCursor !== cursorBefore;
  if (frozen) {
    console.log("  🔴 C1 CONFIRMED — A's collection cursor is frozen after the failed ack; a healthy cursor advanced past it. Every pull now re-fetches from the frozen point (unbounded), and with paging, rows beyond page 1 starve.");
    return true;
  }
  console.log("  ✅ C1 NOT reproduced — A's cursor advanced despite the failed ack.");
  return false;
}

// ───────── CONCURRENCY (real-PG only; PGlite is single serialized connection) ─────────
// Validates idempotency under true concurrency: N concurrent /sync/push with the SAME
// clientMutationId must apply the mutator body EXACTLY once (no double-credit / double-message).
async function reproConcurrency(): Promise<boolean> {
  console.log("\n=== CONCURRENCY: N concurrent duplicate pushes → applied exactly once? ===");
  if (!USING_REAL_PG) {
    console.log("  ⏭  skipped (needs real Postgres — PGlite serializes connections).");
    return false;
  }
  const db = await openDb();
  const storage = db.storage;
  const realtime = inProcessRealtime();
  await provisionChat(db);
  const server = createChatServer({ db: process.env.DATABASE_URL as string, secret: SECRET, storage, realtime });
  const listener = server.listen(0);
  await new Promise<void>((r) => listener.once("listening", () => r()));
  const port = (listener.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tokenA = issueBearerToken({ secret: SECRET, userId: A, ownerId: WS });
  const admin = await createChatClient({
    server: baseUrl, token: tokenA, userId: A, workspaceId: WS, channelIds: [CH_X], subscribeSource: realtimeSource(realtime),
  });
  admin.mutate.createChannel({ id: CH_X, workspaceId: WS, name: "x" });
  await admin.waitForIdle();

  // Fire 12 concurrent identical pushes (same clientMutationId, unsequenced → exercises claimMutation
  // INSERT … ON CONFLICT DO NOTHING under real row-level contention).
  const cmid = "cmid-concurrent-dup";
  const pushBody = JSON.stringify({
    mutations: [{ name: "sendMessage", clientMutationId: cmid, args: { id: "dup-msg", channelId: CH_X, body: "concurrent" } }],
  });
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      fetch(`${baseUrl}/sync/push`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: pushBody,
      }).then(async (r) => ({ status: r.status, body: await r.text() })),
    ),
  );
  const rows = await db.query<{ count: number }>(
    "select count(*)::int as count from messages where id = $1", ["dup-msg"],
  );
  const msgCount = rows.rows[0]?.count ?? -1;
  const serverErrors = responses.filter((r) => r.status >= 500);
  const statuses = responses.map((r) => r.status).sort();
  console.log(`  12 concurrent identical pushes → message rows: ${msgCount} (expected 1)`);
  console.log(`  response statuses: [${statuses.join(",")}]; 5xx (PK-race/crash): ${serverErrors.length}`);

  await admin.dispose();
  listener.close();
  await db.close();

  const exactlyOnce = msgCount === 1 && serverErrors.length === 0;
  if (exactlyOnce) {
    console.log("  ✅ idempotency HOLDS under real concurrency — applied exactly once, no 5xx.");
    return false;
  }
  console.log(`  🔴 CONCURRENCY BUG — ${msgCount} rows and/or ${serverErrors.length} server errors under contention.`);
  return true;
}

async function main() {
  console.log(
    USING_REAL_PG
      ? `▶ Running against REAL hosted Postgres (DATABASE_URL set) — true concurrency fidelity.`
      : `▶ Running against in-process PGlite (set DATABASE_URL=<neon> for real-PG fidelity).`,
  );
  const g1 = await reproG1();
  const b1 = await reproB1();
  const c1 = await reproC1();
  const conc = await reproConcurrency();
  console.log(`\n──────── RESULT (${USING_REAL_PG ? "REAL POSTGRES" : "PGlite"}) ────────`);
  console.log(`G1 (no history backfill on join): ${g1 ? "🔴 CONFIRMED" : "✅ not reproduced"}`);
  console.log(`B1 (live broadcast lost on publish failure): ${b1 ? "🔴 CONFIRMED" : "✅ not reproduced"}`);
  console.log(`C1 (collection cursor frozen by a failed ack pull): ${c1 ? "🔴 CONFIRMED" : "✅ not reproduced"}`);
  console.log(`Concurrency (idempotency under contention): ${conc ? "🔴 BUG" : USING_REAL_PG ? "✅ holds" : "⏭ skipped"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("repro harness error:", e);
  process.exit(1);
});
