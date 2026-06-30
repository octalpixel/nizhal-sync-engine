import { PGlite } from "@electric-sql/pglite";
import { defineMutator, defineMutators, defineSyncRules } from "@nizhal/kernel";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type AuditEntry, postgresStorage } from "../src/adapters/storage.js";
import { type NizhalAuth, createNizhalServer } from "../src/index.js";

const notes = pgTable("audit_notes", {
  id: text("id").primaryKey(),
  owner_id: text("owner_id").notNull(),
  body: text("body").notNull(),
});

const syncRules = defineSyncRules((b) => ({
  notes: b.bucket({
    parameters: () => b.params({ ownerId: "owner_id" }),
    data: (bucket) => [b.table("audit_notes").where(b.eq("owner_id", bucket.ownerId))],
  }),
}));

const auth: NizhalAuth = {
  async resolve(req) {
    const userId = req.headers.get("x-user-id") ?? "user-1";
    const ownerId = req.headers.get("x-owner-id") ?? "owner-1";
    return { userId, ownerId };
  },
};

const openDbs: PGlite[] = [];
const originalAdminPassword = process.env.NIZHAL_ADMIN_PASSWORD;

afterEach(() => {
  process.env.NIZHAL_ADMIN_PASSWORD = originalAdminPassword;
});

afterAll(async () => {
  await Promise.all(openDbs.map((db) => db.close()));
});

describe("RFC-008 audit log", () => {
  it("rolls the audit row back when a mutator fails", async () => {
    const { db, server, storage } = await setup(true);
    const response = await push(server.app, mutation("failAfterWrite", "failed", 1));

    expect(response.status).toBe(422);
    expect(await storage.getAuditLog?.({ limit: 10 })).toEqual([]);
    const rows = await db.query("select id from audit_notes");
    expect(rows.rows).toEqual([]);
  });

  it("appends one immutable row per applied mutation in total row-version order", async () => {
    const { server, storage } = await setup(true);
    for (let id = 1; id <= 3; id += 1) {
      const response = await push(server.app, mutation("addNote", `note-${id}`, id));
      await expectOk(response);
    }
    await push(server.app, mutation("addNote", "note-2", 2));

    const entries = await storage.getAuditLog?.({ limit: 10 });
    expect(entries).toHaveLength(3);
    expect(entries?.map((entry) => entry.clientMutationId)).toEqual(["cmid-1", "cmid-2", "cmid-3"]);
    expect(entries?.map((entry) => BigInt(entry.rowVersion))).toEqual(
      [...(entries ?? [])]
        .map((entry) => BigInt(entry.rowVersion))
        .sort((a, b) => (a < b ? -1 : 1)),
    );
    expect(entries?.[0]).toMatchObject({
      mutationName: "addNote",
      args: { id: "note-1", body: "body-note-1" },
      actor: { userId: "user-1", ownerId: "owner-1" },
      clientId: "client-1",
      mutationId: 1,
      affectedBuckets: ["owner-1"],
    });
  });

  it("filters by actor, bucket, and exclusive/inclusive version range", async () => {
    const { server, storage } = await setup(true);
    await push(server.app, mutation("addNote", "owner-1-note", 1));
    await push(server.app, mutation("addNote", "owner-2-note", 1, "client-2"), {
      "x-owner-id": "owner-2",
      "x-user-id": "user-2",
    });
    await push(server.app, mutation("addNote", "owner-1-note-2", 2));
    const all = (await storage.getAuditLog?.({ limit: 10 })) ?? [];

    expect(await ids(storage.getAuditLog?.({ actor: { userId: "user-2" }, limit: 10 }))).toEqual([
      "cmid-client-2-1",
    ]);
    expect(await ids(storage.getAuditLog?.({ buckets: ["owner-1"], limit: 10 }))).toEqual([
      "cmid-1",
      "cmid-2",
    ]);
    expect(
      await ids(
        storage.getAuditLog?.({
          sinceVersion: all[0]?.rowVersion,
          untilVersion: all[1]?.rowVersion,
          limit: 10,
        }),
      ),
    ).toEqual(["cmid-client-2-1"]);
  });

  it("does not provision or write the audit table when audit is off", async () => {
    const { db, server } = await setup(false);
    const before = await db.query<{ table_name: string | null }>(
      "select to_regclass('_nizhal_audit_log')::text as table_name",
    );
    expect(before.rows[0]?.table_name).toBeNull();

    await expectOk(await push(server.app, mutation("addNote", "no-audit", 1)));
    const after = await db.query<{ table_name: string | null }>(
      "select to_regclass('_nizhal_audit_log')::text as table_name",
    );
    expect(after.rows[0]?.table_name).toBeNull();
  });

  it("provisions and writes the audit log by default when audit is unset (opt-out, not opt-in)", async () => {
    const db = new PGlite();
    openDbs.push(db);
    const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
    await db.exec(
      "create table audit_notes (id text primary key, owner_id text not null, body text not null)",
    );
    await storage.provision({ schema: { audit_notes: notes }, syncRules }); // audit omitted → default ON
    const table = await db.query<{ table_name: string | null }>(
      "select to_regclass('_nizhal_audit_log')::text as table_name",
    );
    expect(table.rows[0]?.table_name).not.toBeNull();
  });

  it("admin-gates GET /nizhal/audit and returns filtered entries", async () => {
    process.env.NIZHAL_ADMIN_PASSWORD = "audit-admin";
    const { server } = await setup(true);
    await push(server.app, mutation("addNote", "endpoint-note", 1));

    expect((await server.app.request("/nizhal/audit")).status).toBe(401);
    const response = await server.app.request("/nizhal/audit?bucket=owner-1&limit=10", {
      headers: { authorization: "Bearer audit-admin" },
    });
    expect(response.status).toBe(200);
    const entries = (await response.json()) as AuditEntry[];
    expect(entries.map((entry) => entry.clientMutationId)).toEqual(["cmid-1"]);
  });
});

