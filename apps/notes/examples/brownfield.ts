// Brownfield co-existence proof. Point @nizhal/server at an EXISTING Postgres table that already has
// data and an existing ("vendor") app writing to it directly with raw SQL. provision() additively adds
// change-tracking; the vendor's direct INSERT / UPDATE / DELETE all sync to a Nizhal client WITHOUT any
// change to the vendor code — because the tracking lives in DB triggers, not the app.
// Run: pnpm --filter @nizhal/example-notes example:brownfield
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createNizhalClient } from "@nizhal/db-collection";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { notesMutators } from "../src/mutators.js";
import { NOTES_DDL, notesSchema } from "../src/schema.js";
import { notesSyncRules } from "../src/sync-rules.js";

const SECRET = "brownfield-secret";
const PORT = 4523;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = "owner-1";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(payload: Record<string, unknown>): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 });
  const s = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

type Pull = {
  changed: { table: string; rows: Record<string, unknown>[] }[];
  tombstoned: { table: string; id: string }[];
};
const notesOf = (r: Pull) => r.changed.find((c) => c.table === "notes")?.rows ?? [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = true;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) pass = false;
};

async function main() {
  const db = new PGlite();

  // 1. The EXISTING vendor system: its table + pre-existing data, with NO Nizhal columns yet.
  await db.exec(NOTES_DDL);
  await db.exec(`
    insert into notes (id, owner_id, title, body) values
      ('n1', '${OWNER}', 'Legacy note 1', 'written by the existing app'),
      ('n2', '${OWNER}', 'Legacy note 2', 'also pre-existing');
  `);

  // 2. Point Nizhal at the SAME database. provision() additively adds change-tracking — no drops.
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await storage.provision({ schema: notesSchema, syncRules: notesSyncRules });

  // 3. Additive + non-destructive: legacy rows survive, updated_at is backfilled, triggers exist.
  const after = await db.query<{ id: string; updated_at: string | null }>(
    "select id, updated_at from notes order by id",
  );
  ok("legacy rows intact after provision (2 rows)", after.rows.length === 2);
  ok(
    "updated_at backfilled on pre-existing rows",
    after.rows.every((r) => r.updated_at != null),
  );
  const trig = await db.query<{ n: number }>(
    "select count(*)::int as n from pg_trigger where tgname like '\\_nizhal\\_%'",
  );
  ok("change-tracking triggers installed on the existing table", Number(trig.rows[0]?.n) > 0);

  // 4. Boot Nizhal on the same DB. A client syncs the PRE-EXISTING vendor data.
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: notesSchema,
    mutators: notesMutators,
    syncRules: notesSyncRules,
    auth: bearerTokenAuth({ secret: SECRET }),
    storage,
  });
  const http = server.listen(PORT);
  await delay(400);
  const token = mint({ userId: "user-1", ownerId: OWNER });
  const client = createNizhalClient({
    server: BASE,
    auth: { headers: { authorization: `Bearer ${token}` } },
    bucketsForSyncRule: (r) => (r === "myNotes" ? [OWNER] : []),
  });
  ok(
    "client syncs the PRE-EXISTING legacy rows (2)",
    notesOf((await client.pull({ cursor: "", syncRule: "myNotes" })) as Pull).length === 2,
  );

  // 5. THE point: the vendor app does a DIRECT write (raw SQL, bypassing Nizhal) → client sees it.
  await db.exec(
    `insert into notes (id, owner_id, title, body) values ('n3', '${OWNER}', 'Vendor insert', 'raw SQL, no Nizhal')`,
  );
  ok(
    "direct vendor INSERT syncs to the client",
    notesOf((await client.pull({ cursor: "", syncRule: "myNotes" })) as Pull).some(
      (r) => r.id === "n3",
    ),
  );

  // 6. Direct vendor UPDATE → the before-update trigger bumps updated_at → client sees the edit.
  await db.exec("update notes set title = 'Vendor edited' where id = 'n1'");
  ok(
    "direct vendor UPDATE syncs to the client",
    notesOf((await client.pull({ cursor: "", syncRule: "myNotes" })) as Pull).some(
      (r) => r.id === "n1" && r.title === "Vendor edited",
    ),
  );

  // 7. Direct vendor hard DELETE → the after-delete trigger writes a tombstone → client removes it.
  await db.exec("delete from notes where id = 'n2'");
  const afterDelete = (await client.pull({ cursor: "", syncRule: "myNotes" })) as Pull;
  ok(
    "direct vendor hard DELETE propagates as a tombstone",
    afterDelete.tombstoned.some((t) => t.id === "n2") &&
      !notesOf(afterDelete).some((r) => r.id === "n2"),
  );

  // 8. A Nizhal mutator write lives on the same table, alongside the vendor's writes.
  await client.push({
    name: "addNote",
    args: { clientId: "n4", title: "From Nizhal", body: "via a mutator" },
    clientMutationId: "m1",
  });
  ok(
    "Nizhal mutator write coexists on the same table",
    notesOf((await client.pull({ cursor: "", syncRule: "myNotes" })) as Pull).some(
      (r) => r.id === "n4",
    ),
  );

  http.close?.();
  console.log(`\n${pass ? "BROWNFIELD COEXIST PASSED ✅" : "BROWNFIELD COEXIST FAILED ❌"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
