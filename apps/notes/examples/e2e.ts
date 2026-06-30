// Runnable proof: boots the real server on PGlite, two Nizhal clients, sync convergence.
// Run: pnpm --filter @nizhal/example-notes example:e2e
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createNizhalClient } from "@nizhal/db-collection";
import { bearerTokenAuth, createNizhalServer } from "@nizhal/server";
import { postgresStorage } from "@nizhal/server/adapters";
import { notesMutators } from "../src/mutators.js";
import { NOTES_DDL, notesSchema } from "../src/schema.js";
import { notesSyncRules } from "../src/sync-rules.js";

const SECRET = "dev-secret-please-change";
const PORT = 4520;
const OWNER_ID = "owner-1";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(payload: Record<string, unknown>): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 });
  const s = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

type Pull = { changed: { table: string; rows: Record<string, unknown>[] }[] };

function noteRows(pull: Pull): Record<string, unknown>[] {
  return pull.changed.find((c) => c.table === "notes")?.rows ?? [];
}

function hasNote(pull: Pull, id: string): boolean {
  return noteRows(pull).some((row) => row.id === id);
}

export async function runNotesE2e(): Promise<boolean> {
  let pass = true;
  const ok = (name: string, cond: boolean) => {
    console.log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) pass = false;
  };

  const db = new PGlite();
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  let http: ReturnType<ReturnType<typeof createNizhalServer>["listen"]> | null = null;

  try {
    await db.exec(NOTES_DDL);
    await storage.provision({ schema: notesSchema, syncRules: notesSyncRules });

    const server = createNizhalServer({
      db: "postgres://unused",
      schema: notesSchema,
      mutators: notesMutators,
      syncRules: notesSyncRules,
      auth: bearerTokenAuth({ secret: SECRET }),
      storage,
    });
    http = server.listen(PORT);
    const baseUrl = await baseUrlFor(http);
    console.log(`server listening on ${baseUrl}\n`);

    const token = mint({ userId: "user-1", ownerId: OWNER_ID });
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const buckets = (rule: string) => (rule === "myNotes" ? [OWNER_ID] : []);

    const A = createNizhalClient({ server: baseUrl, auth, bucketsForSyncRule: buckets });
    const B = createNizhalClient({ server: baseUrl, auth, bucketsForSyncRule: buckets });

    await A.push({
      name: "addNote",
      args: { clientId: "note-1", title: "Hello", body: "First note" },
      clientMutationId: "m1",
    });
    ok(
      "device B converges: sees note-1",
      hasNote(await B.pull({ cursor: "", syncRule: "myNotes" }), "note-1"),
    );

    const pending: Parameters<typeof A.push>[0][] = [];
    let online = true;
    const basePush = A.push.bind(A);
    A.push = async (mutation) => {
      if (!online) {
        pending.push(mutation);
        return;
      }
      await basePush(mutation);
    };

    online = false;
    await A.push({
      name: "addNote",
      args: { clientId: "note-offline", title: "Offline", body: "Queued while offline" },
      clientMutationId: "m-offline",
    });
    ok(
      "offline note not visible on B yet",
      !hasNote(await B.pull({ cursor: "", syncRule: "myNotes" }), "note-offline"),
    );

    online = true;
    for (const mutation of pending) await basePush(mutation);
    ok(
      "offline mutation delivered: B converges",
      hasNote(await B.pull({ cursor: "", syncRule: "myNotes" }), "note-offline"),
    );

    await A.push({
      name: "addNote",
      args: { clientId: "note-1", title: "Hello", body: "First note" },
      clientMutationId: "m1",
    });
    const afterReplay = noteRows(await B.pull({ cursor: "", syncRule: "myNotes" }));
    ok(
      "idempotent replay: no duplicate note-1",
      afterReplay.filter((row) => row.id === "note-1").length === 1,
    );

    console.log(`\n${pass ? "NOTES E2E PASSED ✅" : "NOTES E2E FAILED ❌"}`);
    return pass;
  } finally {
    if (http) await closeServer(http);
    await db.close();
  }
}

async function baseUrlFor(
  http: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>,
): Promise<string> {
  if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(http: ReturnType<ReturnType<typeof createNizhalServer>["listen"]>) {
  return new Promise<void>((resolve, reject) => {
    http.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNotesE2e().then(
    (passed) => process.exit(passed ? 0 : 1),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