async function setup(audit: boolean) {
  const db = new PGlite();
  openDbs.push(db);
  const storage = postgresStorage({ connectionString: "postgres://unused", client: db });
  await db.exec(
    "create table audit_notes (id text primary key, owner_id text not null, body text not null)",
  );
  await storage.provision({ schema: { audit_notes: notes }, syncRules, audit });
  const mutators = defineMutators({
    addNote: defineMutator({ parse: parseNote }, async ({ tx, actor }, input) => {
      await tx.insert(notes).values({ ...input, owner_id: actor.ownerId });
      return { affectedBuckets: [actor.ownerId] };
    }),
    failAfterWrite: defineMutator({ parse: parseNote }, async ({ tx, actor }, input) => {
      await tx.insert(notes).values({ ...input, owner_id: actor.ownerId });
      throw new Error("audit rollback probe");
    }),
  });
  const server = createNizhalServer({
    db: "postgres://unused",
    schema: { audit_notes: notes },
    mutators,
    syncRules,
    auth,
    storage,
    audit,
  });
  return { db, server, storage };
}

function parseNote(input: unknown): { id: string; body: string } {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { id?: unknown }).id === "string" &&
    typeof (input as { body?: unknown }).body === "string"
  ) {
    return input as { id: string; body: string };
  }
  throw new Error("invalid note");
}

function mutation(name: string, id: string, mutationID: number, clientID = "client-1") {
  return {
    name,
    args: { id, body: `body-${id}` },
    clientID,
    mutationID,
    clientMutationId:
      clientID === "client-1" ? `cmid-${mutationID}` : `cmid-${clientID}-${mutationID}`,
  };
}

async function push(
  app: { request: (path: string, init: RequestInit) => Promise<Response> },
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ mutations: [body] }),
  });
}

async function ids(entries: Promise<AuditEntry[]> | undefined): Promise<string[]> {
  return (await entries)?.map((entry) => entry.clientMutationId) ?? [];
}

async function expectOk(response: Response): Promise<void> {
  const body = await response.text();
  if (response.status !== 200)
    throw new Error(`expected 200, received ${response.status}: ${body}`);
}
